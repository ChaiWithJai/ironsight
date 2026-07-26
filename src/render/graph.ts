/**
 * RenderGraph — THE ONLY CODE THAT MAY TOUCH `renderer.setRenderTarget`,
 * scissor state or `autoClear`.
 *
 * OWNER: RCORE. This is the day-0 implementation: a working render-target pool
 * with format mapping and VRAM accounting, a pass registry ordered by
 * `PassOrder`, `validate()`, history double-buffering, and a fullscreen-triangle
 * blitter. What it does not yet have is the twenty-eight passes; until RCORE
 * registers them, `execute()` falls back to a straight forward render of the
 * scene graph so that every other lane can still take a screenshot.
 *
 * A lane that needs a custom pass registers a `RenderPass` here. It NEVER
 * renders inside its own `update()`. CI greps for `setRenderTarget` outside
 * `src/render/`.
 */
import * as THREE from 'three';
import {
  RTFormat,
  RenderLayer,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type FullscreenOpts,
  type GpuUniform,
  type QualitySettings,
  type RTDesc,
  type RTHistory,
  type RTId,
  type RenderGraph,
  type RenderPass,
  type SceneGraph,
} from '@/engine/types';
import { applyBlend } from '@/render/material/factory';

interface FormatMapping {
  format: THREE.PixelFormat;
  type: THREE.TextureDataType;
  bytesPerPixel: number;
  colorSpace?: string;
}

/**
 * RTFormat → GL. Two day-0 approximations are called out explicitly because
 * they cost memory rather than correctness, and RCORE must tighten them:
 *  - RGB10A2 has no three preset; we allocate RGBA16F (2× the bytes, same range).
 *  - R11G11B10F likewise; the Low tier therefore does not yet get its bandwidth
 *    saving. The FORMAT ENUM is what lanes code against, so nothing downstream
 *    changes when the mapping is fixed.
 */
function mapFormat(f: RTFormat): FormatMapping {
  switch (f) {
    case RTFormat.R8: return { format: THREE.RedFormat, type: THREE.UnsignedByteType, bytesPerPixel: 1 };
    case RTFormat.RG8: return { format: THREE.RGFormat, type: THREE.UnsignedByteType, bytesPerPixel: 2 };
    case RTFormat.RGBA8: return { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, bytesPerPixel: 4 };
    case RTFormat.RGBA8_SRGB:
      return { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, bytesPerPixel: 4, colorSpace: THREE.SRGBColorSpace };
    case RTFormat.RGB10A2: return { format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytesPerPixel: 8 };
    case RTFormat.R16F: return { format: THREE.RedFormat, type: THREE.HalfFloatType, bytesPerPixel: 2 };
    case RTFormat.RG16F: return { format: THREE.RGFormat, type: THREE.HalfFloatType, bytesPerPixel: 4 };
    case RTFormat.RGBA16F: return { format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytesPerPixel: 8 };
    case RTFormat.R11G11B10F: return { format: THREE.RGBAFormat, type: THREE.HalfFloatType, bytesPerPixel: 8 };
    case RTFormat.R32F: return { format: THREE.RedFormat, type: THREE.FloatType, bytesPerPixel: 4 };
    case RTFormat.RGBA32F: return { format: THREE.RGBAFormat, type: THREE.FloatType, bytesPerPixel: 16 };
    case RTFormat.Depth32F: return { format: THREE.DepthFormat, type: THREE.FloatType, bytesPerPixel: 4 };
    case RTFormat.Depth24Stencil8:
      return { format: THREE.DepthStencilFormat, type: THREE.UnsignedInt248Type, bytesPerPixel: 4 };
    default: return { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, bytesPerPixel: 4 };
  }
}

interface Resource {
  desc: RTDesc;
  current: THREE.WebGLRenderTarget | null;
  previous: THREE.WebGLRenderTarget | null;
  valid: boolean;
  bytes: number;
}

const FULLSCREEN_VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    // One oversized triangle, not two triangles: no diagonal seam, no redundant
    // quad-shading along it, one fewer vertex to transform.
    vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
  }
`;

/**
 * THE FULLSCREEN SHADER PROTOCOL, in one function.
 *
 * `RenderGraph.fullscreen` and `GpuBakeDesc.fragment` compile against the same
 * contract deliberately: a lane learns it once, and a shader written for one
 * device runs on the other. What is emitted here — and ONLY what is emitted
 * here — is in scope for the author's body:
 *
 *   precision, `in vec2 vUv`, `uniform vec2 uResolution`, `out vec4 outColor`
 *   (or `outColor0..N-1` when there is more than one attachment).
 *
 * Uniform DECLARATIONS are the author's job, in `prelude`. We never infer a GLSL
 * type from a runtime value: `{ value: 0 }` is ambiguous between `int` and
 * `float` and guessing wrong is a link error at boot, which fails the capture
 * for every lane at once.
 */
function composeFullscreenFragment(body: string, prelude: string, outputs: number): string {
  const outs =
    outputs > 1
      ? Array.from({ length: outputs }, (_, i) => `layout(location = ${i}) out vec4 outColor${i};`).join('\n')
      : 'out vec4 outColor;';
  return [
    'precision highp float;',
    'precision highp int;',
    'in vec2 vUv;',
    'uniform vec2 uResolution;',
    outs,
    prelude,
    'void main() {',
    body,
    '}',
  ].join('\n');
}

export class IronRenderGraph implements RenderGraph {
  width = 1920;
  height = 1080;
  /**
   * Canvas resolution, ignoring renderScale. The HUD lays out against this and
   * `RTDesc.native` allocates at it — architecture pass 27 is native, never
   * renderScale, and a HUD quietly upscaled from 0.70× is exactly the tell that
   * rule exists to prevent.
   */
  nativeWidth = 1920;
  nativeHeight = 1080;

  private readonly resources = new Map<string, Resource>();
  private readonly mrtTargets = new Map<string, THREE.WebGLRenderTarget>();
  private readonly passList: RenderPass[] = [];
  private passesDirty = false;
  private readonly fullscreenCache = new Map<string, THREE.ShaderMaterial>();
  private readonly fullscreenScene = new THREE.Scene();
  private readonly fullscreenCamera = new THREE.Camera();
  private readonly fullscreenMesh: THREE.Mesh;
  private blitMaterial: THREE.ShaderMaterial | null = null;

  constructor(
    readonly renderer: THREE.WebGLRenderer,
    private readonly scene: SceneGraph,
    private readonly quality: () => Readonly<QualitySettings>,
  ) {
    // A 3-vertex non-indexed geometry; positions come from gl_VertexID so the
    // attribute is never read, but three needs a drawRange to dispatch.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.fullscreenMesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial());
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenMesh);
    // The graph owns clear state (architecture 4.2), and every clear it issues
    // is to black: `SceneDepth == 0` is the G-buffer's "no geometry" sentinel
    // and `GVelocity == 0` its "did not move", so an MRT clear — which three
    // applies to every attachment at once — has to be black or both sentinels
    // become lies. Setting it once here rather than saving and restoring per
    // pass also avoids re-converting the colour through sRGB on every restore,
    // which walks it darker frame by frame.
    renderer.setClearColor(0x000000, 1);
  }

  /* ---------------------------------------------------------------- resources */

  declare(desc: RTDesc): void {
    const id = String(desc.id);
    if (desc.native === true && desc.scale !== undefined) {
      throw new Error(
        `RenderGraph: "${id}" declares both native and scale. Native means "ignore renderScale"; ` +
          `pick one, or the size silently follows whichever the implementation checks first.`,
      );
    }
    const existing = this.resources.get(id);
    if (existing) {
      // Redeclaring IDENTICALLY is legal and load-bearing: two passes may both
      // want SceneDepth and neither should have to know whether it got there
      // first. Redeclaring DIFFERENTLY is a real conflict between two lanes and
      // must be loud at boot, not a silent win for whoever ran earlier.
      const a = existing.desc;
      const differs =
        a.format !== desc.format ||
        a.scale !== desc.scale ||
        a.native !== desc.native ||
        a.size?.[0] !== desc.size?.[0] ||
        a.size?.[1] !== desc.size?.[1] ||
        (a.count ?? 1) !== (desc.count ?? 1) ||
        (a.depthLayers ?? 1) !== (desc.depthLayers ?? 1) ||
        a.history !== desc.history ||
        a.depthBuffer !== desc.depthBuffer;
      if (differs) {
        throw new Error(
          `RenderGraph: "${id}" redeclared with a different desc (format ${desc.format} vs ${a.format}, ` +
            `scale ${String(desc.scale)} vs ${String(a.scale)}). Two lanes disagree about this resource.`,
        );
      }
      return;
    }
    this.resources.set(id, { desc, current: null, previous: null, valid: false, bytes: 0 });
  }

  private sizeOf(desc: RTDesc): [number, number] {
    if (desc.size) return [desc.size[0], desc.size[1]];
    if (desc.native) return [this.nativeWidth, this.nativeHeight];
    const scale = desc.scale ?? 1;
    return [Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale))];
  }

  private allocate(res: Resource): THREE.WebGLRenderTarget {
    const [w, h] = this.sizeOf(res.desc);
    const m = mapFormat(res.desc.format);
    const options: THREE.RenderTargetOptions = {
      format: m.format,
      type: m.type,
      minFilter: res.desc.mips
        ? THREE.LinearMipmapLinearFilter
        : res.desc.filter === 'nearest'
          ? THREE.NearestFilter
          : THREE.LinearFilter,
      magFilter: res.desc.filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter,
      wrapS: res.desc.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
      wrapT: res.desc.wrap === 'repeat' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
      depthBuffer: res.desc.depthBuffer !== false,
      stencilBuffer: false,
      generateMipmaps: res.desc.mips === true,
      count: Math.max(1, res.desc.count ?? 1),
    };
    const rt = new THREE.WebGLRenderTarget(w, h, options);
    if (m.colorSpace) rt.texture.colorSpace = m.colorSpace;
    if (res.desc.depthBuffer === 'texture') {
      const dm = mapFormat(res.desc.depthFormat ?? RTFormat.Depth32F);
      rt.depthTexture = new THREE.DepthTexture(w, h, dm.type);
      rt.depthTexture.format = dm.format as THREE.DepthTexturePixelFormat;
      if (res.desc.depthCompare) rt.depthTexture.compareFunction = THREE.LessEqualCompare;
    }
    rt.texture.name = String(res.desc.id);
    res.bytes = w * h * m.bytesPerPixel * Math.max(1, res.desc.count ?? 1) * (res.desc.history ? 2 : 1);
    return rt;
  }

  private resource(id: RTId | string): Resource {
    const res = this.resources.get(String(id));
    if (!res) throw new Error(`RenderGraph: resource "${String(id)}" was never declared`);
    return res;
  }

  /**
   * True when `id` is declared AND an enabled pass writes it.
   *
   * THE SUPPORTED WAY TO DEGRADE. Every lane that reads a tier-gated resource
   * needs this: on Low there is no `Gtao`, no `SsrColor` and no `VolumeScatter`,
   * and the alternative to asking is a `try`/`catch` around `texture()` against
   * behaviour nobody documented.
   *
   * A resource that is declared with a clear colour or as a history counts as
   * written — it holds defined content before any pass runs, which is exactly
   * what `validate()` assumes.
   */
  has(id: RTId | string): boolean {
    const key = String(id);
    const res = this.resources.get(key);
    if (!res) return false;
    if (res.desc.history) return true;
    if (res.desc.clearColor !== undefined && res.desc.clearColor !== null) return true;
    const q = this.quality();
    for (const pass of this.passList) {
      if (!pass.enabled(q)) continue;
      for (const w of pass.writes) if (String(w) === key) return true;
    }
    return false;
  }

  target(id: RTId | string): THREE.WebGLRenderTarget {
    const res = this.resource(id);
    if (!res.current) res.current = this.allocate(res);
    return res.current;
  }

  /**
   * Bind several already-declared targets as ONE MRT framebuffer.
   *
   * This is what lets a FORWARD pass write colour and velocity in a single draw
   * — pass 14, water, the only forward pass that writes velocity. `RTDesc.count`
   * cannot express it, because it makes N attachments under ONE id, and
   * `SceneColor` and `GVelocity` are separate ids owned by separate passes.
   *
   * The combined target owns no textures of its own: it aliases the attachments
   * of the named resources, so a later pass reading `GVelocity` by name sees
   * exactly what the water pass wrote. Sizes must match or the framebuffer would
   * be incomplete at the first draw rather than at boot.
   */
  mrtTarget(ids: readonly (RTId | string)[]): THREE.WebGLRenderTarget {
    if (ids.length === 0) throw new Error('RenderGraph.mrtTarget: needs at least one id');
    const key = ids.map(String).join('+');
    const existing = this.mrtTargets.get(key);
    if (existing) return existing;

    const primary = this.target(ids[0]);
    const combined = new THREE.WebGLRenderTarget(primary.width, primary.height, { count: ids.length });
    for (let i = 0; i < ids.length; i++) {
      const rt = this.target(ids[i]);
      if (rt.width !== primary.width || rt.height !== primary.height) {
        throw new Error(
          `RenderGraph.mrtTarget(${key}): "${String(ids[i])}" is ${rt.width}×${rt.height} but ` +
            `"${String(ids[0])}" is ${primary.width}×${primary.height}. Every id must share a scale.`,
        );
      }
      combined.textures[i] = rt.textures?.[0] ?? rt.texture;
    }
    // Depth, and therefore the depth TEST this pass draws under, is inherited
    // from ids[0] — water must depth-test against the opaque scene it is
    // refracting, not against a fresh buffer.
    combined.depthBuffer = primary.depthBuffer;
    if (primary.depthTexture) combined.depthTexture = primary.depthTexture;
    this.mrtTargets.set(key, combined);
    return combined;
  }

  texture(id: RTId | string, attachment = 0): THREE.Texture {
    const rt = this.target(id);
    const textures = rt.textures;
    if (textures && textures.length > attachment) return textures[attachment];
    return rt.texture;
  }

  history(id: RTId | string): RTHistory {
    const res = this.resource(id);
    if (!res.desc.history) throw new Error(`RenderGraph: "${String(id)}" is not declared as a history resource`);
    if (!res.current) res.current = this.allocate(res);
    if (!res.previous) res.previous = this.allocate(res);
    return { current: res.current, previous: res.previous, valid: res.valid };
  }


  get renderTargetBytes(): number {
    let total = 0;
    for (const res of this.resources.values()) if (res.current) total += res.bytes;
    return total;
  }

  /* ------------------------------------------------------------------- passes */

  addPass(pass: RenderPass): void {
    if (this.passList.some((p) => p.id === pass.id)) {
      throw new Error(`RenderGraph: pass "${pass.id}" registered twice`);
    }
    this.passList.push(pass);
    this.passesDirty = true;
    pass.setup?.(this, this.quality());
    pass.resize?.(this.width, this.height);
  }

  removePass(id: string): void {
    const i = this.passList.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.passList[i].dispose?.();
    this.passList.splice(i, 1);
  }

  get passes(): readonly string[] {
    this.sortPasses();
    return this.passList.map((p) => p.id);
  }

  private sortPasses(): void {
    if (!this.passesDirty) return;
    this.passList.sort((a, b) => {
      if (a.order !== b.order) return (a.order as number) - (b.order as number);
      return (a.subOrder ?? 0) - (b.subOrder ?? 0);
    });
    this.passesDirty = false;
  }

  /**
   * Runs at BOOT, never mid-frame. Throws if an enabled pass reads a resource
   * that no earlier enabled pass wrote — so disabling volumetrics on Low cannot
   * silently produce a black composite that nobody notices until review.
   */
  validate(): void {
    this.sortPasses();
    const q = this.quality();
    const written = new Set<string>();
    // A resource declared with a clear colour is defined before anything runs.
    for (const [id, res] of this.resources) {
      if (res.desc.clearColor !== undefined && res.desc.clearColor !== null) written.add(id);
      if (res.desc.history) written.add(id);
    }
    const problems: string[] = [];
    for (const pass of this.passList) {
      if (!pass.enabled(q)) continue;
      for (const r of pass.reads) {
        const id = String(r);
        if (!this.resources.has(id)) {
          problems.push(`pass "${pass.id}" reads undeclared resource "${id}"`);
        } else if (!written.has(id)) {
          problems.push(`pass "${pass.id}" reads "${id}" before any enabled pass writes it`);
        }
      }
      for (const w of pass.writes) written.add(String(w));
    }
    if (problems.length > 0) {
      throw new Error(`RenderGraph.validate() failed:\n  ${problems.join('\n  ')}`);
    }
  }

  /* ------------------------------------------------------------------ drawing */

  /**
   * Fullscreen triangle. `fragment` is the BODY of `main()`; see
   * `composeFullscreenFragment` for the exact protocol, which is the same one
   * `GpuBakeDesc.fragment` uses.
   */
  fullscreen(
    key: string,
    fragment: string,
    uniforms: Record<string, GpuUniform>,
    dest: THREE.WebGLRenderTarget | null,
    opts?: Readonly<FullscreenOpts>,
  ): void {
    let material = this.fullscreenCache.get(key);
    if (!material) {
      const outputs = Math.max(1, opts?.outputs ?? 1);
      material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: composeFullscreenFragment(fragment, opts?.prelude ?? '', outputs),
        uniforms: {
          // Always present, so a body may use it without declaring it.
          uResolution: { value: new THREE.Vector2(1, 1) },
          ...(uniforms as { [k: string]: THREE.IUniform }),
        },
        defines: { ...(opts?.defines ?? {}) },
        depthTest: false,
        depthWrite: false,
      });
      applyBlend(material, opts?.blend ?? 'opaque');
      this.fullscreenCache.set(key, material);
    } else {
      for (const [k, v] of Object.entries(uniforms)) {
        if (material.uniforms[k]) material.uniforms[k].value = v.value;
        else material.uniforms[k] = v as THREE.IUniform;
      }
    }
    const res = material.uniforms.uResolution?.value as THREE.Vector2 | undefined;
    if (res) res.set(dest ? dest.width : this.nativeWidth, dest ? dest.height : this.nativeHeight);
    this.fullscreenMesh.material = material;
    this.fullscreenMesh.geometry.setDrawRange(0, 3);
    this.renderer.setRenderTarget(dest);
    this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
    this.renderer.setRenderTarget(null);
  }

  blit(src: THREE.Texture, dest: THREE.WebGLRenderTarget | null): void {
    if (!this.blitMaterial) {
      this.blitMaterial = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: /* glsl */ `
          precision highp float;
          in vec2 vUv;
          uniform sampler2D uSrc;
          out vec4 outColor;
          void main() { outColor = texture(uSrc, vUv); }
        `,
        uniforms: { uSrc: { value: null } },
        depthTest: false,
        depthWrite: false,
      });
    }
    this.blitMaterial.uniforms.uSrc.value = src;
    this.fullscreenMesh.material = this.blitMaterial;
    this.fullscreenMesh.geometry.setDrawRange(0, 3);
    this.renderer.setRenderTarget(dest);
    this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
    this.renderer.setRenderTarget(null);
  }

  /**
   * Draw one RenderLayer's visible set. Layers map onto three's own 32-channel
   * `Object3D.layers` mask, so selecting a layer is a camera mask change rather
   * than a scene-graph walk toggling `.visible` on thousands of objects.
   *
   * Clears `dest` first, which is the contract every other lane codes against.
   * **It COMPOSITES: it does not clear colour and it does not clear depth.**
   *
   * The day-0 implementation cleared both, because it inherited the renderer's
   * `autoClear` and nothing else wrote `SceneColor` yet. That stopped being
   * harmless the moment the forward chain landed: `SceneColor` is now bound by
   * six passes in a frame (opaque, decals, sky, water, transparent, viewmodel),
   * and a lane compositing into it — water drawing its surface over the world,
   * decals drawing into it — was silently erasing every pass before it. It also
   * threw away the depth buffer the world was drawn with, so the water surface
   * could not be occluded by the quay in front of it.
   *
   * Compositing is the only semantic that can be right for a shared target, and
   * a lane that genuinely owns its own target is drawing into a resource nobody
   * else writes, where the previous frame's contents are its own and clearing is
   * its decision to make.
   */
  drawLayer(
    ctx: FrameCtx,
    layer: RenderLayer,
    dest: THREE.WebGLRenderTarget | null,
    override?: THREE.Material | null,
  ): void {
    this.drawLayers(ctx, [layer], dest, { override: override ?? null });
  }

  /**
   * The multi-layer, clear-controlled, jitter-aware draw the post chain is built
   * on. Not on the `RenderGraph` interface: a content lane wanting a custom draw
   * has `drawLayer`/`drawScene`, and everything here is a decision only the
   * frame's owner is allowed to make.
   *
   * Three things it does that `drawLayer` cannot:
   *
   *  - **Clear control.** A frame binds `SceneColor` five times (opaque, decals,
   *    sky, water, transparent, viewmodel). If every bind cleared, only the last
   *    one would survive.
   *  - **TAA jitter.** The camera keeps an UNJITTERED `projectionMatrix` so
   *    culling, world-to-screen and velocity are all correct; the sub-pixel
   *    offset is installed on the three camera for the duration of the draw and
   *    removed immediately after. Getting this backwards is the classic
   *    "TAA is soft and nobody can say why" bug.
   *  - **Group suppression.** The depth prepass runs an override material over
   *    `WorldOpaque`, and the sky dome lives on that layer with a vertex shader
   *    that pins it to the far plane. Under an override it would instead be a
   *    2 m box at the world origin, punching a hole in `SceneDepth`.
   */
  drawLayers(
    ctx: FrameCtx,
    layers: readonly RenderLayer[],
    dest: THREE.WebGLRenderTarget | null,
    opts: {
      override?: THREE.Material | null;
      clearColor?: boolean;
      clearDepth?: boolean;
      viewmodelCamera?: boolean;
      jitter?: boolean;
      /** Scene groups hidden for the duration of the draw. */
      hideGroups?: readonly THREE.Object3D[];
    } = {},
  ): void {
    const renderer = this.renderer;
    const viewmodel = opts.viewmodelCamera === true;
    const camera = viewmodel ? ctx.camera.viewmodel : ctx.camera.world;

    const previousAutoClear = renderer.autoClear;
    const previousOverride = this.scene.root.overrideMaterial;
    const previousMask = camera.layers.mask;
    renderer.autoClear = false;

    const restoreProjection = TMP_PROJECTION;
    let jittered = false;
    if (opts.jitter === true) {
      restoreProjection.copy(camera.projectionMatrix);
      camera.projectionMatrix.copy(
        viewmodel ? this.viewmodelJitter(ctx, camera) : (ctx.camera.jitteredProjection as THREE.Matrix4),
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      jittered = true;
    }

    const hidden = opts.hideGroups;
    if (hidden) {
      for (let i = 0; i < hidden.length; i++) {
        TMP_VISIBILITY[i] = hidden[i].visible;
        hidden[i].visible = false;
      }
    }
    if (opts.override !== undefined) this.scene.root.overrideMaterial = opts.override;

    renderer.setRenderTarget(dest);
    if (opts.clearColor === true || opts.clearDepth === true) {
      renderer.clear(opts.clearColor === true, opts.clearDepth === true, false);
    }

    for (const layer of layers) {
      camera.layers.set(layer as number);
      renderer.render(this.scene.root, camera);
    }
    renderer.setRenderTarget(null);

    if (hidden) for (let i = 0; i < hidden.length; i++) hidden[i].visible = TMP_VISIBILITY[i];
    this.scene.root.overrideMaterial = previousOverride;
    camera.layers.mask = previousMask;
    renderer.autoClear = previousAutoClear;
    if (jittered) {
      camera.projectionMatrix.copy(restoreProjection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
  }

  /**
   * The viewmodel camera's own jittered projection. It must carry the SAME
   * sub-pixel offset as the world camera or the two halves of the frame
   * converge against different sample grids and the seam between them crawls.
   */
  private viewmodelJitter(ctx: FrameCtx, camera: THREE.PerspectiveCamera): THREE.Matrix4 {
    TMP_VM_PROJECTION.copy(camera.projectionMatrix);
    TMP_VM_PROJECTION.elements[8] += (ctx.camera.jitter.x * 2) / Math.max(1, this.width);
    TMP_VM_PROJECTION.elements[9] += (ctx.camera.jitter.y * 2) / Math.max(1, this.height);
    return TMP_VM_PROJECTION;
  }

  /**
   * Draw a lane-owned object tree with a lane-owned camera.
   *
   * The HUD is the reason this exists and DebugService is the second: both are
   * orthographic screen-space overlays, and `drawLayer` can only ever submit the
   * culled WORLD set through the perspective `FrameCtx.camera`. Without this
   * call the only compiling answers are a fullscreen shader looping over glyph
   * instances (~100× over the 0.15 ms budget for pass 27) or a lane calling
   * `renderer.render()` itself, which is a §4.2 violation that the CI grep does
   * not catch.
   *
   * `clear` defaults to false so the draw COMPOSITES over `dest` — the HUD over
   * `LdrColor`. The graph keeps ownership of the binding and of autoClear.
   */
  drawScene(
    ctx: FrameCtx,
    scene: THREE.Object3D,
    camera: THREE.Camera,
    dest: THREE.WebGLRenderTarget | null,
    clear = false,
  ): void {
    void ctx;
    const previousAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = clear;
    this.renderer.setRenderTarget(dest);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = previousAutoClear;
  }

  /* ------------------------------------------------------------------ execute */

  execute(ctx: FrameCtx): void {
    this.sortPasses();
    // A frame binds the renderer six or seven times, and three re-renders every
    // shadow map on EVERY `render()` call while `autoUpdate` is on. Taking
    // ownership of the flag here turns that into once per frame — same result,
    // a sixth of the cost — and is the only place in the repo that knows how
    // many times the scene is submitted.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    if (this.passList.length === 0) {
      this.executeFallback(ctx);
    } else {
      const q = ctx.quality;
      for (const pass of this.passList) {
        // Asked EVERY frame, not cached at boot, so a mid-session tier change
        // takes effect on the next frame rather than the next reload.
        if (!pass.enabled(q)) continue;
        pass.execute(ctx, this);
      }
    }
    // Unconditional, including on the day-0 fallback path: a lane may own a
    // history resource driven from a Simulate pass long before RCORE's post
    // chain lands, and a history that never swaps is a simulation that never
    // advances.
    this.swapHistories();
  }

  /**
   * Swap EVERY history resource once, after the last pass. The graph owns this,
   * not the passes: a resource read by two passes would otherwise flip halfway
   * through the frame, and if the owning pass were expected to ask and forgot,
   * its simulation would silently freeze. A pass therefore reads `previous` and
   * writes `current`, always, and never thinks about it again.
   */
  private swapHistories(): void {
    for (const res of this.resources.values()) {
      if (!res.desc.history || !res.current || !res.previous) continue;
      const tmp = res.current;
      res.current = res.previous;
      res.previous = tmp;
      res.valid = true;
    }
  }

  /**
   * DAY-0 PATH ONLY. A straight forward render of the whole scene graph to the
   * default framebuffer, with the viewmodel drawn afterwards through its own
   * near camera so it cannot clip world geometry.
   *
   * This disappears the moment RCORE registers `forward.opaque` and `present`.
   * It exists so that fifteen other lanes are not blocked on the post chain to
   * see their own work.
   */
  private executeFallback(ctx: FrameCtx): void {
    const renderer = this.renderer;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    const camera = ctx.camera.world;
    const previousMask = camera.layers.mask;
    camera.layers.enableAll();
    camera.layers.disable(RenderLayer.Viewmodel as number);
    renderer.render(this.scene.root, camera);
    camera.layers.mask = previousMask;

    if (ctx.services.renderer.overlays.viewmodel) {
      const vm = ctx.camera.viewmodel;
      const vmMask = vm.layers.mask;
      vm.layers.set(RenderLayer.Viewmodel as number);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.scene.root, vm);
      renderer.autoClear = true;
      vm.layers.mask = vmMask;
    }
  }

  /* -------------------------------------------------------------------- state */

  /**
   * `width`/`height` are the INTERNAL render resolution (canvas × renderScale);
   * `nativeW`/`nativeH` are the canvas drawing buffer, which renderScale never
   * touches. Both are needed: a `RTDesc.native` target follows the second while
   * everything else follows the first.
   */
  setSize(width: number, height: number, nativeW = width, nativeH = height): void {
    const sameNative = nativeW === this.nativeWidth && nativeH === this.nativeHeight;
    if (width === this.width && height === this.height && sameNative) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.nativeWidth = Math.max(1, nativeW);
    this.nativeHeight = Math.max(1, nativeH);
    // A combined MRT framebuffer aliases textures that are about to be resized
    // under it, so drop the cache and let the next pass rebuild it. NOT
    // disposed: `dispose()` on the combination would delete the GL textures it
    // merely borrows, and the resources that actually own them would go blank.
    this.mrtTargets.clear();
    for (const res of this.resources.values()) {
      if (res.desc.size) continue; // absolute-sized LUTs and atlases do not scale
      const [w, h] = this.sizeOf(res.desc);
      res.current?.setSize(w, h);
      res.previous?.setSize(w, h);
      res.valid = false;
    }
    for (const pass of this.passList) pass.resize?.(this.width, this.height);
  }

  /**
   * Clears EVERY temporal history: TAA, SSR, GTAO, clouds, volumetrics,
   * exposure. Called by the harness driver at the top of every capture — a
   * history that survives across shots makes the PNG depend on capture ORDER,
   * which is the single most expensive class of bug on this project because it
   * sends the visual critics chasing ghosts.
   */
  resetHistories(): void {
    const previousTarget = this.renderer.getRenderTarget();
    for (const res of this.resources.values()) {
      if (!res.desc.history) continue;
      res.valid = false;
      for (const rt of [res.current, res.previous]) {
        if (!rt) continue;
        this.renderer.setRenderTarget(rt);
        this.renderer.clear(true, true, false);
      }
    }
    this.renderer.setRenderTarget(previousTarget);
  }

  /**
   * Read a 1×1 RGBA32F target back to the CPU.
   *
   * Exactly one caller: auto-exposure, which must publish its result on
   * `CameraState.exposureEv` for lanes that have no shader to sample it from.
   * A readback is a pipeline stall, so it is one pixel, and P22 reads the
   * PREVIOUS frame's value rather than the one just written.
   */
  readPixel(id: RTId | string, out: Float32Array): boolean {
    const res = this.resources.get(String(id));
    const rt = res?.desc.history ? res.previous : res?.current;
    if (!rt) return false;
    try {
      this.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, out);
      return true;
    } catch {
      // Some drivers refuse float readback outright. Losing the CPU-side mirror
      // of the exposure is cosmetic; the shaders sample the texture directly.
      return false;
    }
  }

  dispose(): void {
    for (const res of this.resources.values()) {
      res.current?.dispose();
      res.previous?.dispose();
    }
    this.resources.clear();
    for (const m of this.fullscreenCache.values()) m.dispose();
    this.fullscreenCache.clear();
    this.blitMaterial?.dispose();
  }
}

const TMP_PROJECTION = new THREE.Matrix4();
const TMP_VM_PROJECTION = new THREE.Matrix4();
const TMP_VISIBILITY: boolean[] = [];

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * RCORE: replace the BODY of this file, keep this signature and this path.
 */
export function createRenderGraph(ctx: BootContext): IronRenderGraph {
  return new IronRenderGraph(ctx.renderer, ctx.services.scene, () => ctx.quality.settings);
}

/** Passes bake their own LUTs (blue noise, Halton tables) through here. */
export function registerGraphBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The null graph bakes nothing.
}

/**
 * Harness reset chain. `resetHistories()` already runs earlier in the chain from
 * `src/engine/driver.ts`; this hook exists for anything a PASS holds that is not
 * an `RTHistory` — accumulated frame counters, jitter phase, exposure state.
 */
export function resetGraph(_seed: number): void {
  // The null graph holds no per-pass counters.
}
