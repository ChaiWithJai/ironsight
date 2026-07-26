/**
 * Aerial perspective on every world surface.
 *
 * OWNER: SKY.
 *
 * ── WHY THIS IS A ShaderChunk OVERRIDE AND NOT A MATERIAL FEATURE ────────────
 *
 * `docs/LOOK_SPEC.md` §3.2 requires `surface·exp(-σd) + inscatter(viewDir)·(1-exp(-σd))`
 * evaluated IN THE FORWARD PASS, and calls its absence "the loudest possible
 * hobby signal". The sanctioned seam for that is RCORE's uber material, which
 * `MaterialFactory` documents as injecting aerial perspective into every
 * surface. That material does not exist yet: `src/render/material/factory.ts` is
 * still the day-0 body handing out plain `MeshStandardMaterial`s, and a lane may
 * not call `onBeforeCompile` (boundary CI) or edit another lane's file.
 *
 * The one remaining route into world-surface shading is `scene.fog`, which SKY
 * already owns — the day-0 sky set it, and this replaces what it set. Three's
 * own `fog_fragment` is unusable as-is for two reasons: it is a lerp toward a
 * single constant colour (explicitly a defect in §3.2), and it runs AFTER
 * `<tonemapping_fragment>`, i.e. on display-referred values, where an additive
 * in-scatter term cannot behave. So:
 *
 *   • `fog_pars_vertex` / `fog_vertex`  carry the world-space eye→fragment
 *      vector, which is all the fragment needs;
 *   • `opaque_fragment` applies the transmittance/in-scatter integral to
 *     `outgoingLight`, in LINEAR space, before the tonemapper — the correct
 *     place, and the place the uber material will do it;
 *   • `fog_fragment` becomes a no-op so nothing is applied twice.
 *
 * Everything sun-dependent arrives through the four uniforms three refreshes for
 * a `THREE.Fog` (`fogColor`, `fogNear`, `fogFar`) because a `ShaderChunk` is
 * read once at program-compile time and three's program cache key does not
 * include chunk contents — regenerating the source later would silently have no
 * effect. Hence `AerialFog` below, which is a `Fog` whose three scalars carry
 * sun azimuth, sun elevation and the σ multiplier instead of near/far.
 *
 * ── HANDOVER ────────────────────────────────────────────────────────────────
 * When RCORE's `iron-material.ts` lands with in-shader aerial perspective, call
 * `disableAerialChunks()` (or simply stop setting `scene.fog`) and move the two
 * GLSL functions below into the uber material's fragment stage unchanged. They
 * are written to be liftable: no three-specific identifiers except the ones
 * named above.
 */
import * as THREE from 'three';
import { HAZE_GLSL, ATMOSPHERE_GLSL } from '@/world/sky/glsl';

/** Original chunk text, so the patch can be lifted cleanly at integration. */
const ORIGINAL: Record<string, string> = {};
let patched = false;

/**
 * A `THREE.Fog` whose scalars are a transport for the sun pose.
 *
 * Three refreshes exactly `fogColor`, `fogNear` and `fogFar` for a linear fog
 * and nothing else, and it does so per material per frame — which is precisely
 * the per-frame channel this lane needs and the only one it has. The colour
 * carries the boundary-layer chroma at the frame's forward direction (used only
 * as a fallback for materials that somehow miss the chunk), and the two scalars
 * carry the sun.
 */
export class AerialFog extends THREE.Fog {
  constructor() {
    super(0x9a8f7a, 0, 1);
  }

  /**
   * `color` ← max-normalised sun chroma, `near` ← sun azimuth (radians),
   * `far` ← sun elevation (radians) packed with the σ multiplier.
   *
   * The colour is written through `SRGBColorSpace` so that three's
   * `getRGB(target, outputColorSpace)` returns the exact values back when the
   * frame goes to the default framebuffer. Into a render target three hands the
   * working-space value instead, which shifts the chroma by a gamma — visible
   * as a slightly cooler haze, never as a failure.
   */
  setSun(direction: THREE.Vector3, sigmaScale: number, chroma: THREE.Color): void {
    this.color.setRGB(chroma.r, chroma.g, chroma.b, THREE.SRGBColorSpace);
    this.near = Math.atan2(direction.x, direction.z);
    const elevation = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    // Two continuous values in one float, with the precision analysed:
    // elevation is offset into [0, 3.2) and σ scale is quantised to 1/1024 and
    // multiplied by 4. The composite peaks near 4·4096 = 16 384, where a
    // 24-bit mantissa still resolves 1e-3 rad — 0.06° of sun elevation, which
    // is a quarter of the sun's own angular radius.
    const sigmaQ = Math.round(Math.max(0, Math.min(4, sigmaScale)) * 1024);
    this.far = sigmaQ * 4 + (elevation + 1.6);
  }
}

const AERIAL_PARS = /* glsl */ `
#ifdef USE_FOG
  #define IRON_AERIAL 1
  varying float vFogDepth;
  varying vec3 vIronEyeVec;
  uniform vec3 fogColor;
  uniform float fogNear;
  uniform float fogFar;

${ATMOSPHERE_GLSL}
${HAZE_GLSL}

  /** Undo the packing in 'AerialFog.setSun'. */
  void ironUnpackSun(out vec3 sunDir, out float sigmaScale) {
    float sigmaQ = floor(fogFar / 4.0);
    sigmaScale = sigmaQ / 1024.0;
    float elevation = (fogFar - sigmaQ * 4.0) - 1.6;
    float azimuth = fogNear;
    float ce = cos(elevation);
    sunDir = vec3(sin(azimuth) * ce, sin(elevation), cos(azimuth) * ce);
  }

  /**
   * LOOK_SPEC §3.2, verbatim: transmittance times the surface plus the per-ray
   * in-scatter, NEVER a lerp toward a constant. Three properties follow from
   * that and none of them survive a lerp:
   *   1. the in-scatter is warm-white toward the sun and cool-blue away from it,
   *      and it changes across a single frame;
   *   2. the forward lobe makes haze near the sun azimuth outshine the sky;
   *   3. the explicit λ⁻⁴ term takes anti-sun distance BLUER and MORE saturated
   *      than the horizon sky it sits against, which is why saturation rises
   *      with distance through the near-mid range instead of washing out.
   */
  vec3 ironAerialPerspective(vec3 surface, vec3 eyeVec, vec3 eyePos) {
    float dist = length(eyeVec);
    if (dist < 0.05) return surface;
    vec3 dir = eyeVec / dist;

    vec3 sunDir;
    float sigmaScale;
    ironUnpackSun(sunDir, sigmaScale);

    // 'fogColor' carries the §2.2 max-normalised sun chroma. It is the only
    // vec3 three refreshes per frame for a fog, and a chroma is the one thing
    // that survives the colour-space round trip three puts it through.
    vec3 sunChroma = clamp(fogColor, vec3(0.05), vec3(1.0));

    // The drift factor is what stops this being a fog constant: the same medium
    // at the same distance is denser in one place than another, which is what
    // air actually does and what the reference corpus shows on every frame.
    vec3 tau = ironHazeTau(dist, eyePos.y, eyePos.y + eyeVec.y, sigmaScale)
             * ironHazeDrift(eyePos + eyeVec * 0.5);
    vec3 trans = exp(-tau);
    vec3 inscatter = ironHazeRadiance(dir, sunDir, sunChroma, 3.4, 0.0) * IRON_SKY_SCALE;
    return surface * trans + inscatter * (1.0 - trans);
  }
#endif
`;

const AERIAL_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vIronEyeVec;
#endif
`;

const AERIAL_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World-space eye→fragment vector. The view matrix is rigid, so its inverse
  // rotation is its transpose and the translation cancels — no 'inverse()' per
  // vertex, and it is exact for instanced, batched and skinned geometry alike
  // because it is derived from 'mvPosition' rather than from 'transformed'.
  // 'v * M' is 'transpose(M) * v' in GLSL, which is the inverse rotation.
  vIronEyeVec = mvPosition.xyz * mat3(viewMatrix);
#endif
`;

const AERIAL_OPAQUE = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
#ifdef USE_TRANSMISSION
diffuseColor.a *= material.transmissionAlpha;
#endif
#ifdef IRON_AERIAL
outgoingLight = ironAerialPerspective(outgoingLight, vIronEyeVec, cameraPosition);
#endif
gl_FragColor = vec4( outgoingLight, diffuseColor.a );
`;

/**
 * Install the chunks. MUST run before any material compiles — three caches
 * linked programs by a key that does not include chunk source, so a patch
 * applied after the first compile is silently ignored for everything already
 * built. `createSkyService` runs during subsystem construction, which is before
 * the level is built and long before `MaterialFactory.prewarm()`.
 */
export function installAerialChunks(): void {
  if (patched) return;
  patched = true;
  for (const key of ['fog_pars_fragment', 'fog_pars_vertex', 'fog_vertex', 'fog_fragment', 'opaque_fragment']) {
    ORIGINAL[key] = THREE.ShaderChunk[key as keyof typeof THREE.ShaderChunk] as string;
  }
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_fragment = AERIAL_PARS;
  chunks.fog_pars_vertex = AERIAL_PARS_VERTEX;
  chunks.fog_vertex = AERIAL_VERTEX;
  // Three applies its fog after the tonemap and the colour-space transform,
  // which is the wrong space for an additive in-scatter term. The work has
  // already been done in `opaque_fragment`; this must not run again.
  chunks.fog_fragment = '// aerial perspective applied in opaque_fragment (SKY lane)';
  chunks.opaque_fragment = AERIAL_OPAQUE;
}

/** Restore three's own chunks. The handover switch; also used by tests. */
export function disableAerialChunks(): void {
  if (!patched) return;
  patched = false;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(ORIGINAL)) chunks[key] = value;
}
