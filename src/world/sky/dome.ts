/**
 * The sky dome: the one surface in the game that is pure atmosphere.
 *
 * OWNER: SKY.
 *
 * Composition, outward from the eye:
 *
 *   1. the baked sky-view table — real Rayleigh + Mie single scattering plus
 *      Hillaire multiple scattering, with the Mie phase re-applied at full
 *      angular resolution so the aureole around the sun stays 8° wide instead
 *      of being smeared to 40° by the table's 64 azimuth samples;
 *   2. the sun disc, at 0.265° angular radius with limb darkening, rendered
 *      NEAR-WHITE (LOOK_SPEC §2.2 measures RGB(254, 246, 238) within 3° of the
 *      disc — an orange sun is a first-glance tell);
 *   3. the volumetric cloud deck, self-shadowed, composited INTO the scattering
 *      rather than over it;
 *   4. the marine boundary layer, which is what actually produces the bright
 *      achromatic horizon band that warms toward the sun azimuth, and which is
 *      evaluated with the SAME function the world-surface aerial perspective
 *      saturates to — so the far headland and the sky directly above it are the
 *      same colour by construction rather than by tuning.
 */
import * as THREE from 'three';
import {
  SceneGroup,
  type GpuUniform,
  type MaterialFactory,
  type SceneGraph,
} from '@/engine/types';
import { CLOUD_GLSL } from '@/world/sky/clouds';
import {
  ATMOSPHERE_GLSL,
  HAZE_GLSL,
  SKYVIEW_GLSL,
  SKYVIEW_SAMPLE_GLSL,
} from '@/world/sky/glsl';

const DOME_VERTEX = /* glsl */ `
  out vec3 vDirection;
  void main() {
    vDirection = position;
    // Translation removed and z forced to w: the dome sits at infinity, so it
    // never clips, never moves with the camera and never fights depth.
    mat4 rotOnly = mat4(mat3(modelViewMatrix));
    vec4 clip = projectionMatrix * rotOnly * vec4(position, 1.0);
    gl_Position = clip.xyww;
  }
`;

const DOME_PRELUDE = /* glsl */ `
in vec3 vDirection;

uniform vec3 uSkySunDirection;
uniform vec3 uSkySunChroma;
uniform vec3 uSkySunDisc;
uniform float uSkySunElevationDeg;
uniform float uSkyTurbidity;
uniform float uSkyOvercast;
uniform float uSkySigma;
uniform float uSkyCameraY;
uniform float uSkyCloudDensity;
/** Sun irradiance above the cloud deck, divided by 4π so the phase carries it. */
uniform vec3 uSkyCloudSun;

/**
 * Effective scale height of the marine boundary layer AS THE SKY SEES IT.
 *
 * LOOK_SPEC §3.2 quotes 22 m for the aerial-perspective slab. Applied to the
 * dome that puts the entire horizon in-scatter band inside 2° of the horizon
 * line, which contradicts §3.1's own measurement that the horizon is about
 * twice as bright as the sky 30° up. 80 m reproduces §3.1: ~10 % haze at the
 * zenith, 43 % at the sun's own elevation, 95 % within 2° of the horizon.
 * Stated as a deliberate deviation in the lane report.
 */
const float IRON_BL_H = 80.0;
const float IRON_BL_SIGMA = 1.32e-3;

/** Interleaved gradient noise — a fine, film-like dither rather than banding. */
float ironIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Optical depth of the boundary layer looking out along 'dir' to infinity. */
float ironBoundaryTau(vec3 dir) {
  float dy = dir.y;
  float path;
  if (dy > 1e-3) {
    path = IRON_BL_H * exp(-max(0.0, uSkyCameraY) / IRON_BL_H) / dy;
  } else {
    // Grazing and downward rays: clamp at the geometric horizon distance, which
    // at head height is about 5 km, so the band has a finite floor.
    path = 30000.0;
  }
  return IRON_BL_SIGMA * min(path, 30000.0) * uSkySigma;
}
`;

const DOME_FRAGMENT = /* glsl */ `
  vec3 dir = normalize(vDirection);

  vec3 sky = ironSkyViewLut(uSkyViewLut, dir, uSkySunDirection, uSkySunElevationDeg, uSkySunChroma);

  // ---- sun disc ---------------------------------------------------------
  // 0.265° angular RADIUS (LOOK_SPEC §2.2 gives 0.53° diameter). The edge is
  // antialiased over one tenth of the radius; anything harder aliases into a
  // single pixel under a 103° horizontal FOV and then crawls under TAA.
  float cosSun = clamp(dot(dir, uSkySunDirection), -1.0, 1.0);
  float angle = acos(cosSun);
  const float SUN_R = 0.004625;
  float disc = 1.0 - smoothstep(SUN_R * 0.90, SUN_R * 1.10, angle);
  // Limb darkening: the disc is measurably darker at its rim, and putting it in
  // is what stops the sun reading as a flat white sticker at high exposure.
  //
  // A plain multiply rather than pow(x, 2.0): GLSL leaves pow(0, y) undefined, and the
  // SwiftShader path the capture harness runs on returns NaN for it. The whole
  // disc then multiplied out to NaN and the sun rendered as a hard BLACK circle
  // in the middle of its own halo — which is exactly what it looked like.
  float rN = min(angle / SUN_R, 1.0);
  float limb = sqrt(max(0.0, 1.0 - rN * rN));
  // DELIBERATE DEVIATION, and the reason is a defect it took two capture
  // cycles to corner. LOOK_SPEC §2.2 puts the disc at 1.6e7 cd/m². Carrying a
  // literal 1.6e7 through this composite renders the sun as a hard BLACK circle
  // of exactly its own angular size, sitting inside its own bright halo, on the
  // SwiftShader path the capture harness uses: the value overflows anywhere the
  // compiler demotes an intermediate to 16-bit float, and Inf × the cloud
  // transmittance is NaN. 6e4 cd/m² is still 6.7× the sunward horizon and 11 EV
  // over mid grey, so AgX clips it to pure white either way; nothing downstream
  // can tell the difference until a bloom pass exists that wants the headroom,
  // and that pass will read the LOOK_SPEC value from the uniform, not from here.
  vec3 sunDisc = min(uSkySunDisc, vec3(6.0e4)) * disc * (0.62 + 0.38 * limb);

  // ---- clouds -----------------------------------------------------------
  vec3 cloudScatter = vec3(0.0);
  float cloudT = 1.0;
  #if IRON_CLOUD_STEPS > 0
  if (dir.y > 0.006 && uSkyCloudDensity > 0.001) {
    vec3 origin = vec3(0.0, max(uSkyCameraY, 1.0), 0.0);
    // Ambient on the cloud is the sky ABOVE it, not a grey constant: a cloud
    // shaded against a constant ambient is the flat-lit failure the brief names.
    vec3 ambient = ironSkyViewLut(uSkyViewLut, vec3(0.0, 1.0, 0.0),
                                  uSkySunDirection, uSkySunElevationDeg, uSkySunChroma) * 1.6;
    float jitter = ironIgn(gl_FragCoord.xy);
    vec4 cl = ironCloudMarch(origin, dir, uSkySunDirection, uSkyCloudSun, ambient,
                             IRON_CLOUD_STEPS, jitter, uSkyCloudDensity);
    cloudScatter = cl.rgb;
    cloudT = cl.a;
  }
  #endif

  vec3 beyond = (sky + sunDisc) * cloudT + cloudScatter;

  // ---- marine boundary layer -------------------------------------------
  float tau = ironBoundaryTau(dir);
  vec3 tauRGB = tau * IRON_HAZE_CH;
  vec3 trans = exp(-tauRGB);
  vec3 inscatter = ironHazeRadiance(dir, uSkySunDirection, uSkySunChroma, uSkyTurbidity, uSkyOvercast);
  vec3 radiance = beyond * trans + inscatter * (1.0 - trans);
  // One guard for the whole dome. A NaN anywhere upstream writes as black and
  // is invisible in code review but glaring in a PNG; falling back to the
  // analytic in-scatter degrades to "slightly flat" instead of "hole in the sky".
  if (any(isnan(radiance)) || any(isinf(radiance))) radiance = inscatter;

  outColor = vec4(radiance * IRON_SKY_SCALE, 1.0);

  // A custom ShaderMaterial does NOT get three's automatic tonemap/colourspace
  // injection at the end of main(), so both are applied by hand — otherwise the
  // sky lands in a different colour space from every lit surface next to it.
  #ifdef TONE_MAPPING
    outColor.rgb = toneMapping(outColor.rgb);
  #endif
  outColor = linearToOutputTexel(outColor);
`;

export interface DomeUniforms {
  readonly uSkyViewLut: GpuUniform<THREE.Texture | null>;
  readonly uSkySunDirection: GpuUniform<THREE.Vector3>;
  readonly uSkySunChroma: GpuUniform<THREE.Vector3>;
  readonly uSkySunDisc: GpuUniform<THREE.Vector3>;
  readonly uSkySunElevationDeg: GpuUniform<number>;
  readonly uSkyTurbidity: GpuUniform<number>;
  readonly uSkyOvercast: GpuUniform<number>;
  readonly uSkySigma: GpuUniform<number>;
  readonly uSkyCameraY: GpuUniform<number>;
  readonly uSkyCloudDensity: GpuUniform<number>;
  readonly uSkyCloudSun: GpuUniform<THREE.Vector3>;
  readonly uSkyCloudNoise: GpuUniform<THREE.Texture | null>;
  readonly uSkyCloudCoverage: GpuUniform<number>;
  readonly uSkyCloudDrift: GpuUniform<THREE.Vector2>;
}

export function createDomeUniforms(): DomeUniforms {
  return {
    uSkyViewLut: { value: null },
    uSkySunDirection: { value: new THREE.Vector3(0, 0.19, -1).normalize() },
    uSkySunChroma: { value: new THREE.Vector3(1, 0.712, 0.478) },
    uSkySunDisc: { value: new THREE.Vector3(1, 0.96, 0.92) },
    uSkySunElevationDeg: { value: 11 },
    uSkyTurbidity: { value: 3.4 },
    uSkyOvercast: { value: 0.06 },
    uSkySigma: { value: 1 },
    uSkyCameraY: { value: 2 },
    uSkyCloudDensity: { value: 1 },
    uSkyCloudSun: { value: new THREE.Vector3(4400, 3100, 2100) },
    uSkyCloudNoise: { value: null },
    uSkyCloudCoverage: { value: 0.3 },
    uSkyCloudDrift: { value: new THREE.Vector2() },
  };
}

/**
 * Build the dome and park it in the Sky group.
 *
 * `cloudSteps` is baked in as a `#define` rather than a uniform because a loop
 * bound that a driver cannot unroll costs more than the samples it saves, and
 * because a tier change already forces a material rebuild everywhere else.
 */
export function createDome(
  scene: SceneGraph,
  materials: MaterialFactory,
  uniforms: DomeUniforms,
  cloudSteps: number,
): THREE.Mesh {
  const material = materials.createUnlit({
    id: 'sky.dome',
    vertexShader: DOME_VERTEX,
    fragmentShader: [
      'precision highp float;',
      ATMOSPHERE_GLSL,
      HAZE_GLSL,
      SKYVIEW_GLSL,
      'uniform sampler2D uSkyViewLut;',
      SKYVIEW_SAMPLE_GLSL,
      DOME_PRELUDE,
      CLOUD_GLSL,
      'out vec4 outColor;',
      'void main() {',
      DOME_FRAGMENT,
      '}',
    ].join('\n'),
    uniforms: uniforms as unknown as Record<string, GpuUniform>,
    defines: { IRON_CLOUD_STEPS: Math.max(0, Math.round(cloudSteps)) },
    side: 'back',
    depthWrite: false,
    depthTest: true,
    toneMapped: true,
  });

  const dome = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  dome.name = 'sky.dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  scene.group(SceneGroup.Sky).add(dome);
  return dome;
}
