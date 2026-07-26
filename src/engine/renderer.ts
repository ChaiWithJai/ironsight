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
  // `sortObjects = false`: the graph submits in a precomputed material order,
  // which saves ~0.4 ms of CPU sort per frame and is the ordering the passes
  // actually depend on.
  renderer.sortObjects = false;

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
