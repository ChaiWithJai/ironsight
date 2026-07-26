/**
 * MaterialFactory — THE SINGLE PLACE ANY THREE.Material IS CREATED.
 *
 * OWNER: RCORE. This is the day-0 implementation. It is the ONLY file in the
 * repo (with the rest of `src/render/material/`) allowed to call
 * `new THREE.Mesh*Material` or `onBeforeCompile`; CI greps for both.
 *
 * Why the whole project funnels through one factory:
 *  - it caps shader permutations, which is what keeps compile hitches and the
 *    program budget under control;
 *  - it keeps sixteen authors on ONE lighting model, so a wall built by LEVEL
 *    and a crate built by VFX shade identically;
 *  - it guarantees that CSM sampling, GTAO application, clustered lights,
 *    aerial perspective and wind animation are injected the same way everywhere;
 *  - and it owns `registerDeform`, which is the motion-vector contract.
 *
 * RCORE replaces the body with the `iron-material.ts` uber material. The day-0
 * version below is a correctly-configured `MeshStandardMaterial` keyed on
 * `SurfaceId`, which is enough to light and shadow a scene and to prove the
 * boot path end to end.
 */
import * as THREE from 'three';
import {
  MaterialFeature,
  SurfaceId,
  type AssetRegistry,
  type BlendMode,
  type BootContext,
  type DeformChunk,
  type FrameCtx,
  type GpuUniform,
  type MaterialFactory,
  type MaterialSpec,
  type QualitySettings,
  type QualityService,
  type SurfaceChunk,
  type SurfaceProfile,
  type TextureSet,
  type UnlitSpec,
} from '@/engine/types';
import { SURFACE_BASE_COLOR, surfaceProfile } from '@/render/material/surfaces';

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

function flatTexture(rgba: readonly [number, number, number, number], colorSpace: string): THREE.DataTexture {
  const data = new Uint8Array(ARRAY_EDGE * ARRAY_EDGE * 4);
  for (let i = 0; i < ARRAY_EDGE * ARRAY_EDGE; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const tex = new THREE.DataTexture(data, ARRAY_EDGE, ARRAY_EDGE);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class IronMaterialFactory implements MaterialFactory {
  readonly albedoArray = flatDataArray(ARRAY_LAYERS, [140, 128, 108, 255]);
  readonly surfaceArray = flatDataArray(ARRAY_LAYERS, [128, 128, 200, 255]);

  private readonly cache = new Map<string, THREE.Material>();
  private readonly textureCache = new Map<SurfaceId, TextureSet>();
  private readonly deformChunks = new Map<string, DeformChunk>();
  private readonly surfaceChunks = new Map<string, SurfaceChunk>();
  private readonly depthVariants = new Map<THREE.Material, THREE.Material>();
  /**
   * Declared uniform cells per material. The factory holds the SAME objects the
   * lane declared, and hands the same objects to every variant, so one write
   * reaches the forward, depth, shadow and velocity programs at once. This map
   * is also what makes `setUniform` able to throw on a typo instead of writing
   * into nothing.
   */
  private readonly declaredUniforms = new Map<THREE.Material, Map<string, GpuUniform>>();
  /** Uniform name → the spec id that claimed it, so two lanes cannot collide. */
  private readonly uniformOwners = new Map<string, string>();
  private nextLayer = RESERVED_LAYERS;
  private readonly layerIds = new Map<string, number>();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly quality: QualityService,
  ) {}

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

    const base = spec.baseColor ?? SURFACE_BASE_COLOR[spec.surface] ?? 0x808080;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(base),
      // Everything is authored in sRGB and shaded in linear; three converts on
      // assignment because ColorManagement is enabled at boot.
      roughness: spec.roughness ?? 0.85,
      metalness: spec.metalness ?? 0,
      side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      transparent: spec.transparent === true,
      alphaTest: spec.alphaTest ?? 0,
      vertexColors: false,
      flatShading: false,
    });
    material.name = spec.id;
    if (spec.emissive !== undefined) {
      material.emissive = new THREE.Color(spec.emissive);
      material.emissiveIntensity = spec.emissiveIntensity ?? 1;
    }
    // Dielectric F0 lives in 0..0.08; three's `specularIntensity` on Standard is
    // not exposed, so the day-0 path folds it into roughness only. RCORE's uber
    // material carries the real F0.
    if (spec.features & MaterialFeature.AlphaClip && !material.alphaTest) {
      material.alphaTest = 0.5;
    }
    // Depth state is explicit and separable from blending. Water is the case
    // that forces it: alpha-blended AND depth-writing, or volumetrics and every
    // sorted transparent draw straight through the sea.
    applyBlend(material, spec.blending ?? (spec.transparent ? 'alpha' : 'opaque'));
    material.depthWrite = spec.depthWrite ?? !spec.transparent;
    material.depthTest = spec.depthTest ?? true;
    this.bindUniforms(material, spec.id, spec.uniforms);
    this.cache.set(key, material);
    return material;
  }

  /**
   * UNLIT escape hatch — HUD text, debug gizmos, the sky dome. The alternative
   * is every lane deciding independently whether `new THREE.RawShaderMaterial`
   * is legal (it is not; CI now fails on it) and finding out at integration.
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
    // The material owns the very cells the caller passed, so setUniform and a
    // direct `.value =` write are the same write.
    const cells = new Map<string, GpuUniform>();
    for (const [name, cell] of Object.entries(spec.uniforms)) {
      cells.set(name, material.uniforms[name] as GpuUniform);
      void cell;
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

  textures(id: SurfaceId): TextureSet {
    let set = this.textureCache.get(id);
    if (set) return set;
    const hex = SURFACE_BASE_COLOR[id] ?? 0x808080;
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    const profile = surfaceProfile(id);
    // Roughness in the blue channel, AO in alpha — the packing the contract
    // specifies, so a lane written against the null reads the right channels.
    const rough = Math.round((1 - profile.hardness * 0.55) * 255);
    set = {
      albedoHeight: flatTexture([r, g, b, 128], THREE.SRGBColorSpace),
      normalRoughAo: flatTexture([128, 128, rough, 255], THREE.NoColorSpace),
      tiling: 2,
      metalness: id === SurfaceId.BareMetal || id === SurfaceId.PaintedMetal ? 1 : 0,
    };
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
   *
   * The chunk must also define `IRON_PREV_POSITION` — the same displacement
   * evaluated with LAST frame's uniforms — or the velocity pass writes zero and
   * every temporal filter treats moving geometry as static.
   */
  registerDeform(name: string, chunk: DeformChunk): void {
    const existing = this.deformChunks.get(name);
    if (existing !== undefined) {
      if (
        existing.common !== chunk.common ||
        existing.displace !== chunk.displace ||
        existing.prevPosition !== chunk.prevPosition
      ) {
        throw new Error(`MaterialFactory: deform chunk "${name}" registered twice with different GLSL`);
      }
      return;
    }
    if (chunk.displace.trim().length === 0) {
      throw new Error(`MaterialFactory: deform chunk "${name}" has an empty \`displace\` — it moves nothing.`);
    }
    if (chunk.prevPosition.trim().length === 0) {
      throw new Error(
        `MaterialFactory: deform chunk "${name}" has an empty \`prevPosition\`. It must be a vec3 ` +
          `EXPRESSION giving this vertex under last frame's uniforms — write \`position\` if the ` +
          `vertex genuinely does not move, but do not leave it blank: the velocity pass would write ` +
          `zero and TAA would treat moving geometry as static.`,
      );
    }
    if (chunk.prevPosition.includes(';')) {
      throw new Error(
        `MaterialFactory: deform chunk "${name}" \`prevPosition\` contains ';' — it is an EXPRESSION, ` +
          `not statements. Put helpers in \`common\`.`,
      );
    }
    this.deformChunks.set(name, chunk);
  }

  /**
   * The fragment counterpart. Registered chunks run after albedo/normal/
   * roughness resolve and before lighting, so a lane's own shading still gets
   * CSM, clustered lights, GTAO and aerial perspective — which is the whole
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
    return this.deformChunks;
  }

  /** Registered surface chunks, for RCORE's uber-material assembly. */
  get surfaces(): ReadonlyMap<string, SurfaceChunk> {
    return this.surfaceChunks;
  }

  depthVariant(material: THREE.Material): THREE.Material {
    let v = this.depthVariants.get(material);
    if (!v) {
      const src = material as THREE.MeshStandardMaterial;
      v = new THREE.MeshDepthMaterial({
        depthPacking: THREE.RGBADepthPacking,
        alphaTest: src.alphaTest,
        side: src.side,
      });
      // The variant shares the forward material's uniform CELLS, not copies of
      // them, so `setUniform` reaches depth, shadow and velocity with one write
      // and a deform can never displace the lit pass differently from the
      // prepass. Same guarantee as registerDeform, one level down.
      const cells = this.declaredUniforms.get(material);
      if (cells) this.declaredUniforms.set(v, cells);
      this.depthVariants.set(material, v);
    }
    return v;
  }

  shadowVariant(material: THREE.Material): THREE.Material {
    return this.depthVariant(material);
  }

  velocityVariant(material: THREE.Material): THREE.Material {
    // Day 0 there is no velocity buffer, so the depth variant is a correct
    // stand-in: same geometry, same alpha test, same deform chunk once RCORE
    // wires the injection.
    return this.depthVariant(material);
  }

  /**
   * Pushes sun, cascades, LUTs, clusters, wind and exposure into every material.
   * Day 0 there are no custom uniforms, so this only keeps the shared texture
   * arrays flagged for upload; the hook exists so lanes can rely on it running
   * exactly once per frame, before submit.
   */
  updateGlobals(_ctx: FrameCtx): void {}

  /**
   * Compile every live permutation against a probe scene BEFORE `markReady()`.
   * A shader compiled lazily on first sight costs 20–120 ms on the main thread,
   * which under the harness lands inside the shot's frame budget and shows up as
   * a shot that "sometimes" looks different.
   */
  async prewarm(): Promise<void> {
    if (this.cache.size === 0) return;
    const probe = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    camera.position.set(0, 0, 3);
    // A light must be present or three compiles the unlit permutation instead.
    probe.add(new THREE.DirectionalLight(0xffffff, 1));
    probe.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1));
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (const material of this.cache.values()) {
      probe.add(new THREE.Mesh(geometry, material));
    }
    this.renderer.compile(probe, camera);
    geometry.dispose();
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * RCORE: replace the BODY of this file, keep this signature and this path.
 */
export function createMaterialFactory(ctx: BootContext): IronMaterialFactory {
  return new IronMaterialFactory(ctx.renderer, ctx.quality);
}

/**
 * The albedo and surface `DataArrayTexture` layers, the BRDF LUT and the grade
 * LUT — step 2 of the bake table, and the largest single line item in it.
 */
export function registerMaterialsBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null factory bakes nothing; it makes flat `MeshStandardMaterial`s.
}

/**
 * Harness reset chain. Nothing a material holds is per-capture EXCEPT anything
 * that feeds a temporal filter — the global uniform block's previous-frame
 * values, and any per-instance wear accumulated during a live session.
 */
export function resetMaterials(_seed: number): void {
  // The null factory holds no transient state.
}
