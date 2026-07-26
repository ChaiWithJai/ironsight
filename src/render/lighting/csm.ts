/**
 * Cascaded shadow maps: frustum fit, world-space texel snapping, atlas render.
 *
 * OWNER: LIGHT.
 *
 * GOLDEN HOUR IS THE WORST CASE FOR CSM AND EVERY DECISION HERE IS ABOUT THAT.
 * With the sun 11° up, an occluder that shadows a point P always sits at
 * `P + t·sunDir` — which in LIGHT SPACE is a pure +Z displacement. So the near
 * plane, and only the near plane, has to be pushed back to catch it: no lateral
 * expansion is needed and any that were added would waste texels. `CASTER_DEPTH`
 * is that push-back, and it is why a 12 m wall 60 m up-sun still darkens the
 * street in cascade 0.
 *
 * Two other things it would be easy to get wrong:
 *
 *  - **The fit is a SPHERE, not a box.** A box fitted to the frustum slice
 *    changes size as the camera rotates, so every texel moves and the whole
 *    frame crawls. A sphere is rotation-invariant, so with the centre snapped to
 *    a world-space texel grid the shadow is pinned to the world.
 *  - **The atlas stores METRES from the light plane, not device depth.** That is
 *    what lets `pcss` compute a physical penumbra: the occluder-receiver gap
 *    comes out in metres and multiplies straight into tan(0.265°).
 */
import * as THREE from 'three';
import type { FrameCtx, QualitySettings, RenderGraph, SceneGraph, Vec3 } from '@/engine/types';
import { RenderLayer, SceneGroup } from '@/engine/types';
import {
  M_CASCADE0,
  V_BIAS,
  V_CASCADE_RADIUS,
  V_SPLITS,
  V_TEXEL_WORLD,
  V_TILE0,
  shadingUniforms,
} from '@/render/lighting/shading';
import { SUN_PENUMBRA_SLOPE } from '@/render/lighting/photometry';

/**
 * How far up-sun a caster may be and still reach this cascade, in metres. At an
 * 11° sun a 200 m up-sun ray has only risen 38 m, so this is the number that
 * decides whether the minaret shadows the square.
 */
const CASTER_DEPTH = 200;

/** Layers that occlude the sun. Decals, water, HUD and the viewmodel do not. */
const SHADOW_LAYERS: readonly RenderLayer[] = [
  RenderLayer.WorldOpaque,
  RenderLayer.WorldAlphaTest,
  RenderLayer.Vegetation,
  RenderLayer.Impostor,
  RenderLayer.ShadowOnly,
];

/**
 * Depth-only override. It deliberately goes through three's own vertex chunks
 * rather than a hand-rolled `modelViewMatrix * position`: `project_vertex` is
 * what applies `batchingMatrix` and `instanceMatrix`, and the level is composed
 * of BatchedMeshes. Skipping it would shadow every batched building at the
 * world origin, which reads as "shadows are broken" rather than as "the override
 * material forgot about batching".
 */
function createDepthMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      #include <common>
      #include <batching_pars_vertex>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying float vIronDepth;
      void main() {
        #include <batching_vertex>
        #include <beginnormal_vertex>
        #include <morphinstance_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vIronDepth = - mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vIronDepth;
      void main() {
        gl_FragColor = vec4( vIronDepth, 0.0, 0.0, 1.0 );
      }
    `,
    uniforms: {},
    side: THREE.FrontSide,
  });
  material.name = 'iron:shadowDepth';
  return material;
}

interface Cascade {
  readonly camera: THREE.OrthographicCamera;
  /** Atlas tile rect, normalised. */
  readonly tile: { x: number; y: number; w: number; h: number };
  readonly tileTexels: number;
  radius: number;
  texelWorld: number;
  far: number;
}

export class ShadowCascades {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly depthMaterial = createDepthMaterial();
  private readonly cascades: Cascade[] = [];
  private readonly cadence: readonly number[];
  private readonly count: number;

  private readonly rotation = new THREE.Matrix4();
  private readonly rotationInverse = new THREE.Matrix4();
  private readonly scaleBias = new THREE.Matrix4();
  private readonly shadowMatrix = new THREE.Matrix4();
  private readonly centre = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();

  readonly atlasSize: number;

  constructor(quality: Readonly<QualitySettings>) {
    const s = quality.shadows;
    this.count = Math.min(4, s.cascadeCount);
    this.cadence = s.updateCadence;
    this.atlasSize = s.atlasSize;

    // 2×2 quadrants. The tier tables list per-cascade tile sizes that do not
    // actually tile inside `atlasSize` (High asks for 2048 + 1536 across a 3072
    // atlas), so each cascade gets its quadrant and is clamped to it — finer
    // cascades still get the larger tile, which is the intent of the table.
    const half = this.atlasSize / 2;
    for (let i = 0; i < this.count; i++) {
      const texels = Math.min(s.tileSizes[i] ?? half, half);
      const qx = (i % 2) * half;
      const qy = Math.floor(i / 2) * half;
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 100);
      camera.matrixAutoUpdate = false;
      this.cascades.push({
        camera,
        tile: {
          x: qx / this.atlasSize,
          y: qy / this.atlasSize,
          w: texels / this.atlasSize,
          h: texels / this.atlasSize,
        },
        tileTexels: texels,
        radius: 1,
        texelWorld: 1,
        far: 1,
      });
    }

    this.target = new THREE.WebGLRenderTarget(this.atlasSize, this.atlasSize, {
      format: THREE.RedFormat,
      // 32-bit float, because the atlas holds METRES (0–500) and PCSS differences
      // it. Half float quantises to ~0.25 m at 300 m, which turns the contact
      // shadow under a crate at range into a staircase.
      type: THREE.FloatType,
      // Nearest, always. Linear-filtering a depth value averages two SURFACES,
      // which is meaningless; the many PCSS taps are the filter.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'iron.shadowAtlas';
    this.target.scissorTest = true;
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Splits actually in use, metres. Published through `LightingService`. */
  readonly splits = new Float32Array(4);
  readonly matrices = new Float32Array(64);

  /**
   * Fit, snap and (subject to cadence) re-render every cascade, then publish the
   * whole shadow state into the shared uniform block.
   */
  update(
    ctx: FrameCtx,
    graph: RenderGraph,
    scene: SceneGraph,
    renderer: THREE.WebGLRenderer,
    sunDir: Readonly<Vec3>,
    quality: Readonly<QualitySettings>,
  ): void {
    const u = shadingUniforms();
    const s = quality.shadows;
    const camera = ctx.camera.world;

    // Light-space basis. `up` is chosen away from the light direction so the
    // lookAt is never degenerate at zenith.
    this.up.set(0, 1, 0);
    if (Math.abs(sunDir.y) > 0.98) this.up.set(0, 0, 1);
    this.eye.copy(sunDir).multiplyScalar(-1);
    this.rotation.lookAt(new THREE.Vector3(0, 0, 0), this.eye, this.up);
    this.rotationInverse.copy(this.rotation).invert();

    const previousOverride = scene.root.overrideMaterial;
    const previousClear = renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = renderer.getClearAlpha();
    // Clear to EXACTLY zero: the shader reads 0 as "no occluder, open sky". The
    // engine's normal clear colour is a dark blue, which would land 3 mm from the
    // light plane and shadow the entire world.
    renderer.setClearColor(0x000000, 1);

    let rendered = false;
    for (let i = 0; i < this.count; i++) {
      const cascade = this.cascades[i];
      const near = i === 0 ? camera.near : (s.splits[i - 1] ?? 0);
      const far = Math.min(s.splits[i] ?? s.maxDistance, s.maxDistance);
      this.splits[i] = far;

      const cadence = Math.max(1, this.cadence[i] ?? 1);
      if (ctx.frame % cadence !== 0) continue;

      this.fit(cascade, camera, near, far, sunDir);
      this.renderCascade(ctx, graph, scene, cascade, !rendered);
      rendered = true;
    }
    for (let i = this.count; i < 4; i++) this.splits[i] = this.splits[Math.max(0, this.count - 1)];

    renderer.setClearColor(previousClear, previousClearAlpha);
    scene.root.overrideMaterial = previousOverride;

    // ---- publish -----------------------------------------------------------
    for (let i = 0; i < 4; i++) {
      const c = this.cascades[Math.min(i, this.count - 1)];
      u.vectors[V_SPLITS * 4 + i] = this.splits[i];
      u.vectors[V_TEXEL_WORLD * 4 + i] = c.texelWorld;
      u.vectors[V_CASCADE_RADIUS * 4 + i] = c.radius;
      const t = this.cascades[Math.min(i, this.count - 1)].tile;
      u.vectors[(V_TILE0 + i) * 4 + 0] = t.x;
      u.vectors[(V_TILE0 + i) * 4 + 1] = t.y;
      u.vectors[(V_TILE0 + i) * 4 + 2] = t.w;
      u.vectors[(V_TILE0 + i) * 4 + 3] = t.h;
    }
    u.vectors[V_BIAS * 4 + 0] = 1.15; // depth bias, cascade texels (capped in metres by the shader)
    u.vectors[V_BIAS * 4 + 1] = 1.6; // normal-offset bias, cascade texels (likewise capped)
    // Blocker search radius in cascade TEXELS, not metres: ten texels is ~0.15 m
    // in cascade 0 and ~1 m in cascade 3, which is the range over which an
    // occluder can physically widen this cascade's penumbra. See `ironCascade`.
    u.vectors[V_BIAS * 4 + 2] = 10.0;
    u.vectors[V_BIAS * 4 + 3] = 0.14; // cascade cross-fade band
    u.vectors[V_TEXEL_WORLD * 4 + 3] = this.cascades[this.count - 1].texelWorld;
  }

  /**
   * Sphere-fit the frustum slice, then snap the sphere centre to a WORLD-SPACE
   * texel grid in light space. Both halves matter: the sphere makes the extent
   * rotation-invariant, the snap makes the sampling grid translation-invariant,
   * and only together do they stop the shimmer.
   */
  private fit(
    cascade: Cascade,
    camera: THREE.PerspectiveCamera,
    near: number,
    far: number,
    sunDir: Readonly<Vec3>,
  ): void {
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const tanX = tanY * camera.aspect;

    // The bounding sphere of a frustum slice has a closed form, but the two
    // corner extremes are enough and cheaper: centre it on the axis, radius to
    // the far corner.
    const xn = near * tanX;
    const yn = near * tanY;
    const xf = far * tanX;
    const yf = far * tanY;
    // Solve for the sphere centre on the view axis that is equidistant from the
    // near and far corner rings.
    const a = xn * xn + yn * yn;
    const b = xf * xf + yf * yf;
    let cz = (b - a + far * far - near * near) / (2 * (far - near));
    cz = THREE.MathUtils.clamp(cz, near, far + (far - near));
    const radius = Math.sqrt(b + (far - cz) * (far - cz));

    this.centre.set(0, 0, -cz).applyMatrix4(camera.matrixWorld);

    const texelWorld = (2 * radius) / cascade.tileTexels;
    this.corner.copy(this.centre).applyMatrix4(this.rotation);
    this.corner.x = Math.round(this.corner.x / texelWorld) * texelWorld;
    this.corner.y = Math.round(this.corner.y / texelWorld) * texelWorld;
    this.corner.applyMatrix4(this.rotationInverse);

    const depth = 2 * radius + CASTER_DEPTH;
    this.eye.copy(this.corner).addScaledVector(sunDir, radius + CASTER_DEPTH);

    const cam = cascade.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.05;
    cam.far = depth;
    cam.position.copy(this.eye);
    cam.up.copy(this.up);
    cam.lookAt(this.corner);
    cam.updateMatrix();
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    cascade.radius = radius;
    cascade.texelWorld = texelWorld;
    cascade.far = depth;

    // world → ( u∈[0,1], v∈[0,1], metres from the light plane )
    // prettier-ignore
    this.scaleBias.set(
      0.5 / radius, 0,            0,  0.5,
      0,            0.5 / radius, 0,  0.5,
      0,            0,           -1,  0,
      0,            0,            0,  1,
    );
    this.shadowMatrix.multiplyMatrices(this.scaleBias, cam.matrixWorldInverse);
    const index = this.cascades.indexOf(cascade);
    this.shadowMatrix.toArray(shadingUniforms().matrices, (M_CASCADE0 + index) * 16);
    this.shadowMatrix.toArray(this.matrices, index * 16);
  }

  private renderCascade(
    ctx: FrameCtx,
    graph: RenderGraph,
    scene: SceneGraph,
    cascade: Cascade,
    first: boolean,
  ): void {
    const px = Math.round(cascade.tile.x * this.atlasSize);
    const py = Math.round(cascade.tile.y * this.atlasSize);
    const size = cascade.tileTexels;
    this.target.viewport.set(px, py, size, size);
    this.target.scissor.set(px, py, size, size);

    const cam = cascade.camera;
    cam.layers.disableAll();
    for (const layer of SHADOW_LAYERS) cam.layers.enable(layer as number);

    // Hide the debug group: gizmos are not occluders.
    const debug = scene.group(SceneGroup.Debug);
    const debugVisible = debug.visible;
    debug.visible = false;
    scene.root.overrideMaterial = this.depthMaterial;
    // `clear` is true for every tile: the scissor rect confines it, so each tile
    // is cleared exactly once per frame it is re-rendered and the tiles that are
    // amortised out keep last frame's content.
    graph.drawScene(ctx, scene.root, cam, this.target, true);
    debug.visible = debugVisible;
    void first;
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}
