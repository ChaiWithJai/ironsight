/**
 * WebGLRenderer bootstrap. CORE owns this file.
 *
 * Everything here is a decision that must be made BEFORE any lane allocates a
 * texture or a render target, which is why it is CORE's and not RCORE's.
 *
 * THE FOUR THINGS THAT MATTER
 * ---------------------------
 * 1. `EXT_color_buffer_float` is requested explicitly, immediately after the
 *    context exists. three requests it for its R16F/RG16F/RGBA16F paths but NOT
 *    for R11G11B10F, which is the Low tier's scene-colour format — without this
 *    line every HDR target on Low comes back framebuffer-incomplete, silently.
 * 2. Colour management ON, output colour space sRGB. Three's default has been
 *    correct since r152, but stating it here makes the invariant greppable and
 *    survives a version bump that changes a default.
 * 3. Tonemapping is AgX, not ACES. The ACES RRT pushes this brief's warm
 *    sandstone/ochre palette straight into orange hue-clipping at the top of the
 *    range — the "everything is orange" tell. Once RCORE's `post.tonemap` pass
 *    lands, the RENDERER's tonemapping is switched off (the pass does it in the
 *    correct place, before the HUD) via `setTonemapOwnedByGraph`.
 * 4. `antialias: false`. MSAA on the default framebuffer is incompatible with
 *    the deferred-ish post chain and would be paid for twice; TAA is the AA.
 * 5. `sortObjects = true`. This used to be `false`, on the theory that "the graph
 *    submits in a precomputed material order". It does not, and cannot: the graph
 *    orders LAYERS — it calls `renderer.render()` once per `RenderLayer` — and
 *    has no say at all in the order of the draws INSIDE one of those calls. With
 *    sorting off, three emits a layer in scene-graph traversal order, and two
 *    things silently break.
 *
 *    First, alpha blending stops being correct. `over` compositing is not
 *    commutative, so `RenderLayer.TransparentPreTaa` — whose contract in
 *    types.ts is literally "sorted forward" — was compositing a dust card that
 *    happens to sit behind a smoke plume ON TOP of it, because the dust pool was
 *    added to the scene first. Every blended surface in the frame inherited the
 *    wrong occlusion ordering from whatever order the lanes happened to boot in,
 *    and the symptom is a translucent surface that veils things it is behind:
 *    a milky panel with hard geometric edges and no local contrast under it.
 *
 *    Second — and this is the part that made it hard to see — `renderOrder` is
 *    only consulted by the sort, so with the sort off it is dead code. Six lanes
 *    set it and none of them were getting it: sky dome −1000, VFX glow/soft/
 *    streak 5/10/20, god rays 3000, AI path debug 900, audio overlay 1000,
 *    telemetry 10000. Those numbers are each lane's statement about what
 *    composites over what, and they only mean something now.
 *
 *    The cost is the reason it was turned off, and that reason does not survive
 *    contact with this scene: every static in the world goes through
 *    `SceneGraph.batch`, which emits ONE `BatchedMesh` per material, so a layer
 *    is a few hundred render items rather than the tens of thousands the 0.4 ms
 *    figure assumed. Sorting that is microseconds, and it is deterministic —
 *    Array.prototype.sort is stable and the camera is frozen during a capture,
 *    so shots stay bit-comparable.
 */
import * as THREE from 'three';

export interface RendererBootstrap {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** True when `EXT_color_buffer_float` is present. Nothing HDR works without it. */
  colorBufferFloat: boolean;
}

export function createRenderer(container: HTMLElement): RendererBootstrap {
  const canvas = document.createElement('canvas');
  canvas.id = 'ironsight-canvas';
  // The capture tool screenshots `document.querySelector('canvas')` — the FIRST
  // canvas in the document. This one is appended before anything else exists,
  // and the debug overlay deliberately uses SVG rather than a second canvas.
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    // The capture grabs the canvas after the loop is suspended, so the drawing
    // buffer must survive the compositor's copy rather than being discarded on
    // the swap that never comes.
    preserveDrawingBuffer: true,
    failIfMajorPerformanceCaveat: false,
  });

  const gl = renderer.getContext() as WebGL2RenderingContext;
  // ↓ See note 1. Do not remove, do not move after target allocation.
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  gl.getExtension('EXT_float_blend');
  gl.getExtension('OES_texture_float_linear');

  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;

  renderer.shadowMap.enabled = true;
  // PCFSoft is the day-0 filter; LIGHT replaces the whole shadow path with a
  // cascaded atlas and a PCSS contact-hardening filter.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  renderer.setPixelRatio(1);
  renderer.setClearColor(0x0a0f14, 1);
  renderer.autoClear = true;
  // ↓ See note 5.
  renderer.sortObjects = true;
  // Opaque: group by program, then front-to-back. Identical to three's default
  // painter sort except that `z` is compared BEFORE the material id, so the
  // depth prepass' early-z is fed the nearest surfaces first. With a prepass in
  // front of it the win is small; the reason it is spelled out rather than left
  // to the default is that it documents which half of the sort is a performance
  // choice (this one) and which half is a correctness requirement (the other).
  renderer.setOpaqueSort((a, b) => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    if (a.z !== b.z) return a.z - b.z;
    return a.id - b.id;
  });

  return { renderer, canvas, colorBufferFloat };
}

/**
 * Hand tonemapping over to RCORE's `post.tonemap` pass. Called by that pass'
 * `setup()`. Leaving both enabled double-tonemaps the frame, which looks like a
 * washed-out grade rather than like a bug.
 */
export function setTonemapOwnedByGraph(renderer: THREE.WebGLRenderer, owned: boolean): void {
  renderer.toneMapping = owned ? THREE.NoToneMapping : THREE.AgXToneMapping;
}
