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
/** Sun illuminance normal to the sun, above the cloud deck, in LUX. Not divided
 *  by 4pi — ironCloudPhase is a real sr^-1 phase and carries the solid angle. */
uniform vec3 uSkyCloudSun;
/** Hemispherical sky radiance the deck floats in, cd/m2. See system.ts. */
uniform vec3 uSkyCloudFill;

/**
 * The marine boundary layer, as a CHAPMAN AIRMASS rather than a 1/cos slab.
 *
 * ── WHY THIS CHANGED, AND WHAT IT FIXES ─────────────────────────────────────
 *
 * Round 1, severity 8: "the horizon does not exist … everything past roughly
 * 80 m collapses into one featureless white sheet … this is a uniform-density
 * fog constant saturating to full opacity and being used as a draw-distance
 * blanket." It was. The previous form was "sigma * min(H/dy, 30000)" with
 * σ = 1.32e-3 /m, so a horizontal ray carried an optical depth of THIRTY-NINE.
 * e^-39 is zero in any arithmetic: every direction within a couple of degrees
 * of the horizon returned the in-scatter colour and nothing else, and since the
 * sea below the horizon converges to the same in-scatter, the two met at exactly
 * the same number. A horizon is not a line we draw — it is the 10–20 % of the
 * sky's own radiance that survives the haze and that the sea, being darker,
 * does not have. Saturate the transmittance and you have deleted it.
 *
 * The fix has two halves. The airmass is capped at 48 instead of diverging
 * (1/sqrt(dy^2 + mu^2) is the standard smooth stand-in for the curved-Earth
 * chord, and 48 is the real airmass of a horizontal ray through an 80 m layer
 * over a 6371 km planet). And the ZENITH optical depth is quoted directly, at
 * 0.055, instead of being a σ times a scale height — 1.32e-3 /m is a 3 km
 * visibility, i.e. genuine fog, and it was veiling the 900 m cloud deck by 42 %
 * at the elevations the deck is actually seen at.
 *
 * The resulting profile: 5 % haze at the zenith, 10 % at 30°, 25 % at the sun's
 * own 11°, 87 % at 1° and 93 % at the horizon. The horizon band is still the
 * brightest thing in the sky and still warms toward the sun — that is §3.1's
 * measurement and it survives — but 7 % of the sky's own radiance now reaches
 * the eye, which is the entire difference between a horizon and a white sheet.
 */
const float IRON_BL_H = 80.0;
/** Vertical optical depth of the layer. */
const float IRON_BL_TAU_Z = 0.055;
/** μ² for the airmass floor; 1/μ = 48 is the horizontal chord through the layer. */
const float IRON_BL_MU2 = 4.34e-4;

/** Optical depth of the boundary layer looking out along 'dir' to infinity. */
float ironBoundaryTau(vec3 dir) {
  float dy = max(dir.y, 0.0);
  float airmass = 1.0 / sqrt(dy * dy + IRON_BL_MU2);
  // The eye's own altitude removes the part of the layer beneath it.
  float above = exp(-max(0.0, uSkyCameraY) / IRON_BL_H);
  return IRON_BL_TAU_Z * airmass * above * uSkySigma;
}

/**
 * 'ironSkyChroma' — the golden-hour chroma pre-expansion — now lives in
 * 'HAZE_GLSL' (src/world/sky/glsl.ts, §3), beside 'ironHazeRadiance', and is in
 * scope here because that chunk is concatenated above this one. It has to be
 * there and not here: the same in-scatter value saturates BOTH this dome and
 * the world-surface aerial-perspective chunk, and correcting it on one side
 * only puts a chroma step on the skyline. See the note on the function.
 */
`;

const DOME_FRAGMENT = /* glsl */ `
  vec3 dir = normalize(vDirection);

  // The analytic in-scatter — LOOK_SPEC §2.4's five MEASURED sky directions,
  // interpolated. Computed first because it is used twice: once to calibrate
  // the table's chroma (immediately below) and once as the marine boundary
  // layer's saturation radiance (at the end).
  vec3 inscatter = ironSkyChroma(
    ironHazeRadiance(dir, uSkySunDirection, uSkySunChroma, uSkyTurbidity, uSkyOvercast));

  // Clamped AT THE SOURCE, not only where it is composited. The re-applied Mie
  // aureole reaches a few hundred thousand cd/m² inside a degree of the sun and
  // every later expression that touches it then has to survive an fp16
  // intermediate. See the ceiling note below the cloud block for the failure.
  vec3 lut = ironSkyChroma(min(
    ironSkyViewLut(uSkyViewLut, dir, uSkySunDirection, uSkySunElevationDeg, uSkySunChroma),
    vec3(6.0e4)));

  // ── THE REFERENCE CALIBRATION, AND WHY THE DOME IS NOT THE RAW TABLE ────────
  //
  // Round 2 measured our dome at B−R = +82 and HSV S = 0.40 at 28° elevation.
  // The corresponding direction in reference/gameplay/bfv_gp_036.jpg — the
  // corpus' golden/blue-hour anchor — measures (155,175,195), B−R = +40,
  // S = 0.21, Y = 172, and LOOK_SPEC §2.4's table agrees with it to within a
  // few levels ((146,156,176) at the zenith). The dome is twice as blue as the
  // thing it is being graded against.
  //
  // The raymarched table is not wrong; it is a PRISTINE atmosphere. A
  // single+multiple-scattering integral over Bruneton's coefficients is a
  // turbidity-1.04 sky, and pushing the aerosol at it does not fix the chroma —
  // that was measured too, over mieScale 1.6 → 48, and the sky goes DARKER
  // (Y 161 → 128) while B−R barely moves, because Mie extinguishes the low sun
  // faster than its own scattering brightens the dome. The corpus' skies are
  // hazy, graded and shot through an AgX-like transfer that compresses chroma
  // hard in the 0.6–0.8 display band where a sky sits, and no coefficient inside
  // the physical model reaches that.
  //
  // What the physical table uniquely owns is STRUCTURE: how radiance varies
  // with elevation, azimuth and sun angle, where the aureole is, how the
  // gradient tightens as the sun drops. What §2.4 uniquely owns is COLOUR at
  // five measured directions. Mixing them keeps both: the table supplies the
  // field, the anchors supply the white balance. Measured through the actual
  // renderer, the table alone lands S 0.42 and the anchors alone S 0.044, so a
  // mix near half hits the measured 0.21 exactly — which is the calibration,
  // and the reason the number is not a taste.
  //
  // The weight leans toward the table at the zenith, where the blue genuinely
  // belongs and where §2.4's own chroma is bluest, and toward the anchors down
  // near the horizon where the aerosol dominates and the reference is pale and
  // warm. Applied to the SKY TERM ONLY: the sun disc and the cloud deck are
  // composited after it and must keep their own radiance.
  float calib = mix(0.55, 0.26, smoothstep(0.02, 0.62, dir.y));
  vec3 sky = mix(lut, inscatter, calib);

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
  if (dir.y > 0.0025 && uSkyCloudDensity > 0.001) {
    vec3 origin = vec3(0.0, max(uSkyCameraY, 1.0), 0.0);
    // Per-pixel offset of the ray start, as a fraction of the first stride.
    // gl_FragCoord and a bit-mixing hash, NOT an ordered dither — see clouds.ts
    // for why the difference decides whether the deck reads as volume or as
    // rectilinear block noise.
    float jitter = ironCloudHash(gl_FragCoord.xy);
    // The fill is the whole hemisphere the deck floats in, computed on the CPU
    // (system.ts) from the same anchors the dome is drawn from — not the zenith
    // alone, which at golden hour is the DARKEST direction in the sky and left
    // every cloud base a third under-lit. Handed over UNSCALED: the march
    // applies its own depth-dependent occlusion to it.
    vec4 cl = ironCloudMarch(origin, dir, uSkySunDirection, uSkyCloudSun, uSkyCloudFill,
                             IRON_CLOUD_STEPS, uSkyCloudDensity, jitter);
    cloudScatter = cl.rgb;
    cloudT = cl.a;
  }
  #endif

  // THE CEILING IS LOAD-BEARING, and it is the same failure mode the sun-disc
  // clamp above documents, one term further out. ironSkyViewLut() re-applies a
  // two-lobe Mie phase at full angular resolution, and the narrow lobe reaches
  // ~43 sr⁻¹ inside a degree of the sun; against a solar constant of 1.27e5 lx
  // that puts the aureole a few hundred thousand cd/m². Anywhere the SwiftShader
  // path the capture harness runs on demotes an intermediate to 16-bit float
  // that is Inf (fp16 tops out at 65504), and Inf × a cloud transmittance of
  // zero is NaN — which writes as a ragged BLACK HOLE in the middle of the
  // aureole wherever a cloud crosses the sun. It did exactly that on
  // sky_clouds. 6e4 cd/m² is already 11 EV over mid grey, so AgX clips it to
  // white either way and nothing downstream can tell the difference.
  vec3 beyond = min(sky + sunDisc, vec3(6.0e4)) * cloudT + min(cloudScatter, vec3(6.0e4));

  // ---- marine boundary layer -------------------------------------------
  float tau = ironBoundaryTau(dir);
  vec3 tauRGB = tau * IRON_HAZE_CH;
  vec3 trans = exp(-tauRGB);
  vec3 radiance = beyond * trans + inscatter * (1.0 - trans);
  // One guard for the whole dome. A NaN anywhere upstream writes as black and
  // is invisible in code review but glaring in a PNG; falling back to the
  // analytic in-scatter degrades to "slightly flat" instead of "hole in the sky".
  //
  // A RANGE TEST RATHER THAN isnan()/isinf(). Both are permitted to return
  // anything at all when a driver compiles with fast-math assumptions — and the
  // SwiftShader path this is here to protect against is one of those, which is
  // why the previous guard did not catch the black hole it was written for.
  // Every comparison against a NaN is false, so "!(x > -1 && x < 1e12)" is true
  // for NaN, for +Inf and for anything nonsensically negative, on every
  // implementation, with no library call.
  bvec3 ok = greaterThan(radiance, vec3(-1.0));
  bvec3 finite = lessThan(radiance, vec3(1.0e12));
  if (!(all(ok) && all(finite))) radiance = inscatter;

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
  readonly uSkyCloudFill: GpuUniform<THREE.Vector3>;
  readonly uSkyCloudNoise: GpuUniform<THREE.Texture | null>;
  readonly uSkyCloudNoiseSize: GpuUniform<number>;
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
    uSkyCloudSun: { value: new THREE.Vector3(55200, 39300, 26400) },
    uSkyCloudFill: { value: new THREE.Vector3(2900, 2950, 3150) },
    uSkyCloudNoise: { value: null },
    uSkyCloudNoiseSize: { value: 256 },
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
