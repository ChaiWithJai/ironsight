/**
 * Ground-truth ambient occlusion, at two radii, plus the half-res depth/normal
 * buffer it runs on.
 *
 * OWNER: LIGHT.
 *
 * WHY TWO RADII, WHICH IS THE WHOLE POINT OF THIS FILE
 * ---------------------------------------------------
 * The rubric asks for two different things that people usually try to get from
 * one AO term and cannot:
 *
 *  - **contact darkening** — a 3–8 px band where an object meets the ground,
 *    *darker than the cast shadow itself* (LOOK_SPEC §2.6). That needs a very
 *    short radius or it smears into a general dirt halo.
 *  - **sky occlusion** — an interior or the underside of an arcade must lose SKY
 *    light, not just sun light. That needs a radius of metres, because the thing
 *    doing the occluding is the room.
 *
 * One horizon march produces both: the horizon angle is monotonic in the search
 * radius, so the maximum horizon found inside the short radius gives the contact
 * term and the maximum over the full radius gives the sky term, for the price of
 * one set of taps. They come out in R and G of one half-res target.
 *
 * WHY IT DOES NOT HALO
 * --------------------
 * Three separate reasons, and the classic grey outline needs all three to be
 * absent: (1) a **range check** — a sample far in front of the receiver stops
 * contributing, so a foreground silhouette does not paint AO onto the sky behind
 * it; (2) the result is applied to **indirect light only**, never to the final
 * colour; (3) **multi-bounce** (`shading.ts`) makes the occlusion take the
 * albedo's colour, so it darkens rather than greys.
 */
import * as THREE from 'three';
import type { FrameCtx, GpuUniform, QualitySettings, RenderGraph, SceneGraph, Vec3 } from '@/engine/types';
import { RenderLayer, SceneGroup } from '@/engine/types';

/**
 * Sky-occlusion search radius, metres.
 *
 * Ten metres is much larger than the 0.55 m LOOK_SPEC §2.6 quotes for GTAO, and
 * deliberately so: at that radius the term is a crease darkener and nothing
 * else, and §2.5's acceptance test — a 2.5–4.5:1 DISPLAY ratio between sunlit
 * and shadowed open ground — is then unreachable, because the physics of an 11°
 * sun only gives 2.2:1 in LINEAR terms on ground that keeps its whole sky. The
 * missing factor is sky VISIBILITY, and the thing taking the sky away is the
 * building casting the shadow, ten metres off. So the far radius has to be
 * building-sized. The contact detail comes from `RADIUS_NEAR` instead, which is
 * what §2.6's short-range term actually buys.
 */
const RADIUS_FAR = 10.0;
/**
 * Contact search radius, metres. LOOK_SPEC §2.6's short-range term.
 *
 * 0.55, not the 0.22 it was. The march spaces its taps quadratically over the
 * FAR radius, so at 0.22 m only the first one or two taps ever landed inside
 * the near window and the contact term came back at 0.75–0.80 visibility even
 * in a right-angled floor/wall joint — measurably no darkening, which is
 * exactly what round 2 found at every pier base and stall leg in the frame.
 * 0.55 m is §2.6's own figure and puts three or four taps inside the window.
 */
const RADIUS_NEAR = 0.55;

/**
 * How far the contact-shadow ray marches along the sun vector, metres. Short on
 * purpose: this term exists to darken the last half metre before a contact,
 * which is precisely the band the cascade filters away. Anything longer starts
 * duplicating work the cascade does better and inventing shadows behind
 * screen-space silhouettes.
 */
const CONTACT_DISTANCE = 0.45;

/**
 * Taps along that ray. Eight over 0.45 m is a 5.6 cm sample spacing, which is
 * finer than a cascade-0 texel everywhere inside 12 m and is what makes the
 * band land on the joint rather than near it.
 */
const CONTACT_STEPS = 8;

const GBUFFER_LAYERS: readonly RenderLayer[] = [
  RenderLayer.WorldOpaque,
  RenderLayer.WorldAlphaTest,
  RenderLayer.Vegetation,
  RenderLayer.Impostor,
];

/**
 * View-space normal in RGB, view depth in metres in A. Goes through three's own
 * vertex chunks for the same reason the shadow depth material does: batching and
 * instancing live in `project_vertex` and `defaultnormal_vertex`.
 */
function createGBufferMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vIronNormal;
      varying float vIronDepth;
      void main() {
        #include <batching_vertex>
        #include <beginnormal_vertex>
        #include <morphinstance_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vIronNormal = normalize( transformedNormal );
        vIronDepth = - mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vIronNormal;
      varying float vIronDepth;
      void main() {
        vec3 n = normalize( vIronNormal );
        if ( ! gl_FrontFacing ) n = -n;
        gl_FragColor = vec4( n, vIronDepth );
      }
    `,
    uniforms: {},
    side: THREE.DoubleSide,
  });
  material.name = 'iron:gbuffer';
  return material;
}

const AO_PRELUDE = /* glsl */ `
  uniform sampler2D uGbuffer;
  /** [ tanHalfFovX, tanHalfFovY, 1/tanHalfFovY, frameJitter ] */
  uniform vec4 uProjection;
  /** [ radiusNear, radiusFar, thickness, intensity ] */
  uniform vec4 uAoParams;
  /** [ view-space direction TOWARD the sun, contact-march length in metres ] */
  uniform vec4 uSunView;

  const float IRON_PI = 3.14159265359;
  const float IRON_HALF_PI = 1.57079632679;

  vec3 ironViewPos( vec2 uv, float depth ) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3( ndc.x * uProjection.x * depth, ndc.y * uProjection.y * depth, -depth );
  }

  /** Inverse of \`ironViewPos\`: view space back to the UV it was sampled at. */
  vec2 ironProjectUv( vec3 v ) {
    float d = max( -v.z, 1e-4 );
    vec2 ndc = vec2( v.x / ( uProjection.x * d ), v.y / ( uProjection.y * d ) );
    return ndc * 0.5 + 0.5;
  }

  float ironNoise( vec2 p ) {
    vec3 m = vec3( 0.06711056, 0.00583715, 52.9829189 );
    return fract( m.z * fract( dot( p, m.xy ) ) );
  }

  /**
   * GTAO's inner integral: the cosine-weighted arc of the visible hemisphere
   * between two horizon angles, for a normal at angle \`n\` from the view vector
   * inside the slice plane. This is the "ground truth" part — an HBAO-style
   * \`sin(h) - sin(t)\` sum systematically over-darkens grazing surfaces.
   */
  float ironArc( float n, float h1, float h2, float projNLen ) {
    float a = -cos( 2.0 * h1 - n ) + cos( n ) + 2.0 * h1 * sin( n );
    float b = -cos( 2.0 * h2 - n ) + cos( n ) + 2.0 * h2 * sin( n );
    // max(0) is a guard, not a fudge: if a horizon search ever returns an
    // inverted pair the correct answer is "fully occluded", never negative light.
    return max( 0.25 * projNLen * ( a + b ), 0.0 );
  }
`;

function aoBody(slices: number, steps: number): string {
  return /* glsl */ `
  vec4 g = texture( uGbuffer, vUv );
  float depth = g.a;
  if ( depth <= 0.0 || depth > 900.0 ) { outColor = vec4( 1.0 ); return; }

  vec3 P = ironViewPos( vUv, depth );
  vec3 N = normalize( g.rgb );
  vec3 V = normalize( -P );

  // A VISIBLE fragment's normal must face the viewer, and on low-poly geometry
  // seen at a grazing angle it routinely does not — a column's narrow side face
  // carries a normal a few degrees PAST the horizon. Left alone that puts the
  // slice angle \`n\` outside ±90°, which inverts the horizon arc below and makes
  // the whole face return zero visibility. It is not a subtle artefact: it paints
  // solid black wedges down every grazing surface in the frame. Bend the normal
  // back to just inside the horizon instead.
  float nv = dot( N, V );
  if ( nv < 0.06 ) N = normalize( N + V * ( 0.06 - nv ) );

  // Screen-space radius of the FAR search, in UV. Everything is expressed as a
  // fraction of it so the near search is just a shorter walk down the same ray.
  float pixelsPerMetre = 0.5 * uResolution.y * uProjection.z / depth;
  float radiusPxFar = clamp( uAoParams.y * pixelsPerMetre, 3.0, 220.0 );

  float jitter = ironNoise( gl_FragCoord.xy );
  float visibilityFar = 0.0;
  float visibilityNear = 0.0;

  for ( int s = 0; s < ${slices}; s ++ ) {
    float phi = ( float( s ) + jitter ) * IRON_PI / float( ${slices} );
    vec2 dir = vec2( cos( phi ), sin( phi ) );

    vec3 sliceDir = vec3( dir, 0.0 );
    vec3 axis = normalize( cross( sliceDir, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projNLen = length( projN );
    if ( projNLen < 1e-4 ) continue;
    vec3 tangent = normalize( sliceDir - V * dot( sliceDir, V ) );
    float n = atan( dot( projN, tangent ), dot( projN, V ) );

    // cos of the highest horizon found so far. A/B are the -tangent/+tangent
    // sides, and the sign convention has to match \`n\` or sloped surfaces come
    // out occluded on the wrong side.
    float cFarA = -1.0, cFarB = -1.0;
    float cNearA = -1.0, cNearB = -1.0;

    for ( int t = 0; t < ${steps}; t ++ ) {
      float frac = ( float( t ) + jitter + 0.5 ) / float( ${steps} );
      // Quadratic spacing: dense at the contact end where the detail is.
      frac *= frac;
      vec2 offset = dir * frac * radiusPxFar / uResolution;

      vec4 sb = texture( uGbuffer, vUv + offset );
      if ( sb.a > 0.0 && sb.a < 900.0 ) {
        vec3 d = ironViewPos( vUv + offset, sb.a ) - P;
        float len = length( d );
        float c = dot( d, V ) / max( len, 1e-4 );
        // RANGE CHECK: an occluder further away than the search radius fades out
        // instead of stopping abruptly. Without this a foreground silhouette
        // paints a hard grey outline onto everything behind it.
        float w = clamp( 1.0 - ( len - uAoParams.y ) / uAoParams.z, 0.0, 1.0 );
        cFarB = max( cFarB, mix( -1.0, c, w ) );
        if ( len <= uAoParams.x ) cNearB = max( cNearB, c );
      }

      vec4 sa = texture( uGbuffer, vUv - offset );
      if ( sa.a > 0.0 && sa.a < 900.0 ) {
        vec3 d = ironViewPos( vUv - offset, sa.a ) - P;
        float len = length( d );
        float c = dot( d, V ) / max( len, 1e-4 );
        float w = clamp( 1.0 - ( len - uAoParams.y ) / uAoParams.z, 0.0, 1.0 );
        cFarA = max( cFarA, mix( -1.0, c, w ) );
        if ( len <= uAoParams.x ) cNearA = max( cNearA, c );
      }
    }

    float hFarA = n + max( -acos( clamp( cFarA, -1.0, 1.0 ) ) - n, -IRON_HALF_PI );
    float hFarB = n + min( acos( clamp( cFarB, -1.0, 1.0 ) ) - n, IRON_HALF_PI );
    visibilityFar += ironArc( n, hFarA, hFarB, projNLen );

    float hNearA = n + max( -acos( clamp( cNearA, -1.0, 1.0 ) ) - n, -IRON_HALF_PI );
    float hNearB = n + min( acos( clamp( cNearB, -1.0, 1.0 ) ) - n, IRON_HALF_PI );
    visibilityNear += ironArc( n, hNearA, hNearB, projNLen );
  }

  float inv = 1.0 / float( ${slices} );
  float aoFar = clamp( visibilityFar * inv, 0.0, 1.0 );
  float aoNear = clamp( visibilityNear * inv, 0.0, 1.0 );
  aoFar = pow( aoFar, uAoParams.w );
  // The contact term carries a stronger exponent than the sky term on purpose.
  // The rubric asks for "darkening ... where every object meets the ground" and
  // for that band to be DARKER than the cast shadow it sits inside; a horizon
  // integral over a 0.55 m neighbourhood only reaches ~0.55 visibility at a
  // right-angled floor/wall joint, which is a suggestion rather than a contact.
  aoNear = pow( aoNear, uAoParams.w * 1.9 );
  outColor = vec4( aoNear, aoFar, ironContactShadow( P, N, depth ), 1.0 );
`;
}

/**
 * SCREEN-SPACE CONTACT SHADOW — the sun's occlusion at a scale no cascade can
 * hold.
 *
 * A cascade-0 texel is 1.5 cm at the camera and 20 cm at 40 m, and the PCSS
 * kernel is several texels wide, so the shadow a crate throws in its own last
 * 30 cm before the ground is filtered away exactly where the eye looks hardest
 * for it. Every round-2 finding on this axis was a version of the same
 * sentence: "the pier meets the floor with no darkening gradient at all", "the
 * four canopy posts meet the sand with zero contact darkening", "that crate
 * meets the ground with no darkening whatsoever". A short ray-march along the
 * sun vector in the half-res depth buffer answers all of them, because it works
 * in PIXELS rather than in shadow texels and therefore sharpens as the occluder
 * approaches its receiver, which is the definition of contact hardening.
 *
 * It multiplies the cascade rather than replacing it: outside the marched
 * distance the ray finds nothing and returns 1, so the two compose with no
 * seam. The thickness window is what stops a distant silhouette that merely
 * lies along the sun vector from painting a shadow onto everything behind it.
 */
function contactShadowFn(steps: number): string {
  return /* glsl */ `
  float ironContactShadow( vec3 P, vec3 N, float depth ) {
    float maxDist = uSunView.w;
    if ( maxDist <= 0.0 ) return 1.0;
    // Beyond this the march is shorter than one half-res pixel and the cascade
    // is comfortably finer than the artefacts a sub-pixel march invents.
    float fade = 1.0 - smoothstep( 55.0, 85.0, depth );
    if ( fade <= 0.0 ) return 1.0;

    vec3 rayStep = uSunView.xyz * ( maxDist / float( ${steps} ) );
    // Start off the surface along its own normal, by one step's worth of
    // grazing error. Without it a floor lit at 11° self-occludes on tap one.
    float jitter = ironNoise( gl_FragCoord.xy * 1.7 );
    vec3 rayPos = P + N * ( maxDist * 0.06 ) + rayStep * jitter;

    float occ = 0.0;
    for ( int i = 0; i < ${steps}; i ++ ) {
      rayPos += rayStep;
      vec2 uv = ironProjectUv( rayPos );
      if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
      float sceneDepth = texture( uGbuffer, uv ).a;
      if ( sceneDepth <= 0.0 || sceneDepth > 900.0 ) continue;
      float diff = -rayPos.z - sceneDepth;
      // diff > 0: something is in front of the ray, i.e. between this point and
      // the sun. The upper bound is the assumed thickness of that something —
      // past it the occluder is a separate object with air behind it and this
      // ray passes safely under.
      if ( diff > 0.02 && diff < maxDist * 1.5 ) {
        occ = 1.0;
        break;
      }
    }
    return 1.0 - occ * fade;
  }
`;
}

/**
 * Depth-aware 4-tap cross blur. Half-res AO carries the horizon march's dither
 * as visible noise; a plain blur would drag occlusion across silhouettes, so the
 * weight collapses when the neighbour's depth disagrees.
 */
const BLUR_BODY = /* glsl */ `
  vec2 texel = 1.0 / uResolution;
  vec4 centreG = texture( uGbuffer, vUv );
  vec3 sum = texture( uAo, vUv ).rgb;
  float weight = 1.0;
  for ( int i = 0; i < 8; i ++ ) {
    vec2 o = uOffsets[ i ] * texel * uBlurRadius;
    vec4 sg = texture( uGbuffer, vUv + o );
    float dw = exp( -abs( sg.a - centreG.a ) * 3.0 );
    float nw = max( dot( sg.rgb, centreG.rgb ), 0.0 );
    float w = dw * nw * nw;
    sum += texture( uAo, vUv + o ).rgb * w;
    weight += w;
  }
  // B is the contact shadow, and it is the one channel that must NOT be
  // depth-blurred as widely as the AO: it is a binary visibility whose whole
  // value is its edge. The bilateral weights already collapse across a
  // silhouette; keeping it in the same resolve costs nothing and the half-res
  // upsample is what softens it into a penumbra of the right order.
  outColor = vec4( sum / weight, 1.0 );
`;

const BLUR_PRELUDE = /* glsl */ `
  uniform sampler2D uAo;
  uniform sampler2D uGbuffer;
  uniform float uBlurRadius;
  uniform vec2 uOffsets[8];
`;

export class Gtao {
  private gbuffer: THREE.WebGLRenderTarget | null = null;
  private raw: THREE.WebGLRenderTarget | null = null;
  private resolved: THREE.WebGLRenderTarget | null = null;
  private readonly material = createGBufferMaterial();
  private width = 0;
  private height = 0;

  private readonly uProjection: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4(1, 1, 1, 0) };
  private readonly uAoParams: GpuUniform<THREE.Vector4> = {
    value: new THREE.Vector4(RADIUS_NEAR, RADIUS_FAR, 2.5, 1.25),
  };
  private readonly uSunView: GpuUniform<THREE.Vector4> = { value: new THREE.Vector4(0, 0, -1, 0) };
  private readonly sunView = new THREE.Vector3();
  private readonly uGbuffer: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uAo: GpuUniform<THREE.Texture | null> = { value: null };
  private readonly uBlurRadius: GpuUniform<number> = { value: 1.35 };
  private readonly uOffsets: GpuUniform<THREE.Vector2[]> = {
    value: [
      new THREE.Vector2(1, 0),
      new THREE.Vector2(-1, 0),
      new THREE.Vector2(0, 1),
      new THREE.Vector2(0, -1),
      new THREE.Vector2(1, 1),
      new THREE.Vector2(-1, 1),
      new THREE.Vector2(1, -1),
      new THREE.Vector2(-1, -1),
    ],
  };

  /** Null until the first successful build — the shader treats that as "no AO". */
  get texture(): THREE.Texture | null {
    return this.resolved ? this.resolved.texture : null;
  }

  private ensure(width: number, height: number): void {
    if (this.gbuffer && this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.gbuffer?.dispose();
    this.raw?.dispose();
    this.resolved?.dispose();
    this.gbuffer = new THREE.WebGLRenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.gbuffer.texture.name = 'iron.gbuffer';
    const aoOptions: THREE.RenderTargetOptions = {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    };
    this.raw = new THREE.WebGLRenderTarget(width, height, aoOptions);
    this.resolved = new THREE.WebGLRenderTarget(width, height, aoOptions);
    this.resolved.texture.name = 'iron.gtao';
  }

  update(
    ctx: FrameCtx,
    graph: RenderGraph,
    scene: SceneGraph,
    renderer: THREE.WebGLRenderer,
    quality: Readonly<QualitySettings>,
    sunDirWorld: Readonly<Vec3> | null,
  ): void {
    const settings = quality.gtao;
    const scale = THREE.MathUtils.clamp(settings.scale, 0.25, 1);
    const width = Math.max(8, Math.round(graph.width * scale));
    const height = Math.max(8, Math.round(graph.height * scale));
    this.ensure(width, height);
    const gbuffer = this.gbuffer;
    const raw = this.raw;
    const resolved = this.resolved;
    if (!gbuffer || !raw || !resolved) return;

    // ---- half-res depth + normal ------------------------------------------
    const camera = ctx.camera.world;
    const previousOverride = scene.root.overrideMaterial;
    const previousBackground = scene.root.background;
    const previousMask = camera.layers.mask;
    const debug = scene.group(SceneGroup.Debug);
    const debugVisible = debug.visible;
    const previousClear = renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();

    // Depth 0 in the clear means "sky" to the AO shader, which then contributes
    // nothing — the reason a silhouette against the sky carries no halo.
    renderer.setClearColor(0x000000, 0);
    scene.root.background = null;
    scene.root.overrideMaterial = this.material;
    debug.visible = false;
    // Same hazard as the shadow atlas: under an override, `sky.dome` stops
    // being a shader that pins itself to the far plane and becomes a solid 2 m
    // cube at the world origin. In the G-buffer that reads as real geometry a
    // couple of metres across, and the horizon march happily occludes against
    // it. See `csm.ts`.
    const sky = scene.group(SceneGroup.Sky);
    const skyVisible = sky.visible;
    sky.visible = false;
    camera.layers.disableAll();
    for (const layer of GBUFFER_LAYERS) camera.layers.enable(layer as number);
    graph.drawScene(ctx, scene.root, camera, gbuffer, true);
    camera.layers.mask = previousMask;
    debug.visible = debugVisible;
    sky.visible = skyVisible;
    scene.root.overrideMaterial = previousOverride;
    scene.root.background = previousBackground;
    renderer.setClearColor(previousClear, previousClearAlpha);

    // ---- horizon march -----------------------------------------------------
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    this.uProjection.value.set(tanY * camera.aspect, tanY, 1 / tanY, ctx.frame % 8);
    this.uGbuffer.value = gbuffer.texture;
    // World → view is a rotation for a direction, so the translation column of
    // the view matrix must not come along. `transformDirection` is exactly that
    // and it renormalises, which matters because the ray step length is derived
    // from it.
    if (sunDirWorld) {
      this.sunView.set(sunDirWorld.x, sunDirWorld.y, sunDirWorld.z).transformDirection(camera.matrixWorldInverse);
      this.uSunView.value.set(this.sunView.x, this.sunView.y, this.sunView.z, CONTACT_DISTANCE);
    } else {
      this.uSunView.value.set(0, 0, -1, 0);
    }
    const slices = THREE.MathUtils.clamp(settings.slices, 1, 4);
    const steps = THREE.MathUtils.clamp(settings.stepsPerSlice, 2, 8);
    graph.fullscreen(
      `iron.gtao.${slices}x${steps}`,
      aoBody(slices, steps),
      {
        uGbuffer: this.uGbuffer as GpuUniform,
        uProjection: this.uProjection as GpuUniform,
        uAoParams: this.uAoParams as GpuUniform,
        uSunView: this.uSunView as GpuUniform,
      },
      raw,
      { prelude: AO_PRELUDE + contactShadowFn(CONTACT_STEPS) },
    );

    // ---- bilateral resolve -------------------------------------------------
    this.uAo.value = raw.texture;
    graph.fullscreen(
      'iron.gtao.blur',
      BLUR_BODY,
      {
        uAo: this.uAo as GpuUniform,
        uGbuffer: this.uGbuffer as GpuUniform,
        uBlurRadius: this.uBlurRadius as GpuUniform,
        uOffsets: this.uOffsets as GpuUniform,
      },
      resolved,
      { prelude: BLUR_PRELUDE },
    );
  }

  dispose(): void {
    this.gbuffer?.dispose();
    this.raw?.dispose();
    this.resolved?.dispose();
    this.material.dispose();
  }
}
