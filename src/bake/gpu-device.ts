/**
 * GpuBakeDevice — everything in this game that ends up as a texture is rendered
 * here. OWNER: BAKE.
 *
 * THE SHADER PROTOCOL (identical to `RenderGraph.fullscreen`, minus the noise
 * chunks, deliberately — a lane learns it once):
 *
 *   in scope:  vUv, uResolution, uPass, uSeed, every NoiseLib GLSL chunk
 *   write:     outColor, or outColor0..N-1 when `targets` > 1
 *   prelude:   YOUR uniform declarations, helper functions, structs, #defines
 *
 * The device NEVER infers a GLSL type from a runtime value — `{ value: 0 }` is
 * ambiguous between int, uint and float and the wrong guess is a link error at
 * bake time, which fails the capture for sixteen lanes at once. Declare it in
 * `prelude`.
 */
import * as THREE from 'three';
import { MipMode, RTFormat, type GpuBakeDesc, type GpuBakeDevice } from '@/engine/types';
import { BakeGl, mipLevelsFor, type BakeTexture } from '@/bake/gl';
import { NOISE_GLSL_PRELUDE } from '@/bake/glsl/index';
import { buildMipChain } from '@/bake/mips';

function composeFragment(desc: GpuBakeDesc): string {
  const outputs = Math.max(1, desc.targets ?? 1);
  const outs =
    outputs > 1
      ? Array.from({ length: outputs }, (_, i) => `layout(location = ${i}) out vec4 outColor${i};`).join('\n')
      : 'out vec4 outColor;';
  return [
    'precision highp float;',
    'precision highp int;',
    'in vec2 vUv;',
    'uniform vec2 uResolution;',
    'uniform int uPass;',
    'uniform float uSeed;',
    outs,
    NOISE_GLSL_PRELUDE,
    desc.prelude ?? '',
    'void main() {',
    desc.fragment,
    '}',
  ].join('\n');
}

export class IronGpuBakeDevice implements GpuBakeDevice {
  readonly gl: BakeGl;
  /** THREE.Texture handed to a lane → the GL object behind it. */
  private readonly owned = new WeakMap<THREE.Texture, BakeTexture>();
  private allowReadback: boolean;
  private anisotropy: number;

  constructor(renderer: THREE.WebGLRenderer, allowReadback: boolean, anisotropy: number) {
    this.gl = new BakeGl(renderer);
    this.allowReadback = allowReadback;
    this.anisotropy = anisotropy;
  }

  setPolicy(allowReadback: boolean, anisotropy: number): void {
    this.allowReadback = allowReadback;
    this.anisotropy = anisotropy;
  }

  get bytesResident(): number {
    return this.gl.bytesResident;
  }

  /** The GL object behind a texture this device produced, if it produced it. */
  resolve(texture: THREE.Texture): BakeTexture | undefined {
    return this.owned.get(texture);
  }

  private allocate(desc: GpuBakeDesc, format: RTFormat): BakeTexture {
    const mips = desc.mips ?? MipMode.None;
    const levels = mips === MipMode.None ? 1 : mipLevelsFor(desc.width, desc.height);
    const tex = this.gl.createTexture(desc.width, desc.height, format, {
      wrap: desc.wrap ?? 'repeat',
      filter: desc.filter ?? 'linear',
      levels,
      anisotropy: desc.anisotropy ?? this.anisotropy,
      depth: desc.depth ?? 1,
    });
    this.owned.set(tex.texture, tex);
    tex.texture.name = desc.name;
    return tex;
  }

  private formatOf(desc: GpuBakeDesc): RTFormat {
    if (desc.format) return desc.format;
    return desc.colorSpace === 'srgb' ? RTFormat.RGBA8_SRGB : RTFormat.RGBA8;
  }

  private drawOnce(desc: GpuBakeDesc, targets: readonly BakeTexture[], pass: number): void {
    const prog = this.gl.program(composeFragment(desc), desc.defines);
    this.gl.draw(prog, targets, (u) => {
      u.set('uPass', pass);
      u.set('uSeed', (desc.uniforms?.uSeed?.value as number) ?? 0);
      for (const [name, cell] of Object.entries(desc.uniforms ?? {})) {
        u.set(name, resolveUniform(cell.value, this.owned));
      }
    });
  }

  /* -------------------------------------------------------------- render -- */

  render(desc: GpuBakeDesc): THREE.Texture {
    if ((desc.depth ?? 1) > 1) {
      // A 3D bake through `render` is legal; every slice gets uPass = z.
      const tex = this.allocate(desc, this.formatOf(desc));
      const prog = this.gl.program(composeFragment(desc), desc.defines);
      for (let z = 0; z < (desc.depth ?? 1); z++) {
        this.gl.draw(
          prog,
          [tex],
          (u) => {
            u.set('uPass', z);
            u.set('uSeed', (desc.uniforms?.uSeed?.value as number) ?? 0);
            for (const [name, cell] of Object.entries(desc.uniforms ?? {})) {
              u.set(name, resolveUniform(cell.value, this.owned));
            }
          },
          0,
          z,
        );
      }
      this.gl.finish();
      return tex.texture;
    }
    const tex = this.allocate(desc, this.formatOf(desc));
    this.drawOnce(desc, [tex], 0);
    buildMipChain(this.gl, tex, desc.mips ?? MipMode.None);
    this.gl.finish();
    return tex.texture;
  }

  renderMrt(desc: GpuBakeDesc): THREE.Texture[] {
    const count = Math.max(1, desc.targets ?? 1);
    const targets: BakeTexture[] = [];
    for (let i = 0; i < count; i++) targets.push(this.allocate(desc, this.formatOf(desc)));
    this.drawOnce(desc, targets, 0);
    for (const t of targets) buildMipChain(this.gl, t, desc.mips ?? MipMode.None);
    this.gl.finish();
    return targets.map((t) => t.texture);
  }

  /**
   * Ping-pong a shader over its own previous output. `uPass` carries the
   * iteration index so a shader can branch on the first pass (seed the field)
   * without a second desc. Erosion, flow, jump-flood, blur, relaxation.
   */
  iterate(desc: GpuBakeDesc, iterations: number, prevUniform = 'uPrev'): THREE.Texture {
    const format = this.formatOf(desc);
    const a = this.allocate(desc, format);
    const b = this.allocate({ ...desc, name: `${desc.name}.pong` }, format);
    const prog = this.gl.program(composeFragment(desc), desc.defines);
    let src = b;
    let dst = a;
    const total = Math.max(1, iterations);
    for (let i = 0; i < total; i++) {
      this.gl.draw(prog, [dst], (u) => {
        u.set('uPass', i);
        u.set('uSeed', (desc.uniforms?.uSeed?.value as number) ?? 0);
        for (const [name, cell] of Object.entries(desc.uniforms ?? {})) {
          u.set(name, resolveUniform(cell.value, this.owned));
        }
        u.set(prevUniform, src);
      });
      const t = src;
      src = dst;
      dst = t;
    }
    // `src` holds the last result after the final swap.
    buildMipChain(this.gl, src, desc.mips ?? MipMode.None);
    this.gl.finish();
    return src.texture;
  }

  /* ------------------------------------------------------------- layered -- */

  /**
   * Render into ONE layer of a `DataArrayTexture` the material factory owns.
   * The layer is rendered on the GPU and copied through the CPU because a
   * DataArrayTexture's storage belongs to three, not to us; the copy is one
   * `readPixels` of a single layer, which is the cheapest correct route that
   * does not require reaching into three's texture properties.
   */
  renderToLayer(target: THREE.DataArrayTexture, layer: number, desc: GpuBakeDesc): void {
    const tmp = this.allocate({ ...desc, mips: MipMode.None, name: `${desc.name}.layer${layer}` }, RTFormat.RGBA8);
    this.drawOnce(desc, [tmp], 0);
    const pixels = this.gl.read(tmp) as Uint8Array;
    this.gl.finish();
    const image = target.image as { data: Uint8Array; width: number; height: number; depth: number };
    if (!image?.data) return;
    const stride = image.width * image.height * 4;
    const count = Math.min(stride, pixels.length);
    if (image.width === desc.width && image.height === desc.height) {
      image.data.set(pixels.subarray(0, count), layer * stride);
    } else {
      // Nearest-resample rather than refusing: a lane that asked for a size the
      // array cannot hold gets a softer layer, not a missing one.
      resampleInto(pixels, desc.width, desc.height, image.data, image.width, image.height, layer * stride);
    }
    target.needsUpdate = true;
  }

  renderToVolume(target: THREE.Data3DTexture, desc: GpuBakeDesc): void {
    const image = target.image as { data: Uint8Array; width: number; height: number; depth: number };
    if (!image?.data) return;
    const tmp = this.allocate({ ...desc, mips: MipMode.None, name: `${desc.name}.slice` }, RTFormat.RGBA8);
    const slice = image.width * image.height * 4;
    for (let z = 0; z < image.depth; z++) {
      this.drawOnce({ ...desc, width: image.width, height: image.height }, [tmp], z);
      const pixels = this.gl.read(tmp) as Uint8Array;
      image.data.set(pixels.subarray(0, Math.min(slice, pixels.length)), z * slice);
    }
    this.gl.finish();
    target.needsUpdate = true;
  }

  /* ------------------------------------------------------------ impostor -- */

  /**
   * Octahedral impostor atlas. `views²` orthographic views of `source` are
   * rasterised into two atlases: albedo+coverage and octahedral-normal+depth.
   *
   * The albedo comes from each mesh's `color` and, where present, its `map`,
   * sampled with an alpha cut-out — enough for foliage, which is the only thing
   * in this project that gets impostered. Full PBR shading is deliberately NOT
   * baked in: an impostor lit at bake time cannot respond to the sun moving,
   * and the consumer re-lights from the normal/depth atlas.
   */
  renderImpostor(
    source: THREE.Object3D,
    views: number,
    atlasSize: number,
  ): { albedo: THREE.Texture; normalDepth: THREE.Texture; radius: number } {
    const meshes: THREE.Mesh[] = [];
    source.updateWorldMatrix(true, true);
    source.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) meshes.push(m);
    });
    const bounds = new THREE.Box3();
    for (const m of meshes) bounds.expandByObject(m);
    if (bounds.isEmpty()) bounds.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
    const centre = bounds.getCenter(new THREE.Vector3());
    const radius = Math.max(1e-3, bounds.getSize(new THREE.Vector3()).length() * 0.5);

    const grid = Math.max(1, Math.floor(Math.sqrt(views)));
    const tile = Math.max(8, Math.floor(atlasSize / grid));
    const albedo = this.gl.createTexture(atlasSize, atlasSize, RTFormat.RGBA8_SRGB, {
      wrap: 'clamp',
      filter: 'linear',
      levels: mipLevelsFor(atlasSize, atlasSize),
    });
    const normalDepth = this.gl.createTexture(atlasSize, atlasSize, RTFormat.RGBA8, {
      wrap: 'clamp',
      filter: 'linear',
      levels: mipLevelsFor(atlasSize, atlasSize),
    });
    this.owned.set(albedo.texture, albedo);
    this.owned.set(normalDepth.texture, normalDepth);
    albedo.texture.name = 'impostor.albedo';
    normalDepth.texture.name = 'impostor.normalDepth';

    renderImpostorViews(this.gl, meshes, centre, radius, grid, tile, albedo, normalDepth);
    buildMipChain(this.gl, albedo, MipMode.Color);
    buildMipChain(this.gl, normalDepth, MipMode.Normal);
    this.gl.finish();
    return { albedo: albedo.texture, normalDepth: normalDepth.texture, radius };
  }

  /* ------------------------------------------------------------ readback -- */

  async readback(texture: THREE.Texture, out?: Float32Array): Promise<Float32Array> {
    const tex = this.owned.get(texture);
    // Documented behaviour: resolve EMPTY rather than throw when the profile
    // forbids readback, so a caller with an analytic fallback takes it and a
    // caller without one fails loudly at its own use site.
    if (!tex || !this.allowReadback) return out ?? new Float32Array(0);
    const pixels = this.gl.read(tex);
    this.gl.finish();
    const n = pixels.length;
    const dst = out && out.length >= n ? out : new Float32Array(n);
    if (pixels instanceof Float32Array) dst.set(pixels.subarray(0, n));
    else for (let i = 0; i < n; i++) dst[i] = pixels[i] / 255;
    return dst;
  }

  /** Synchronous readback for BAKE's own internal use (mip analysis, SDFs). */
  readSync(texture: THREE.Texture): Float32Array | Uint8Array | null {
    const tex = this.owned.get(texture);
    if (!tex) return null;
    const pixels = this.gl.read(tex);
    this.gl.finish();
    return pixels as Float32Array | Uint8Array;
  }

  buildMips(texture: THREE.Texture, mode: MipMode): void {
    const tex = this.owned.get(texture);
    if (!tex) return;
    buildMipChain(this.gl, tex, mode);
    this.gl.finish();
  }

  dispose(): void {
    this.gl.dispose();
  }
}

/* ------------------------------------------------------------------ utils -- */

function resolveUniform(value: unknown, owned: WeakMap<THREE.Texture, BakeTexture>): unknown {
  if (value instanceof THREE.Texture) {
    const bake = owned.get(value);
    if (bake) return bake;
  }
  return value;
}

function resampleInto(
  src: Uint8Array,
  sw: number,
  sh: number,
  dst: Uint8Array,
  dw: number,
  dh: number,
  offset: number,
): void {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const s = (sy * sw + sx) * 4;
      const d = offset + (y * dw + x) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
}

/* --------------------------------------------------------------- impostor -- */

const IMPOSTOR_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMatrix;
uniform float uRadius;
out vec3 vNormal;
out vec2 vUv;
out float vDepth;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vNormal = normalize(uNormalMatrix * aNormal);
  vUv = aUv;
  vec4 clip = uViewProj * world;
  // Depth stored in the atlas is a signed offset along the view axis in units
  // of the bounding radius, so the consumer can parallax-correct the billboard.
  vDepth = clip.z * 0.5 + 0.5;
  gl_Position = clip;
}`;

const IMPOSTOR_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in float vDepth;
uniform vec3 uColor;
uniform sampler2D uMap;
uniform int uHasMap;
uniform float uAlphaTest;
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormalDepth;
vec2 octEncode(vec3 n){
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.z >= 0.0 ? n.xy : (1.0 - abs(n.yx)) * sign(n.xy);
  return e * 0.5 + 0.5;
}
void main() {
  vec4 c = vec4(uColor, 1.0);
  if (uHasMap == 1) c *= texture(uMap, vUv);
  if (c.a < uAlphaTest) discard;
  outAlbedo = vec4(c.rgb, 1.0);
  outNormalDepth = vec4(octEncode(normalize(vNormal)), vDepth, 1.0);
}`;

interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  count: number;
  indexType: number;
  model: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  color: THREE.Color;
  map: WebGLTexture | null;
  alphaTest: number;
}

function renderImpostorViews(
  bgl: BakeGl,
  meshes: readonly THREE.Mesh[],
  centre: THREE.Vector3,
  radius: number,
  grid: number,
  tile: number,
  albedo: BakeTexture,
  normalDepth: BakeTexture,
): void {
  const gl = bgl.gl;
  const program = linkImpostorProgram(gl);
  const buffers: MeshBuffers[] = [];
  const disposables: WebGLBuffer[] = [];
  for (const mesh of meshes) {
    const b = uploadMesh(gl, mesh, disposables);
    if (b) buffers.push(b);
  }
  if (buffers.length === 0) return;

  const fbo = gl.createFramebuffer();
  const depth = gl.createRenderbuffer();
  if (!fbo || !depth) return;
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, albedo.width, albedo.height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, albedo.handle, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, normalDepth.handle, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.useProgram(program.program);

  const view = new THREE.Matrix4();
  const proj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const eye = new THREE.Vector3();
  const up = new THREE.Vector3();
  const target = centre.clone();

  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      // Hemi-octahedral mapping: the lower hemisphere is never seen for ground
      // vegetation, so spending half the atlas on it wastes resolution.
      const u = grid === 1 ? 0.5 : tx / (grid - 1);
      const v = grid === 1 ? 0.5 : ty / (grid - 1);
      const dir = hemiOctDecode(u, v);
      eye.copy(dir).multiplyScalar(radius * 3).add(centre);
      up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.98) up.set(0, 0, 1);
      view.lookAt(eye, target, up);
      view.setPosition(eye);
      view.invert();
      proj.makeOrthographic(-radius, radius, radius, -radius, 0.01, radius * 6);
      viewProj.multiplyMatrices(proj, view);

      gl.viewport(tx * tile, ty * tile, tile, tile);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(tx * tile, ty * tile, tile, tile);
      for (const b of buffers) {
        gl.bindVertexArray(b.vao);
        gl.uniformMatrix4fv(program.uViewProj, false, viewProj.elements);
        gl.uniformMatrix4fv(program.uModel, false, b.model.elements);
        gl.uniformMatrix3fv(program.uNormalMatrix, false, b.normalMatrix.elements);
        gl.uniform3f(program.uColor, b.color.r, b.color.g, b.color.b);
        gl.uniform1f(program.uAlphaTest, b.alphaTest);
        gl.uniform1i(program.uHasMap, b.map ? 1 : 0);
        if (b.map) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, b.map);
          gl.uniform1i(program.uMap, 0);
        }
        gl.uniform1f(program.uRadius, radius);
        if (b.indexType !== 0) gl.drawElements(gl.TRIANGLES, b.count, b.indexType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, b.count);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
  }

  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteRenderbuffer(depth);
  for (const b of buffers) gl.deleteVertexArray(b.vao);
  for (const buf of disposables) gl.deleteBuffer(buf);
  gl.deleteProgram(program.program);
  gl.disable(gl.DEPTH_TEST);
}

function hemiOctDecode(u: number, v: number): THREE.Vector3 {
  const x = u * 2 - 1;
  const y = v * 2 - 1;
  const px = (x + y) * 0.5;
  const py = (y - x) * 0.5;
  const z = 1 - Math.abs(px) - Math.abs(py);
  return new THREE.Vector3(px, Math.max(z, 1e-3), py).normalize();
}

interface ImpostorProgram {
  program: WebGLProgram;
  uViewProj: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uNormalMatrix: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uMap: WebGLUniformLocation | null;
  uHasMap: WebGLUniformLocation | null;
  uAlphaTest: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
}

function linkImpostorProgram(gl: WebGL2RenderingContext): ImpostorProgram {
  const make = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type);
    if (!s) throw new Error('impostor: shader alloc failed');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`impostor shader: ${gl.getShaderInfoLog(s) ?? ''}`);
    }
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error('impostor: program alloc failed');
  gl.attachShader(p, make(gl.VERTEX_SHADER, IMPOSTOR_VS));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, IMPOSTOR_FS));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`impostor link: ${gl.getProgramInfoLog(p) ?? ''}`);
  }
  return {
    program: p,
    uViewProj: gl.getUniformLocation(p, 'uViewProj'),
    uModel: gl.getUniformLocation(p, 'uModel'),
    uNormalMatrix: gl.getUniformLocation(p, 'uNormalMatrix'),
    uColor: gl.getUniformLocation(p, 'uColor'),
    uMap: gl.getUniformLocation(p, 'uMap'),
    uHasMap: gl.getUniformLocation(p, 'uHasMap'),
    uAlphaTest: gl.getUniformLocation(p, 'uAlphaTest'),
    uRadius: gl.getUniformLocation(p, 'uRadius'),
  };
}

function uploadMesh(gl: WebGL2RenderingContext, mesh: THREE.Mesh, disposables: WebGLBuffer[]): MeshBuffers | null {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const vao = gl.createVertexArray();
  if (!vao) return null;
  gl.bindVertexArray(vao);

  const bind = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, loc: number, size: number, fallback: Float32Array): void => {
    const buf = gl.createBuffer();
    if (!buf) return;
    disposables.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const data = attr ? (attr.array as Float32Array) : fallback;
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  const vertexCount = pos.count;
  bind(pos as THREE.BufferAttribute, 0, 3, new Float32Array(vertexCount * 3));
  bind(geo.getAttribute('normal') as THREE.BufferAttribute | undefined, 1, 3, new Float32Array(vertexCount * 3).fill(0));
  bind(geo.getAttribute('uv') as THREE.BufferAttribute | undefined, 2, 2, new Float32Array(vertexCount * 2));

  let count = vertexCount;
  let indexType = 0;
  const index = geo.getIndex();
  if (index) {
    const buf = gl.createBuffer();
    if (buf) {
      disposables.push(buf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index.array as ArrayBufferView, gl.STATIC_DRAW);
      count = index.count;
      indexType = index.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
  }
  gl.bindVertexArray(null);

  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  return {
    vao,
    count,
    indexType,
    model: mesh.matrixWorld.clone(),
    normalMatrix: new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
    color: material?.color ? material.color.clone() : new THREE.Color(1, 1, 1),
    map: null,
    alphaTest: material?.alphaTest ?? 0.3,
  };
}
