/**
 * The bake device's private WebGL2 layer.
 *
 * OWNER: BAKE.
 *
 * WHY RAW GL RATHER THAN three's RENDER TARGETS
 * ---------------------------------------------
 * `RenderGraph` is declared the ONLY code that may call `renderer.setRenderTarget`,
 * and boundary CI enforces it — for a good reason: the graph owns render-target
 * lifetimes for the whole frame and a lane that binds one behind its back
 * silently corrupts a later pass's input. The bake device is not an exception to
 * that rule; it sidesteps it entirely. It allocates its OWN framebuffer, its own
 * textures and its own programs, runs before the graph exists (bakes complete
 * before any subsystem but `assets` is constructed), and hands three's renderer
 * back a clean state cache via `resetState()` when it is finished.
 *
 * The second reason is capability: the bake needs MRT into mixed formats,
 * rendering into an individual mip LEVEL (for the Toksvig chain), layered writes
 * and `readPixels` — every one of which is either awkward or unreachable through
 * `WebGLRenderTarget`.
 *
 * Outputs are handed out as `THREE.ExternalTexture`, which is three's sanctioned
 * wrapper for a `WebGLTexture` created in the same context: three binds it and
 * never tries to upload over it. Sampler state is therefore ours to set, once,
 * at creation.
 */
import * as THREE from 'three';
import { RTFormat } from '@/engine/types';

/* ----------------------------------------------------------------- formats -- */

export interface GlFormat {
  readonly internalFormat: number;
  readonly format: number;
  readonly type: number;
  readonly bytesPerTexel: number;
  readonly channels: number;
  readonly float: boolean;
  readonly srgb: boolean;
}

/** Typed-array flavour `readPixels` must be given for a format. */
export type PixelArray = Uint8Array | Uint16Array | Float32Array;

export function glFormat(gl: WebGL2RenderingContext, f: RTFormat): GlFormat {
  switch (f) {
    case RTFormat.R8:
      return { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, bytesPerTexel: 1, channels: 1, float: false, srgb: false };
    case RTFormat.RG8:
      return { internalFormat: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE, bytesPerTexel: 2, channels: 2, float: false, srgb: false };
    case RTFormat.RGBA8_SRGB:
      return { internalFormat: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerTexel: 4, channels: 4, float: false, srgb: true };
    case RTFormat.RGB10A2:
      return { internalFormat: gl.RGB10_A2, format: gl.RGBA, type: gl.UNSIGNED_INT_2_10_10_10_REV, bytesPerTexel: 4, channels: 4, float: false, srgb: false };
    case RTFormat.R16F:
      return { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, bytesPerTexel: 2, channels: 1, float: true, srgb: false };
    case RTFormat.RG16F:
      return { internalFormat: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT, bytesPerTexel: 4, channels: 2, float: true, srgb: false };
    case RTFormat.RGBA16F:
      return { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bytesPerTexel: 8, channels: 4, float: true, srgb: false };
    case RTFormat.R11G11B10F:
      return { internalFormat: gl.R11F_G11F_B10F, format: gl.RGB, type: gl.UNSIGNED_INT_10F_11F_11F_REV, bytesPerTexel: 4, channels: 3, float: true, srgb: false };
    case RTFormat.R32F:
      return { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, bytesPerTexel: 4, channels: 1, float: true, srgb: false };
    case RTFormat.RGBA32F:
      return { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bytesPerTexel: 16, channels: 4, float: true, srgb: false };
    default:
      return { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerTexel: 4, channels: 4, float: false, srgb: false };
  }
}

/* ---------------------------------------------------------------- textures -- */

export interface BakeTexture {
  /** Handed to other lanes. `sourceTexture` is the GL object below. */
  readonly texture: THREE.Texture;
  readonly handle: WebGLTexture;
  readonly target: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly levels: number;
  readonly fmt: GlFormat;
  readonly bytes: number;
}

export interface TextureOptions {
  readonly wrap?: 'repeat' | 'clamp';
  readonly filter?: 'nearest' | 'linear';
  readonly levels?: number;
  readonly anisotropy?: number;
  readonly depth?: number;
}

export function mipLevelsFor(width: number, height: number): number {
  return Math.max(1, Math.floor(Math.log2(Math.max(width, height))) + 1);
}

/* ------------------------------------------------------------------ device -- */

const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // One oversized triangle: no diagonal seam, no doubled quad-shading along it.
  vUv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, { location: WebGLUniformLocation; type: number; size: number }>;
}

/**
 * A tiny, self-contained GL2 harness: one framebuffer, one empty VAO, a program
 * cache keyed by source, and a texture allocator. Nothing here touches three's
 * state machine except `renderer.resetState()` on `finish()`.
 */
export class BakeGl {
  readonly gl: WebGL2RenderingContext;
  readonly floatRenderable: boolean;
  readonly floatLinear: boolean;
  readonly maxAnisotropy: number;

  private readonly programs = new Map<string, ProgramInfo>();
  private readonly fbo: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly anisoExt: { TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  /**
   * WebGL2 only guarantees FOUR colour attachments; SwiftShader reports exactly
   * four. Detaching COLOR_ATTACHMENT4..7 unconditionally is an INVALID_ENUM per
   * draw, which is harmless but floods the console and buries real errors behind
   * "too many errors, no more errors will be reported".
   */
  private readonly maxColorAttachments: number;
  private readonly owned: BakeTexture[] = [];
  private residentBytes = 0;
  private dirty = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const ctx = renderer.getContext();
    this.gl = ctx as WebGL2RenderingContext;
    const gl = this.gl;
    // three requests EXT_color_buffer_float only for some format paths, and the
    // bake needs it for every intermediate height/derivative field. Asking again
    // is free and idempotent.
    this.floatRenderable = gl.getExtension('EXT_color_buffer_float') !== null;
    this.floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxColorAttachments = Math.max(4, (gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number) | 0);
    this.maxAnisotropy = this.anisoExt
      ? (gl.getParameter(0x84ff) as number)
      : 1;
    const fbo = gl.createFramebuffer();
    const vao = gl.createVertexArray();
    if (!fbo || !vao) throw new Error('BakeGl: could not allocate a framebuffer/VAO');
    this.fbo = fbo;
    this.vao = vao;
  }

  get bytesResident(): number {
    return this.residentBytes;
  }

  /**
   * Formats fall back rather than failing: a device without
   * `EXT_color_buffer_float` gets RGBA8 and a softer height field, which is a
   * quality regression. A framebuffer-incomplete bake is a black texture in
   * every material in the game.
   */
  resolveFormat(f: RTFormat): RTFormat {
    if (!this.floatRenderable) {
      switch (f) {
        case RTFormat.R16F:
        case RTFormat.R32F:
          return RTFormat.R8;
        case RTFormat.RG16F:
          return RTFormat.RG8;
        case RTFormat.RGBA16F:
        case RTFormat.RGBA32F:
        case RTFormat.R11G11B10F:
          return RTFormat.RGBA8;
        default:
          return f;
      }
    }
    return f;
  }

  /* ------------------------------------------------------------ textures -- */

  createTexture(width: number, height: number, format: RTFormat, opts: TextureOptions = {}): BakeTexture {
    const gl = this.gl;
    const fmt = glFormat(gl, this.resolveFormat(format));
    const depth = opts.depth ?? 1;
    const target = depth > 1 ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    const levels = Math.max(1, Math.min(opts.levels ?? 1, mipLevelsFor(width, height)));
    const handle = gl.createTexture();
    if (!handle) throw new Error('BakeGl: out of texture handles');
    gl.bindTexture(target, handle);
    if (target === gl.TEXTURE_3D) {
      gl.texStorage3D(target, levels, fmt.internalFormat, width, height, depth);
    } else {
      gl.texStorage2D(target, levels, fmt.internalFormat, width, height);
    }
    const wrap = opts.wrap === 'clamp' ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, wrap);
    // A float texture is only linearly filterable with OES_texture_float_linear;
    // asking for LINEAR without it silently makes the texture incomplete and
    // every sample returns black.
    const wantLinear = (opts.filter ?? 'linear') === 'linear' && (!fmt.float || this.floatLinear);
    const mag = wantLinear ? gl.LINEAR : gl.NEAREST;
    const min = levels > 1 ? (wantLinear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : mag;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, levels - 1);
    if (this.anisoExt && opts.anisotropy && opts.anisotropy > 1 && !fmt.float) {
      gl.texParameterf(target, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(opts.anisotropy, this.maxAnisotropy));
    }
    gl.bindTexture(target, null);

    const external = new THREE.ExternalTexture(handle);
    external.colorSpace = fmt.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    external.wrapS = opts.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    external.wrapT = external.wrapS;
    external.generateMipmaps = false;
    // 4/3 accounts for the mip tail; exact enough for a VRAM budget check.
    const bytes = Math.round(width * height * depth * fmt.bytesPerTexel * (levels > 1 ? 4 / 3 : 1));
    const tex: BakeTexture = { texture: external, handle, target, width, height, depth, levels, fmt, bytes };
    this.owned.push(tex);
    this.residentBytes += bytes;
    return tex;
  }

  /* ------------------------------------------------------------ programs -- */

  program(fragmentSource: string, defines: Record<string, string | number> | undefined): ProgramInfo {
    const defineBlock = defines
      ? Object.entries(defines)
          .map(([k, v]) => `#define ${k} ${v}`)
          .join('\n')
      : '';
    const source = `#version 300 es\n${defineBlock}\n${fragmentSource}`;
    const cached = this.programs.get(source);
    if (cached) return cached;
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, FULLSCREEN_VS);
    const fs = this.compile(gl.FRAGMENT_SHADER, source);
    const program = gl.createProgram();
    if (!program) throw new Error('BakeGl: could not create a program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`BakeGl: link failed — ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const uniforms = new Map<string, { location: WebGLUniformLocation; type: number; size: number }>();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      uniforms.set(name, { location, type: info.type, size: info.size });
    }
    const entry: ProgramInfo = { program, uniforms };
    this.programs.set(source, entry);
    return entry;
  }

  private compile(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error('BakeGl: could not create a shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '';
      // Numbered source: a bake fragment is a composed string (noise chunks +
      // prelude + body) and a bare "ERROR: 0:412" is unusable without it.
      const numbered = source
        .split('\n')
        .map((l, i) => `${String(i + 1).padStart(4, ' ')} | ${l}`)
        .join('\n');
      gl.deleteShader(shader);
      throw new Error(`BakeGl: shader compile failed\n${log}\n${numbered}`);
    }
    return shader;
  }

  /* --------------------------------------------------------------- draw -- */

  /**
   * Draw the fullscreen triangle into `targets` (one per colour attachment).
   * `level`/`layer` select a mip level and, for 3D textures, a z slice.
   */
  draw(
    frag: ProgramInfo,
    targets: readonly BakeTexture[],
    setUniforms: (set: UniformSetter) => void,
    level = 0,
    layer = -1,
  ): void {
    const gl = this.gl;
    this.dirty = true;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
    const buffers: number[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const attachment = gl.COLOR_ATTACHMENT0 + i;
      if (t.target === gl.TEXTURE_3D) {
        gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, attachment, t.handle, level, Math.max(0, layer));
      } else {
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, attachment, gl.TEXTURE_2D, t.handle, level);
      }
      buffers.push(attachment);
    }
    // Detach anything left over from a previous, wider MRT bake, or the driver
    // reports FRAMEBUFFER_INCOMPLETE_DIMENSIONS on the stale attachment.
    for (let i = targets.length; i < this.maxColorAttachments; i++) {
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    }
    gl.drawBuffers(buffers);
    const status = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`BakeGl: framebuffer incomplete (0x${status.toString(16)}) — check EXT_color_buffer_float`);
    }
    const w = Math.max(1, targets[0].width >> level);
    const h = Math.max(1, targets[0].height >> level);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.useProgram(frag.program);
    const setter = new UniformSetter(gl, frag);
    setter.set('uResolution', [w, h]);
    setUniforms(setter);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    setter.unbindTextures();
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /** Read one mip level of a texture back into a typed array. */
  read(tex: BakeTexture, level = 0, layer = -1): PixelArray {
    const gl = this.gl;
    this.dirty = true;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    if (tex.target === gl.TEXTURE_3D) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex.handle, level, Math.max(0, layer));
    } else {
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.handle, level);
    }
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const w = Math.max(1, tex.width >> level);
    const h = Math.max(1, tex.height >> level);
    // readPixels only accepts a small set of (format, type) pairs; RED/RG reads
    // are not universally supported, so everything comes back as RGBA and the
    // caller strips the channels it does not want.
    let out: PixelArray;
    if (tex.fmt.float) {
      out = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
    } else {
      out = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return out;
  }

  /**
   * Hand the GL state machine back to three. three caches bindings, the active
   * program, the bound framebuffer and blend/depth state; without this the first
   * frame after a bake renders with whatever the bake left behind, and the
   * symptom (a black or untextured first frame) looks like a renderer bug.
   */
  finish(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(null);
    gl.bindVertexArray(null);
    this.renderer.resetState();
  }

  /**
   * Destroy one texture early and reclaim its budget.
   *
   * Multi-pass bakes leave large float intermediates behind that are dead the
   * moment the derived set is written; without this they survive until
   * `dispose()` and the bake's peak VRAM is several times its steady state.
   * Idempotent — destroying an already-destroyed texture does nothing.
   */
  destroyTexture(tex: BakeTexture): void {
    const i = this.owned.indexOf(tex);
    if (i < 0) return;
    this.owned.splice(i, 1);
    this.residentBytes = Math.max(0, this.residentBytes - tex.bytes);
    this.gl.deleteTexture(tex.handle);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.owned) gl.deleteTexture(t.handle);
    this.owned.length = 0;
    this.residentBytes = 0;
    for (const p of this.programs.values()) gl.deleteProgram(p.program);
    this.programs.clear();
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
  }
}

/* ------------------------------------------------------------- uniforms --- */

/**
 * Sets uniforms by their DECLARED GLSL type, queried from the linked program.
 * We never infer the type from the JS value: `{ value: 0 }` is ambiguous between
 * `int`, `uint` and `float`, and guessing wrong is a silent no-op that shows up
 * as a black texture with no error anywhere.
 */
export class UniformSetter {
  private unit = 0;
  private readonly boundTargets: number[] = [];

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly info: ProgramInfo,
  ) {}

  has(name: string): boolean {
    return this.info.uniforms.has(name);
  }

  set(name: string, value: unknown): void {
    const u = this.info.uniforms.get(name);
    // Not an error: a bake body may not reference every uniform the caller
    // declared, and GLSL strips unused ones at link time.
    if (!u) return;
    const gl = this.gl;
    const loc = u.location;
    switch (u.type) {
      case gl.FLOAT:
        gl.uniform1f(loc, num(value));
        return;
      case gl.INT:
      case gl.BOOL:
        gl.uniform1i(loc, Math.round(num(value)));
        return;
      case gl.UNSIGNED_INT:
        gl.uniform1ui(loc, Math.round(num(value)) >>> 0);
        return;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(loc, vec(value, 2));
        return;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(loc, vec(value, 3));
        return;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(loc, vec(value, 4));
        return;
      case gl.INT_VEC2:
        gl.uniform2iv(loc, int(value, 2));
        return;
      case gl.INT_VEC3:
        gl.uniform3iv(loc, int(value, 3));
        return;
      case gl.INT_VEC4:
        gl.uniform4iv(loc, int(value, 4));
        return;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(loc, false, vec(value, 9));
        return;
      case gl.FLOAT_MAT4:
        gl.uniformMatrix4fv(loc, false, vec(value, 16));
        return;
      case gl.SAMPLER_2D:
      case gl.SAMPLER_3D: {
        const target = u.type === gl.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D;
        const handle = textureHandle(value);
        const unit = this.unit++;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(target, handle);
        gl.uniform1i(loc, unit);
        this.boundTargets.push(target);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Bind a texture for reading while a DIFFERENT mip level of the same texture
   * is the draw target. `base`/`max` clamp the sampler away from the level being
   * written, which is the only legal way to avoid a feedback loop.
   */
  setTextureLevels(name: string, tex: BakeTexture, base: number, max: number): void {
    const u = this.info.uniforms.get(name);
    if (!u) return;
    const gl = this.gl;
    const unit = this.unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(tex.target, tex.handle);
    gl.texParameteri(tex.target, gl.TEXTURE_BASE_LEVEL, base);
    gl.texParameteri(tex.target, gl.TEXTURE_MAX_LEVEL, max);
    gl.uniform1i(u.location, unit);
    this.boundTargets.push(tex.target);
  }

  unbindTextures(): void {
    const gl = this.gl;
    for (let i = 0; i < this.boundTargets.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(this.boundTargets[i], null);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.boundTargets.length = 0;
    this.unit = 0;
  }
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return 0;
}

const SCRATCH = new Float32Array(16);
const SCRATCH_I = new Int32Array(4);

function vec(v: unknown, n: number): Float32Array {
  const out = SCRATCH.subarray(0, n);
  out.fill(0);
  if (Array.isArray(v)) {
    for (let i = 0; i < Math.min(n, v.length); i++) out[i] = Number(v[i]);
    return out;
  }
  if (v instanceof Float32Array) {
    out.set(v.subarray(0, n));
    return out;
  }
  const o = v as Record<string, number> & { toArray?: (a: number[]) => number[]; elements?: number[] };
  if (o && Array.isArray(o.elements)) {
    for (let i = 0; i < Math.min(n, o.elements.length); i++) out[i] = o.elements[i];
    return out;
  }
  if (o && typeof o.x === 'number') {
    out[0] = o.x;
    if (n > 1) out[1] = o.y ?? 0;
    if (n > 2) out[2] = o.z ?? 0;
    if (n > 3) out[3] = o.w ?? 1;
    return out;
  }
  if (o && typeof o.r === 'number') {
    out[0] = o.r;
    if (n > 1) out[1] = o.g ?? 0;
    if (n > 2) out[2] = o.b ?? 0;
    if (n > 3) out[3] = 1;
    return out;
  }
  if (typeof v === 'number') out.fill(v);
  return out;
}

function int(v: unknown, n: number): Int32Array {
  const f = vec(v, n);
  const out = SCRATCH_I.subarray(0, n);
  for (let i = 0; i < n; i++) out[i] = Math.round(f[i]);
  return out;
}

function textureHandle(v: unknown): WebGLTexture | null {
  if (!v) return null;
  const asBake = v as { handle?: WebGLTexture };
  if (asBake.handle) return asBake.handle;
  const asExternal = v as { sourceTexture?: WebGLTexture; isExternalTexture?: boolean };
  if (asExternal.isExternalTexture && asExternal.sourceTexture) return asExternal.sourceTexture;
  return v as WebGLTexture;
}
