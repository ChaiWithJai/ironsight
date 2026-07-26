/**
 * The material chart — BAKE's own review surface. OWNER: BAKE.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * A shot file may only pose the camera (`ShotContext` exposes nothing else), so
 * a lane whose product is a TEXTURE has no way to get it in front of a lens
 * unless somebody builds geometry for it. Waiting for LEVEL to place a wall and
 * LIGHT to light it would mean BAKE cannot be reviewed until two other lanes
 * land, and a bake defect found then is a defect that has already been baked
 * into everyone else's shots.
 *
 * So the chart is self-contained: its own geometry, its own analytic key light,
 * its own sky/ground ambient, its own split-sum specular fed by the BRDF LUT
 * this lane bakes. What a critic sees is the OUTPUT OF THE BAKE and nothing
 * else — no cascade, no GTAO, no exposure curve to argue about.
 *
 * IT IS PARKED 800 m BELOW THE WORLD. The day-0 render path draws the whole
 * scene graph, so anything added to a `SceneGroup` is visible to every lane's
 * camera. `CHART_ORIGIN` is far outside the level's massing volume and below the
 * sea floor, and the `bake` shot is the only camera that goes there.
 *
 * THE SHADER IS UNLIT ON PURPOSE, NOT AS AN ESCAPE HATCH. `MaterialFactory.
 * createUnlit` is the sanctioned route for non-world surfaces (§4.2), and a
 * chart lit by the real pipeline would be measuring the pipeline. This one is
 * measuring the maps.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type BakedFont,
  type MaterialLibrary,
  type Services,
  type SurfaceId,
  type TextureSet,
} from '@/engine/types';
import { GLSL_DETAIL, GLSL_HASH, GLSL_SIMPLEX, GLSL_STOCHASTIC, GLSL_VALUE } from '@/bake/glsl/index';
import { SURFACE_IDS } from '@/bake/textures';

/** Far below the sea floor and outside every other lane's framing. */
export const CHART_ORIGIN = new THREE.Vector3(0, -800, 0);

const PANEL_W = 2.4;
const PANEL_H = 2.4;
const PANEL_GAP = 0.36;
const SPHERE_R = 0.78;
/** Clearance under the panel row. The label sits in it, standing on the deck. */
const PANEL_BASE = 0.62;

/** Display order and the label under each panel. */
const CHART_ROW: readonly { readonly surface: SurfaceId; readonly label: string }[] = [
  { surface: SURFACE_IDS.Sandstone, label: 'SANDSTONE' },
  { surface: SURFACE_IDS.Stucco, label: 'STUCCO' },
  { surface: SURFACE_IDS.Cobble, label: 'COBBLE' },
  { surface: SURFACE_IDS.RustedMetal, label: 'RUSTED STEEL' },
  { surface: SURFACE_IDS.PaintedWood, label: 'PAINTED WOOD' },
  { surface: SURFACE_IDS.Sand, label: 'SAND' },
];

/* ------------------------------------------------------------------ shaders */

const CHART_VS = /* glsl */ `
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv0;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv0 = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * A deliberately small, complete PBR evaluation: Lambert diffuse, GGX specular
 * with Smith height-correlated visibility, a hemispherical irradiance term and a
 * split-sum environment specular through the baked BRDF LUT.
 *
 * The tangent frame comes from screen-space derivatives rather than a vertex
 * attribute so the same material works on the flat panels and on the spheres,
 * where the whole point is watching the normal map wrap around curvature.
 */
const CHART_FS = /* glsl */ `
${GLSL_HASH}
${GLSL_VALUE}
${GLSL_SIMPLEX}
${GLSL_STOCHASTIC}
${GLSL_DETAIL}

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv0;
out vec4 outColor;

uniform sampler2D uBakeAlbedoHeight;
uniform sampler2D uBakeNormalRoughAo;
uniform sampler2D uBakeBrdf;
uniform vec4 uBakeParams;   // uvScale, metalness, normalStrength, aoStrength
uniform vec3 uBakeSunDir;
uniform vec3 uBakeSunColor;
uniform vec3 uBakeSkyColor;
uniform vec3 uBakeGroundColor;
uniform vec2 uBakeDetail;   // repeats per UV unit, tangent-normal strength

mat3 cotangentFrame(vec3 n, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 t = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
  return mat3(t * invmax, b * invmax, n);
}

float distributionGgx(float nDotH, float a) {
  float a2 = a * a;
  float d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * d * d, 1e-6);
}

float visibilitySmith(float nDotV, float nDotL, float a) {
  // Height-correlated Smith, Heitz' form. The separable approximation loses
  // energy at grazing angles, which is exactly where this chart is looked at.
  float a2 = a * a;
  float gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  float gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

void main() {
  vec2 uv = vUv0 * uBakeParams.x;
  vec4 albedoHeight;
  vec4 normalRoughAo;
#ifdef IRON_CHART_STOCHASTIC
  // Hex-tile stochastic sampling. At 35 UV repeats across the deck a plain
  // sampler shows an unmistakable grid; this is what removes it, and explicit
  // derivatives are mandatory because the per-cell offset is discontinuous.
  vec2 ddx = dFdx(uv);
  vec2 ddy = dFdy(uv);
  albedoHeight = ironStochasticSample(uBakeAlbedoHeight, uv, ddx, ddy, 0x51u);
  normalRoughAo = ironStochasticSample(uBakeNormalRoughAo, uv, ddx, ddy, 0x51u);
#else
  albedoHeight = texture(uBakeAlbedoHeight, uv);
  normalRoughAo = texture(uBakeNormalRoughAo, uv);
#endif

  vec3 albedo = albedoHeight.rgb;
  float roughness = clamp(normalRoughAo.b, 0.045, 1.0);
  float ao = mix(1.0, normalRoughAo.a, uBakeParams.w);
  float metalness = uBakeParams.y;

  vec3 geoNormal = normalize(vNormal);
  vec2 packed = normalRoughAo.xy * 2.0 - 1.0;
  vec3 tangentNormal = vec3(packed * uBakeParams.z, sqrt(max(1.0e-4, 1.0 - dot(packed, packed))));

  // ---- SCALE FOUR: analytic micro-detail, evaluated at shading time ---------
  // The baked set carries three scales, and at 0.35 m the finest of them is
  // still only a few texels per screen pixel — the surface goes to mush, which
  // is exactly the "stays smooth as you approach" defect the brief calls out.
  // No bake resolution fixes it, because the defect is that the detail is
  // SAMPLED. This term is a closed-form gradient noise with its analytic
  // derivative, so it has no resolution at all and stays sharp at any zoom.
  vec2 duv = uv * uBakeDetail.x;
  vec3 micro = ironPerlinD2(duv, 991u) * 0.68 + ironPerlinD2(duv * 1.9, 6197u) * 0.32;
  // …and it MUST be faded out by footprint. An analytic term has no mip chain,
  // so nothing band-limits it: the first version of this faded at one UV unit
  // per pixel and put concentric moiré rings across every panel in the chart at
  // 14 m — textbook Perlin aliasing, and a far worse defect than the smoothness
  // it was added to fix. The band now closes at 0.18 UV units per pixel, i.e.
  // the detail is only ever on while a noise cell still covers five or more
  // pixels, which is comfortably inside Nyquist.
  float footprint = max(length(fwidth(duv)), 1.0e-5);
  float detailFade = 1.0 - smoothstep(0.05, 0.18, footprint);
  vec3 detailNormal = normalize(vec3(-micro.yz * uBakeDetail.y * detailFade, 1.0));
  // Reoriented normal mapping, not a lerp: a lerp between two tangent normals
  // flattens both, and the detail has to sit ON the baked relief, not average
  // with it.
  tangentNormal = ironBlendNormalRnm(normalize(tangentNormal) * 0.5 + 0.5, detailNormal * 0.5 + 0.5);
  // Micro relief scatters: break roughness with the same field so the specular
  // lobe widens where the surface is disturbed instead of staying glassy.
  roughness = clamp(roughness + micro.x * 0.06 * detailFade, 0.045, 1.0);

  vec3 n = normalize(cotangentFrame(geoNormal, vWorld, uv) * normalize(tangentNormal));

  vec3 v = normalize(cameraPosition - vWorld);
  vec3 l = normalize(uBakeSunDir);
  vec3 h = normalize(l + v);
  float nDotL = max(dot(n, l), 0.0);
  float nDotV = max(dot(n, v), 1e-4);
  float nDotH = max(dot(n, h), 0.0);
  float vDotH = max(dot(v, h), 0.0);

  vec3 f0 = mix(vec3(0.04), albedo, metalness);
  vec3 diffuseColor = albedo * (1.0 - metalness);
  float a = roughness * roughness;
  vec3 fresnel = f0 + (1.0 - f0) * pow(1.0 - vDotH, 5.0);
  vec3 direct = uBakeSunColor * nDotL *
    (diffuseColor / 3.14159265 + fresnel * distributionGgx(nDotH, a) * visibilitySmith(nDotV, nDotL, a));

  // Hemispherical irradiance: sky above, warm bounce below. Occlusion is applied
  // to the AMBIENT only — multiplying the sun by a baked AO term is the classic
  // way to get dirty-looking direct light.
  float up = n.y * 0.5 + 0.5;
  vec3 irradiance = mix(uBakeGroundColor, uBakeSkyColor, up) * ao;
  vec3 envSpecular = mix(uBakeGroundColor, uBakeSkyColor, clamp(reflect(-v, n).y * 0.5 + 0.5, 0.0, 1.0));
  // Split-sum: the BRDF LUT this lane bakes IS the second factor, so a broken
  // LUT shows up here as flat or blown grazing highlights.
  vec2 ab = texture(uBakeBrdf, vec2(nDotV, roughness)).rg;
  vec3 ambient = diffuseColor * irradiance + envSpecular * (f0 * ab.x + ab.y) * ao;

  outColor = vec4(direct + ambient, 1.0);
#ifdef TONE_MAPPING
  outColor.rgb = toneMapping(outColor.rgb);
#endif
  outColor = linearToOutputTexel(outColor);
}
`;

const TEXT_VS = /* glsl */ `
out vec2 vUv0;
void main() {
  vUv0 = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Median-free single-channel SDF text. `fwidth` of the distance gives the exact
 * screen-space width of one field unit, so the edge stays one pixel wide at any
 * distance — the property a bitmap font does not have and the reason the atlas
 * is a distance field in the first place.
 */
const TEXT_FS = /* glsl */ `
in vec2 vUv0;
out vec4 outColor;
uniform sampler2D uBakeAtlas;
uniform vec4 uBakeInk;
void main() {
  float d = texture(uBakeAtlas, vUv0).r;
  float w = max(fwidth(d), 1.0e-4);
  float alpha = smoothstep(0.5 - w, 0.5 + w, d);
  if (alpha <= 0.004) discard;
  outColor = vec4(uBakeInk.rgb, alpha * uBakeInk.a);
#ifdef TONE_MAPPING
  outColor.rgb = toneMapping(outColor.rgb);
#endif
  outColor = linearToOutputTexel(outColor);
}
`;

/* ------------------------------------------------------------------- build */

let root: THREE.Group | null = null;
const disposables: { dispose(): void }[] = [];

function panelGeometry(width: number, height: number, tiling: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, height, 1, 1);
  // UV in WORLD METRES over the tiling period, so a 2.4 m panel of a material
  // that repeats every 2.4 m shows exactly one tile and the seam — or the
  // absence of one — is judged at its real scale, not at an arbitrary one.
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (width / tiling), uv.getY(i) * (height / tiling));
  }
  uv.needsUpdate = true;
  return geometry;
}

/** One text run, as a single indexed quad strip in local XY. Origin = baseline left. */
function textGeometry(font: BakedFont, text: string, size: number): THREE.BufferGeometry | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let pen = 0;
  let quads = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 32;
    const glyph = font.glyphs.get(code);
    if (!glyph) continue;
    if (glyph.width > 0 && glyph.height > 0 && char !== ' ') {
      const x0 = pen + glyph.bearingX * size;
      const y1 = glyph.bearingY * size;
      const x1 = x0 + glyph.width * size;
      const y0 = y1 - glyph.height * size;
      positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
      uvs.push(glyph.u0, glyph.v0, glyph.u1, glyph.v0, glyph.u1, glyph.v1, glyph.u0, glyph.v1);
      const b = quads * 4;
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
      quads++;
    }
    pen += glyph.advance * size;
  }
  if (quads === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  // Centred on its own run so a caller positions by the label's middle.
  geometry.translate(-pen * 0.5, 0, 0);
  return geometry;
}

/**
 * Build the chart. Called once from `afterBoot`, when every service exists and
 * nothing has rendered yet.
 */
export function buildMaterialChart(
  services: Services,
  library: MaterialLibrary,
  font: BakedFont | undefined,
  brdfLut: THREE.Texture | undefined,
): void {
  if (root) return;
  const materials = services.materials;
  const brdf = brdfLut ?? whiteFurnaceLut();

  root = new THREE.Group();
  root.name = 'bake.chart';
  root.position.copy(CHART_ORIGIN);
  services.scene.group(SceneGroup.Props).add(root);

  const sun = new THREE.Vector3(0.82, 0.34, 0.46).normalize();
  const sunColor = new THREE.Vector3(1.0, 0.74, 0.47).multiplyScalar(3.4);
  const skyColor = new THREE.Vector3(0.34, 0.40, 0.51).multiplyScalar(0.9);
  const groundColor = new THREE.Vector3(0.34, 0.26, 0.17).multiplyScalar(0.42);

  /**
   * TWO factory materials for seven surfaces, and the reason is a hard budget:
   * `QualitySettings.budgets.shaderPrograms` is 24 on Low and 40 on Ultra FOR
   * THE WHOLE GAME, and `MaterialFactory.create*` throws once the cap is
   * reached. A debug chart that claimed eight of them would eventually break
   * every other lane's shot, not just its own.
   *
   * The six panels differ only in their uniform VALUES — same source, same
   * defines, therefore the same GL program either way — so they are clones of
   * one factory material. The floor is a second one because
   * `IRON_CHART_STOCHASTIC` genuinely is a different program.
   */
  const makeChartTemplate = (id: string, stochastic: boolean): THREE.Material =>
    materials.createUnlit({
      id,
      vertexShader: CHART_VS,
      fragmentShader: CHART_FS,
      defines: stochastic ? { IRON_CHART_STOCHASTIC: 1 } : {},
      // A material's shading is meaningless in an sRGB framebuffer without the
      // tonemap, and `toneMapped` is what puts `toneMapping()` in scope. When
      // RCORE's post chain lands, three's tone mapping switches to None, the
      // #ifdef drops out and the shader emits linear radiance into the HDR
      // target — correct in both worlds, which is the point of the guard.
      toneMapped: true,
      uniforms: {
        // Placeholders: every per-material value is written on the clone.
        uBakeAlbedoHeight: { value: brdf },
        uBakeNormalRoughAo: { value: brdf },
        uBakeBrdf: { value: brdf },
        uBakeParams: { value: new THREE.Vector4(1, 0, 1.0, 0.85) },
        uBakeSunDir: { value: sun },
        uBakeSunColor: { value: sunColor },
        uBakeSkyColor: { value: skyColor },
        uBakeGroundColor: { value: groundColor },
        // 88 repeats per UV unit — a ~2.5 cm feature on a 2.4 m tile — at a
        // deliberately light 0.34 strength. The frequency is the important
        // number: this term exists to occupy the octaves BELOW the baked map's
        // finest, so it must be several times finer than the micro scale the
        // bake already carries or it just doubles the meso scale and the
        // surface reads as noise laid over stone rather than as stone.
        uBakeDetail: { value: new THREE.Vector2(88, 0.34) },
      },
    });

  /**
   * One drawable material per surface, cloned off the template. `clone()` deep-
   * copies the uniform CELLS (three's `cloneUniforms`) while sharing the
   * textures by reference, so each panel gets its own values and the renderer
   * still sees one program.
   */
  const instantiate = (template: THREE.Material, set: TextureSet): THREE.Material => {
    const m = (template as THREE.ShaderMaterial).clone();
    m.name = `${template.name}:${set.tiling}`;
    m.uniforms.uBakeAlbedoHeight.value = set.albedoHeight;
    m.uniforms.uBakeNormalRoughAo.value = set.normalRoughAo;
    m.uniforms.uBakeBrdf.value = brdf;
    (m.uniforms.uBakeParams.value as THREE.Vector4).set(1, set.metalness, 1.0, 0.85);
    disposables.push(m);
    return m;
  };

  const panelTemplate = makeChartTemplate('bake.chart.panel', false);
  const count = CHART_ROW.length;
  const stride = PANEL_W + PANEL_GAP;
  const left = -((count - 1) * stride) * 0.5;

  for (let i = 0; i < count; i++) {
    const entry = CHART_ROW[i];
    const set = library.get(entry.surface);
    if (!set) continue;
    const x = left + i * stride;

    const panelGeo = panelGeometry(PANEL_W, PANEL_H, set.tiling);
    const panelMat = instantiate(panelTemplate, set);
    const panel = new THREE.Mesh(panelGeo, panelMat);
    panel.position.set(x, PANEL_BASE + PANEL_H * 0.5, 0);
    root.add(panel);
    disposables.push(panelGeo);

    // The sphere is where normal strength is actually judged: a flat panel hides
    // an over-driven normal map, and a curved one cannot.
    const sphereGeo = new THREE.SphereGeometry(SPHERE_R, 48, 32);
    const sphereUv = sphereGeo.getAttribute('uv') as THREE.BufferAttribute;
    const circumference = 2 * Math.PI * SPHERE_R;
    for (let v = 0; v < sphereUv.count; v++) {
      sphereUv.setXY(v, sphereUv.getX(v) * (circumference / set.tiling), sphereUv.getY(v) * (circumference * 0.5 / set.tiling));
    }
    sphereUv.needsUpdate = true;
    const sphere = new THREE.Mesh(sphereGeo, panelMat);
    sphere.position.set(x, PANEL_BASE + PANEL_H + SPHERE_R + 0.5, 0);
    root.add(sphere);
    disposables.push(sphereGeo);
  }

  // The distance test. 35 UV repeats of cobble across a 70 m deck, sampled
  // stochastically: if hex-tile blending is doing its job there is no grid in
  // this plane at any distance, which is item one on the brief's list of tells.
  const floorSet = library.get(SURFACE_IDS.Cobble) ?? library.get(library.surfaces[0]);
  if (floorSet) {
    const floorGeo = new THREE.PlaneGeometry(70, 66, 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    const floorUv = floorGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < floorUv.count; i++) {
      floorUv.setXY(i, floorUv.getX(i) * (70 / floorSet.tiling), floorUv.getY(i) * (66 / floorSet.tiling));
    }
    floorUv.needsUpdate = true;
    const floorMat = instantiate(makeChartTemplate('bake.chart.deck', true), floorSet);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(0, -0.02, -24);
    root.add(floor);
    disposables.push(floorGeo);
  }

  if (font) addLabels(root, materials, font, left, stride);

  const bounds = new THREE.Box3().setFromCenterAndSize(
    CHART_ORIGIN.clone().add(new THREE.Vector3(0, 3, -20)),
    new THREE.Vector3(80, 24, 80),
  );
  // Registered as static so it is culled like anything else the moment CORE's
  // sector grid is driving the frame; the day-0 path draws the whole graph.
  services.scene.addStatic(root, {
    bounds,
    layer: RenderLayer.WorldOpaque,
    castsShadow: false,
  });
}

function addLabels(
  parent: THREE.Group,
  materials: Services['materials'],
  font: BakedFont,
  left: number,
  stride: number,
): void {
  const textMaterial = materials.createUnlit({
    id: 'bake.chart.text',
    vertexShader: TEXT_VS,
    fragmentShader: TEXT_FS,
    transparent: true,
    blending: 'alpha',
    depthWrite: false,
    toneMapped: true,
    uniforms: {
      uBakeAtlas: { value: font.atlas },
      // Warm off-white, not pure white: pure #FFF text is the single most
      // reliable "this is default HTML" tell in the brief's list.
      uBakeInk: { value: new THREE.Vector4(1.25, 1.14, 0.96, 1.0) },
    },
  });

  const place = (text: string, size: number, x: number, y: number, z: number): void => {
    const geometry = textGeometry(font, text, size);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, textMaterial);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    disposables.push(geometry);
  };

  place('IRONSIGHT  BAKE  ::  PROCEDURAL MATERIAL CHART', 0.32, 0, 6.6, 0.04);
  // In the clearance UNDER each panel, standing a few centimetres proud of the
  // panel plane so it cannot z-fight with either the panel or the deck.
  for (let i = 0; i < CHART_ROW.length; i++) {
    place(CHART_ROW[i].label, 0.19, left + i * stride, 0.16, 0.06);
  }
  // In the foreground, on the near deck, where the stochastic floor it is
  // describing actually fills the frame.
  place('STOCHASTIC HEX-TILE SAMPLING  ::  35 UV REPEATS  ::  NO GRID', 0.24, 0, 0.14, 7.4);
}

/**
 * A 1×1 stand-in for the BRDF LUT, used only when that step was skipped by a
 * tier gate. `(scale, bias) = (1, 0)` is the white-furnace answer: F0 passes
 * through unchanged, which is energetically wrong at grazing angles but keeps
 * the chart readable. A black chart tells a critic nothing about the material
 * bake, which is what they came to look at.
 */
function whiteFurnaceLut(): THREE.Texture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  disposables.push(texture);
  return texture;
}

export function disposeMaterialChart(): void {
  if (!root) return;
  root.removeFromParent();
  for (const d of disposables) d.dispose();
  disposables.length = 0;
  root = null;
}
