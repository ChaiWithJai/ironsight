/**
 * The in-canvas 2D layer. OWNER: HUD.
 *
 * One material, one geometry, ONE DRAW CALL for the entire interface — the
 * whole HUD arrives as an interleaved vertex stream from `HudBatch` and is
 * shaded by a six-branch fragment program. `docs/HUD_SPEC.md` §9.7 asks for one
 * text draw per (atlas, threshold, colour-mode); putting the threshold and the
 * colour in the vertex stream collapses text, panels, shapes, glows and the
 * minimap plate into a single submission.
 *
 * COLOUR MANAGEMENT, which is where UI layers usually give themselves away.
 * The HUD is authored in sRGB and written straight through: it is drawn AFTER
 * the tonemap and is never graded, exposed, bloomed or TAA'd. When the pass
 * composites over the default framebuffer (three's drawing buffer is already
 * sRGB-encoded) the literal values land untouched. When RCORE's post chain is
 * live the destination is `post.ldr`, an `RGBA8_SRGB` target that encodes on
 * write — so the shader converts to linear first and the same authored bytes
 * come out the other end. `uToLinear` is that switch and nothing else.
 */
import * as THREE from 'three';
import type { BakedFont, MaterialFactory } from '@/engine/types';
import { HudBatch, buildGeometry } from './draw';

const VERTEX = /* glsl */ `
  uniform vec2 uViewport;
  in vec2 aUv;
  in vec4 aColor;
  in vec4 aParam;
  in vec2 aFlags;
  out vec2 vUv;
  out vec4 vColor;
  out vec4 vParam;
  out vec2 vFlags;
  void main() {
    vUv = aUv;
    vColor = aColor;
    vParam = aParam;
    vFlags = aFlags;
    // Device pixels, origin top-left, y down — the coordinate system every
    // measurement in HUD_SPEC.md is expressed in — straight to clip space.
    vec2 ndc = vec2(position.x / uViewport.x, position.y / uViewport.y) * 2.0 - 1.0;
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uAtlas;
  uniform sampler2D uMap;
  uniform float uToLinear;
  in vec2 vUv;
  in vec4 vColor;
  in vec4 vParam;
  in vec2 vFlags;
  out vec4 outColor;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  }

  void main() {
    // EVERY derivative is taken before the branch. GLSL ES 3.0 leaves fwidth()
    // undefined under non-uniform control flow, and a HUD that renders correctly
    // on one driver and shimmers on another is not a HUD.
    float sdf = texture(uAtlas, vUv).r;
    float sdfWidth = fwidth(sdf) * 0.75;
    float diag = (vUv.x + vUv.y) * 0.70710678;
    float diagWidth = fwidth(diag) + 0.001;

    int mode = int(vFlags.x + 0.5);
    vec3 rgb = vColor.rgb;
    float cov = 1.0;

    if (mode == 1) {
      // SDF glyph. Threshold IS the synthetic weight (HUD_SPEC §4.3); the
      // screen-space derivative is what keeps a 9 px cap crisp without a
      // second atlas and without leaning on TAA.
      float w = sdfWidth + vParam.y;
      cov = smoothstep(vParam.x - w, vParam.x + w, sdf);
    } else if (mode == 2) {
      float d = sdRoundBox(vUv, vParam.xy, vParam.z);
      if (vParam.w > 0.0) d = abs(d) - vParam.w * 0.5;
      cov = 1.0 - smoothstep(-0.6, 0.6, d);
    } else if (mode == 3) {
      float box = sdRoundBox(vUv, vParam.xy, 0.0);
      float m = mod(diag, vParam.z);
      float stripe = 1.0 - smoothstep(vParam.w - diagWidth, vParam.w + diagWidth, m);
      cov = stripe * (1.0 - smoothstep(-0.5, 0.5, box));
    } else if (mode == 4) {
      cov = pow(max(0.0, 1.0 - length(vUv)), max(0.5, vParam.x));
    } else if (mode == 5) {
      vec4 t = texture(uMap, vUv);
      rgb *= t.rgb;
      cov = t.a;
    }

    float a = cov * vColor.a;
    if (a <= 0.002) discard;
    if (uToLinear > 0.5) rgb = srgbToLinear(rgb);
    // PREMULTIPLIED. An alpha mark emits (rgb·a, a); an additive glow emits
    // (rgb·a, 0), which under src·1 + dst·(1−srcA) reduces to src + dst. One
    // blend state expresses both, so glow and sharp interleave by emission
    // order inside a single draw — HUD_SPEC §9.6.
    outColor = vec4(rgb * a, a * (1.0 - vFlags.y));
  }
`;

export class HudRenderer {
  readonly batch = new HudBatch();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private mesh: THREE.Mesh | null = null;
  private material: THREE.Material | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private geometryGeneration = -1;
  private readonly viewport = new THREE.Vector2(1920, 1080);
  private readonly uniforms = {
    uViewport: { value: this.viewport },
    uAtlas: { value: null as THREE.Texture | null },
    uMap: { value: null as THREE.Texture | null },
    uToLinear: { value: 0 },
  };

  constructor(private readonly materials: MaterialFactory) {}

  setFont(font: BakedFont | null): void {
    this.uniforms.uAtlas.value = font ? font.atlas : this.fallbackTexture();
  }

  setMap(map: THREE.Texture | null): void {
    this.uniforms.uMap.value = map ?? this.fallbackTexture();
  }

  private fallback: THREE.DataTexture | null = null;
  private fallbackTexture(): THREE.Texture {
    if (!this.fallback) {
      // A single opaque black texel. Sampling a null uniform is a driver crash
      // on some stacks and a silent black frame on others; a real 1×1 texture
      // means a HUD built before the bake lands still composites, just without
      // text — which is a legible failure rather than a blank canvas.
      this.fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      this.fallback.needsUpdate = true;
    }
    return this.fallback;
  }

  private ensure(): THREE.Mesh {
    if (!this.material) {
      this.uniforms.uAtlas.value ??= this.fallbackTexture();
      this.uniforms.uMap.value ??= this.fallbackTexture();
      this.material = this.materials.createUnlit({
        id: 'hud.layer',
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: this.uniforms,
        blending: 'premultiplied',
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // DOUBLE-SIDED, and it is not a nicety. The batch works in device pixels
        // with y DOWN, so a quad emitted TL→TR→BR→BL is clockwise once the
        // vertex shader flips y into NDC — i.e. back-facing under GL's CCW
        // default. Single-sided, every rectangle, glyph, rounded box and minimap
        // plate is culled while the stroked paths and fans, whose winding
        // happens to survive, still draw. That failure mode looks exactly like
        // "half the HUD is missing" and nothing in the shader is wrong.
        side: 'double',
        // Never tonemapped: the HUD is drawn after the grade, and the whole
        // point of §2.6 is that these colours are literal.
        toneMapped: false,
      });
    }
    if (!this.geometry || this.geometryGeneration !== this.batch.bufferGeneration) {
      this.geometry?.dispose();
      this.geometry = buildGeometry(this.batch);
      // Never culled and never depth-sorted: emission order is z-order.
      this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      this.geometryGeneration = this.batch.bufferGeneration;
      if (this.mesh) {
        this.scene.remove(this.mesh);
        this.mesh = null;
      }
    }
    if (!this.mesh) {
      this.mesh = new THREE.Mesh(this.geometry, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 0;
      this.scene.add(this.mesh);
    }
    return this.mesh;
  }

  /** Push this frame's vertices and return the scene the pass should draw. */
  upload(width: number, height: number, toLinear: boolean): THREE.Scene | null {
    const count = this.batch.vertexCount;
    const mesh = this.ensure();
    void mesh;
    if (count === 0 || !this.geometry) return null;
    this.viewport.set(width, height);
    this.uniforms.uToLinear.value = toLinear ? 1 : 0;
    const position = this.geometry.getAttribute('position') as THREE.InterleavedBufferAttribute;
    const interleaved = position.data;
    // Upload only the range actually written. Three clears the ranges after the
    // upload, but a frame whose draw is skipped would otherwise leave a stale
    // one behind, so they are cleared here too.
    interleaved.clearUpdateRanges();
    interleaved.addUpdateRange(0, count * this.batch.stride);
    interleaved.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
    return this.scene;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.geometry = null;
    this.fallback?.dispose();
    this.fallback = null;
    this.mesh = null;
  }
}
