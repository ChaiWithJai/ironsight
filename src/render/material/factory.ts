/**
 * MaterialFactory — THE SINGLE PLACE ANY THREE.Material IS CREATED.
 *
 * OWNER: RCORE. This file and the rest of `src/render/material/` are the only
 * places in the repo allowed to call `new THREE.Mesh*Material` or
 * `onBeforeCompile`; CI greps for both.
 *
 * Why the whole project funnels through one factory:
 *  - it caps shader permutations, which is what keeps compile hitches and the
 *    program budget under control;
 *  - it keeps sixteen authors on ONE lighting model, so a wall built by LEVEL
 *    and a crate built by VFX shade identically;
 *  - it guarantees that detail normals, wear masks, triplanar projection,
 *    velocity and wind animation are injected the same way everywhere;
 *  - and it owns `registerDeform`, which is the motion-vector contract.
 *
 * WHAT CHANGED FROM DAY 0, AND WHY IT MATTERS MORE THAN ANYTHING ELSE HERE
 * -----------------------------------------------------------------------
 * The day-0 factory handed out a flat `MeshStandardMaterial` per `SurfaceId`
 * and ignored the baked `TextureSet` entirely, so the whole town was untextured
 * single-colour geometry sitting on top of a working PBR bake. Every material
 * now resolves its baked set through `textures()` and goes through
 * `iron-material.ts`, which is where LOOK_SPEC §4's layer stack lives.
 */
import * as THREE from 'three';
import {
  BakeAssets,
  MaterialFeature,
  RTId,
  SurfaceId,
  type AssetRegistry,
  type BlendMode,
  type BootContext,
  type DeformChunk,
  type FrameCtx,
  type GpuUniform,
  type MaterialFactory,
  type MaterialLibrary,
  type MaterialSpec,
  type QualitySettings,
  type QualityService,
  type Rng,
  type Services,
  type SurfaceChunk,
  type SurfaceProfile,
  type TextureSet,
  type UnlitSpec,
} from '@/engine/types';
import { surfaceProfile } from '@/render/material/surfaces';
import { DeformChunkRegistry } from '@/render/material/deform';
import { buildFallbackTextureSet } from '@/render/material/fallback';
import { buildIronMaterial, createIronGlobals, type IronGlobals } from '@/render/material/iron-material';
import { buildDepthMaterial, buildVelocityMaterial, resetVelocityHistory } from '@/render/material/variants';
import { prewarmMaterials } from '@/render/material/prewarm';

/**
 * `BlendMode` → three's blend state. ONE table for the whole renderer: the
 * factory applies it to lane materials, the graph applies it to fullscreen
 * passes, and neither invents its own idea of what "additive" means.
 *
 * `additive` is deliberately awkward to reach: additive smoke that never
 * occludes anything behind it is on the brief's defect list.
 */
export function applyBlend(material: THREE.Material, blend: BlendMode): void {
  switch (blend) {
    case 'alpha':
      material.transparent = true;
      material.blending = THREE.NormalBlending;
      break;
    case 'premultiplied':
      material.transparent = true;
      material.blending = THREE.NormalBlending;
      material.premultipliedAlpha = true;
      break;
    case 'additive':
      material.transparent = true;
      material.blending = THREE.AdditiveBlending;
      break;
    default:
      material.transparent = false;
      material.blending = THREE.NoBlending;
      break;
  }
}

/** Layers reserved in the shared arrays before any lane allocates one. */
const RESERVED_LAYERS = 2;
const ARRAY_EDGE = 4;
const ARRAY_LAYERS = 32;

function flatDataArray(layers: number, rgba: readonly [number, number, number, number]): THREE.DataArrayTexture {
  const data = new Uint8Array(ARRAY_EDGE * ARRAY_EDGE * layers * 4);
  for (let i = 0; i < ARRAY_EDGE * ARRAY_EDGE * layers; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const tex = new THREE.DataArrayTexture(data, ARRAY_EDGE, ARRAY_EDGE, layers);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Everything the factory has to remember about one forward material. */
interface MaterialRecord {
  readonly spec: MaterialSpec;
  readonly textures: TextureSet;
  readonly cells: Map<string, GpuUniform>;
  depth?: THREE.Material;
  velocity?: THREE.Material;
}

export class IronMaterialFactory implements MaterialFactory {
  /**
   * The shared bulk arrays. They stay allocated and neutral: the uber material
   * binds each material's OWN `TextureSet` rather than an array slice, because
   * a per-material sampler pair keeps the bake's full resolution and its
   * per-material tiling rate, where an array forces one edge length and one
   * anisotropy for everything in it. `allocateLayer` therefore still hands out
   * stable indices for any lane that wants to batch, and nothing samples them
   * yet. Called out here because `docs/ARCHITECTURE.md` §4 assumes the array
   * path; this is a deliberate, reported deviation.
   */
  readonly albedoArray = flatDataArray(ARRAY_LAYERS, [140, 128, 108, 255]);
  readonly surfaceArray = flatDataArray(ARRAY_LAYERS, [128, 128, 200, 255]);

  private readonly cache = new Map<string, THREE.Material>();
  private readonly textureCache = new Map<SurfaceId, TextureSet>();
  private readonly records = new Map<THREE.Material, MaterialRecord>();
  private readonly deformChunks = new DeformChunkRegistry();
  private readonly surfaceChunks = new Map<string, SurfaceChunk>();
  private readonly declaredUniforms = new Map<THREE.Material, Map<string, GpuUniform>>();
  private readonly uniformOwners = new Map<string, string>();
  private nextLayer = RESERVED_LAYERS;
  private readonly layerIds = new Map<string, number>();

  private readonly globals: IronGlobals = createIronGlobals();
  /** Unjittered VP this frame and last. The only correct velocity inputs. */
  private readonly currVP: GpuUniform = { value: new THREE.Matrix4() };
  private readonly prevVP: GpuUniform = { value: new THREE.Matrix4() };
  private library: MaterialLibrary | undefined;
  private services: Services | undefined;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly quality: QualityService,
    private readonly assets: AssetRegistry,
    private readonly rng: Rng,
  ) {
    // `bakeAll` has already run by the time any subsystem is constructed (see
    // `src/main.ts`), so the library is available here and every material
    // created during world build gets its real textures on the first try.
    this.library = assets.tryGet(BakeAssets.materials);
  }

  attachServices(services: Services): void {
    this.services = services;
  }

  get permutationCount(): number {
    return this.cache.size;
  }

  get permutationCap(): number {
    return this.quality.settings.budgets.shaderPrograms;
  }

  create(spec: MaterialSpec): THREE.Material {
    const key = `${spec.id}|${spec.features}|${spec.layer}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    if (this.cache.size >= this.permutationCap) {
      throw new Error(
        `MaterialFactory: permutation cap ${this.permutationCap} reached creating "${spec.id}". ` +
          `Reuse an existing MaterialSpec id or raise the tier's shaderPrograms budget in quality.ts — ` +
          `do not smuggle in a variant.`,
      );
    }

    // Both bits read `albedoHeight.a`, one as displacement and one as opacity.
    // Caught here rather than shipping a smoke puff that parallax-shifts.
    if (spec.features & MaterialFeature.ParallaxOcclusion && spec.features & MaterialFeature.AlphaFromHeight) {
      throw new Error(
        `MaterialFactory: "${spec.id}" declares both ParallaxOcclusion and AlphaFromHeight, ` +
          `which are the same channel of albedoHeight read two different ways.`,
      );
    }
    if (spec.deform !== undefined && !this.deformChunks.has(spec.deform)) {
      throw new Error(
        `MaterialFactory: "${spec.id}" names deform chunk "${spec.deform}", which was never registered. ` +
          `Call registerDeform() before create().`,
      );
    }
    if (spec.surfaceShader !== undefined && !this.surfaceChunks.has(spec.surfaceShader)) {
      throw new Error(
        `MaterialFactory: "${spec.id}" names surface chunk "${spec.surfaceShader}", which was never registered.`,
      );
    }

    const textures = this.textures(spec.surface);
    const { material, cells } = buildIronMaterial({
      spec,
      textures,
      globals: this.globals,
      deforms: this.deformChunks,
      surfaceChunk: spec.surfaceShader ? this.surfaceChunks.get(spec.surfaceShader) : undefined,
      anisotropy: this.quality.settings.maxAnisotropy,
    });

    // Depth state is explicit and separable from blending. Water is the case
    // that forces it: alpha-blended AND depth-writing, or volumetrics and every
    // sorted transparent draw straight through the sea.
    applyBlend(material, spec.blending ?? (spec.transparent ? 'alpha' : 'opaque'));
    material.depthWrite = spec.depthWrite ?? !spec.transparent;
    material.depthTest = spec.depthTest ?? true;

    this.bindUniforms(material, spec.id, spec.uniforms);
    // The material's OWN cells (uIronTiling, uIronWearP, …) are declared too, so
    // a lane can retune a surface at runtime through the same validated seam it
    // uses for its own uniforms.
    const declared = this.declaredUniforms.get(material) ?? new Map<string, GpuUniform>();
    for (const [name, cell] of cells) declared.set(name, cell);
    this.declaredUniforms.set(material, declared);

    this.records.set(material, { spec, textures, cells: declared });
    this.cache.set(key, material);
    return material;
  }

  /**
   * UNLIT escape hatch — HUD text, debug gizmos, the sky dome. The alternative
   * is every lane deciding independently whether `new THREE.RawShaderMaterial`
   * is legal (it is not; CI fails on it) and finding out at integration.
   */
  createUnlit(spec: UnlitSpec): THREE.Material {
    const existing = this.cache.get(`unlit|${spec.id}`);
    if (existing) return existing;
    if (this.cache.size >= this.permutationCap) {
      throw new Error(
        `MaterialFactory: permutation cap ${this.permutationCap} reached creating unlit "${spec.id}".`,
      );
    }
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: spec.vertexShader,
      fragmentShader: spec.fragmentShader,
      uniforms: { ...(spec.uniforms as { [k: string]: THREE.IUniform }) },
      defines: { ...(spec.defines ?? {}) },
      side:
        spec.side === 'back' ? THREE.BackSide : spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      depthTest: spec.depthTest ?? true,
      depthWrite: spec.depthWrite ?? true,
      fog: false,
      // A ShaderMaterial gets three's tonemap/output-colourspace injection only
      // when this is on. Off for anything drawn after post.tonemap (the HUD);
      // on for anything drawn into an HDR scene target (the sky dome), or the
      // two land in different colour spaces and the horizon washes out.
      toneMapped: spec.toneMapped ?? false,
    });
    material.name = `unlit:${spec.id}`;
    applyBlend(material, spec.blending ?? (spec.transparent ? 'alpha' : 'opaque'));
    const cells = new Map<string, GpuUniform>();
    for (const name of Object.keys(spec.uniforms)) {
      cells.set(name, material.uniforms[name] as GpuUniform);
    }
    this.declaredUniforms.set(material, cells);
    this.cache.set(`unlit|${spec.id}`, material);
    return material;
  }

  /**
   * Register a spec's uniform cells against the material AND reserve the names.
   * Two lanes reaching for `uPhase` is a collision that would otherwise surface
   * as one lane's water moving to the other lane's clock.
   */
  private bindUniforms(
    material: THREE.Material,
    specId: string,
    uniforms: Readonly<Record<string, GpuUniform>> | undefined,
  ): void {
    if (!uniforms) return;
    const cells = new Map<string, GpuUniform>();
    for (const [name, cell] of Object.entries(uniforms)) {
      const owner = this.uniformOwners.get(name);
      if (owner !== undefined && owner !== specId) {
        throw new Error(
          `MaterialFactory: uniform "${name}" is already declared by material "${owner}". ` +
            `Prefix lane-owned uniform names with your lane id.`,
        );
      }
      this.uniformOwners.set(name, specId);
      cells.set(name, cell);
    }
    this.declaredUniforms.set(material, cells);
  }

  /**
   * Set a declared uniform on `material` and on every variant of it at once.
   * Throws on an undeclared name: a typo here is otherwise a black frame with
   * no error anywhere, which is the single most expensive shape of bug on a
   * project reviewed through screenshots.
   */
  setUniform(material: THREE.Material, name: string, value: unknown): void {
    const cells = this.declaredUniforms.get(material);
    const cell = cells?.get(name);
    if (!cell) {
      throw new Error(
        `MaterialFactory.setUniform: "${name}" was not declared by ${material.name || 'this material'}. ` +
          `Declare it in MaterialSpec.uniforms / UnlitSpec.uniforms first.`,
      );
    }
    // ONE cell, shared by the forward material and by every variant the factory
    // derived from it, so depth, shadow and velocity cannot fall out of step
    // with the lit pass — the same guarantee registerDeform gives for geometry.
    cell.value = value;
    // A ShaderMaterial caches its uniform values against the program; the
    // Mesh*Material path re-uploads every frame, but the unlit and velocity
    // paths need telling.
    const sm = material as THREE.ShaderMaterial;
    if (sm.isShaderMaterial) sm.uniformsNeedUpdate = true;
  }

  uniform(material: THREE.Material, name: string): unknown {
    const cell = this.declaredUniforms.get(material)?.get(name);
    if (!cell) {
      throw new Error(`MaterialFactory.uniform: "${name}" was not declared by ${material.name || 'this material'}.`);
    }
    return cell.value;
  }

  profile(id: SurfaceId): Readonly<SurfaceProfile> {
    return surfaceProfile(id);
  }

  /**
   * The baked `TextureSet` for a surface, or a real synthesised one for the
   * long tail BAKE has no recipe or alias for. Never a flat colour: an
   * untextured surface is the first entry on the brief's defect list.
   */
  textures(id: SurfaceId): TextureSet {
    const cached = this.textureCache.get(id);
    if (cached) return cached;
    const baked = this.library?.get(id);
    const set = baked ?? buildFallbackTextureSet(id, this.rng);
    this.textureCache.set(id, set);
    return set;
  }

  allocateLayer(id: string, _albedoHeight: THREE.Texture, _normalRoughAo: THREE.Texture): number {
    const existing = this.layerIds.get(id);
    if (existing !== undefined) return existing;
    if (this.nextLayer >= ARRAY_LAYERS) {
      throw new Error(`MaterialFactory: material array full (${ARRAY_LAYERS} layers) allocating "${id}"`);
    }
    const layer = this.nextLayer++;
    this.layerIds.set(id, layer);
    return layer;
  }

  /**
   * THE MOTION-VECTOR CONTRACT.
   *
   * The identical GLSL is injected into the FORWARD, DEPTH-PREPASS, SHADOW and
   * VELOCITY materials, so motion vectors and shadows can never disagree with
   * the lit pass. Any lane that animates a vertex in a shader MUST come through
   * here: displacing vertices in your own `onBeforeCompile` produces geometry
   * that ghosts and smears, and the bug will be blamed on TAA rather than on you.
   */
  registerDeform(name: string, chunk: DeformChunk): void {
    this.deformChunks.register(name, chunk);
  }

  /**
   * The fragment counterpart. Registered chunks run after albedo/normal/
   * roughness resolve and before lighting, so a lane's own shading still gets
   * shadows, clustered lights, AO and aerial perspective — which is the whole
   * reason water may not be a hand-rolled ShaderMaterial.
   */
  registerSurface(name: string, chunk: SurfaceChunk): void {
    const existing = this.surfaceChunks.get(name);
    if (existing !== undefined) {
      if (existing.common !== chunk.common || existing.shade !== chunk.shade) {
        throw new Error(`MaterialFactory: surface chunk "${name}" registered twice with different GLSL`);
      }
      return;
    }
    if (chunk.shade.includes('discard')) {
      throw new Error(
        `MaterialFactory: surface chunk "${name}" calls discard. Use MaterialSpec.alphaTest instead, ` +
          `so the depth prepass and the forward pass agree about which fragments exist.`,
      );
    }
    this.surfaceChunks.set(name, chunk);
  }

  /** Registered chunks, for RCORE's prepass/shadow/velocity override materials. */
  get deforms(): ReadonlyMap<string, DeformChunk> {
    return this.deformChunks.all;
  }

  /** Registered surface chunks, for RCORE's uber-material assembly. */
  get surfaces(): ReadonlyMap<string, SurfaceChunk> {
    return this.surfaceChunks;
  }

  depthVariant(material: THREE.Material): THREE.Material {
    const record = this.records.get(material);
    if (!record) return material;
    if (!record.depth) {
      const spec = record.spec;
      record.depth = buildDepthMaterial(
        spec.id,
        spec.deform ? this.deformChunks.get(spec.deform) : undefined,
        (material as THREE.MeshPhysicalMaterial).alphaTest,
        (spec.features & MaterialFeature.AlphaClip) !== 0 ? record.textures.albedoHeight : null,
        (material as THREE.MeshPhysicalMaterial).side,
        spec.uniforms,
        this.globals,
      );
      // Variants share the forward material's uniform CELLS, not copies, so one
      // `setUniform` write reaches all four programs.
      this.declaredUniforms.set(record.depth, record.cells);
    }
    return record.depth;
  }

  shadowVariant(material: THREE.Material): THREE.Material {
    return this.depthVariant(material);
  }

  velocityVariant(material: THREE.Material): THREE.Material {
    const record = this.records.get(material);
    if (!record) return this.depthVariant(material);
    if (!record.velocity) {
      const spec = record.spec;
      record.velocity = buildVelocityMaterial({
        id: spec.id,
        deform: spec.deform ? this.deformChunks.get(spec.deform) : undefined,
        alphaTest: (material as THREE.MeshPhysicalMaterial).alphaTest,
        alphaMap: (spec.features & MaterialFeature.AlphaClip) !== 0 ? record.textures.albedoHeight : null,
        side: (material as THREE.MeshPhysicalMaterial).side,
        uniforms: {
          uIronCurrVP: this.currVP,
          uIronPrevVP: this.prevVP,
          uIronTime: this.globals.uIronTime,
          uIronPrevTime: this.globals.uIronPrevTime,
        },
        laneUniforms: spec.uniforms,
      });
      this.declaredUniforms.set(record.velocity, record.cells);
    }
    return record.velocity;
  }

  /**
   * Pushes time, camera, screen size, the velocity matrices and the scene-depth
   * handle into every material at once. Runs once per frame, before submit.
   *
   * These are SHARED CELLS, so this is ~10 writes for the whole frame rather
   * than 10 per material — which is the reason the globals live in one object
   * instead of being copied into each `onBeforeCompile`.
   */
  updateGlobals(ctx: FrameCtx): void {
    const g = this.globals;
    (g.uIronPrevTime as GpuUniform).value = g.uIronTime.value;
    (g.uIronTime as GpuUniform).value = ctx.time;
    (g.uIronCamPos.value as THREE.Vector3).copy(ctx.camera.position as THREE.Vector3);

    const graph = ctx.services.graph;
    (g.uIronScreen.value as THREE.Vector2).set(1 / Math.max(graph.width, 1), 1 / Math.max(graph.height, 1));

    // Soft particles are a documented NO-OP when the graph has no SceneDepth —
    // which is the whole of Low tier and every configuration before RCORE's
    // prepass lands. Ask every frame: a pass can be added at boot and the
    // answer during `setup` is a lie.
    const hasDepth = graph.has(RTId.SceneDepth);
    g.uIronSoftGlobal.enabled = hasDepth ? 1 : 0;
    g.uIronSoftGlobal.near = ctx.camera.near;
    g.uIronSoftGlobal.far = ctx.camera.far;
    (g.uIronSceneDepth as GpuUniform).value = hasDepth ? graph.texture(RTId.SceneDepth) : null;
    for (const record of this.records.values()) {
      const soft = record.cells.get('uIronSoft')?.value as THREE.Vector4 | undefined;
      if (soft) {
        soft.y = g.uIronSoftGlobal.enabled;
        soft.z = g.uIronSoftGlobal.near;
        soft.w = g.uIronSoftGlobal.far;
      }
    }

    // Velocity: last frame's matrix BEFORE this frame's overwrite, and the
    // unjittered projection on both sides so TAA's own jitter never appears as
    // per-pixel motion.
    (this.prevVP.value as THREE.Matrix4).copy(this.currVP.value as THREE.Matrix4);
    (this.currVP.value as THREE.Matrix4).copy(ctx.camera.viewProjection as THREE.Matrix4);
  }

  /**
   * Compile every live permutation BEFORE `markReady()`. A shader compiled
   * lazily on first sight costs 20–120 ms on the main thread, which under the
   * harness lands inside the shot's frame budget and shows up as a shot that
   * "sometimes" looks different.
   */
  async prewarm(): Promise<void> {
    await prewarmMaterials(this.renderer, this.cache, this.services);
  }

  /** Harness reset: drop temporal state so a capture cannot depend on order. */
  reset(): void {
    (this.prevVP.value as THREE.Matrix4).identity();
    (this.currVP.value as THREE.Matrix4).identity();
    (this.globals.uIronTime as GpuUniform).value = 0;
    (this.globals.uIronPrevTime as GpuUniform).value = 0;
    resetVelocityHistory();
  }
}

let instance: IronMaterialFactory | null = null;

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 */
export function createMaterialFactory(ctx: BootContext): IronMaterialFactory {
  const factory = new IronMaterialFactory(
    ctx.renderer,
    ctx.quality,
    ctx.assets,
    ctx.rng.fork('materials'),
  );
  instance = factory;
  // The scene and camera only exist once every subsystem is constructed, and
  // prewarm needs both to compile against the REAL light configuration rather
  // than a probe rig that would produce a different NUM_DIR_LIGHTS and
  // therefore a different program.
  ctx.afterBoot((services) => factory.attachServices(services));
  return factory;
}

/**
 * The material bakes are BAKE's `bake.materials` step; the factory consumes it
 * rather than declaring its own, because a second copy of the same six PBR sets
 * would double the single largest line item in the bake budget.
 */
export function registerMaterialsBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // Nothing of RCORE's own: the TextureSets come from `BakeAssets.materials`,
  // and the fallback sets for the long-tail surfaces are CPU-generated on first
  // request, which costs 128² of typed-array work and no bake units.
}

/**
 * Harness reset chain. Nothing a material holds is per-capture EXCEPT what
 * feeds a temporal filter — the previous view-projection and the shader clock.
 * A stale previous VP makes the first frame of a capture write a full-screen
 * velocity smear, which TAA then resolves into a ghost that survives the whole
 * shot.
 */
export function resetMaterials(_seed: number): void {
  instance?.reset();
}
