/**
 * SkyService.
 *
 * OWNER: SKY. Day-0 stub: the null sky state and sun model from
 * `src/bootstrap/nulls.ts`, plus a sky dome and distance fog so the horizon
 * exists and every other lane's first frame has somewhere for the world to end.
 *
 * SKY: delete `PlaceholderSkyDome`, keep `createSkyService`'s signature and this
 * path. Your job is the real thing — Rayleigh/Mie transmittance and
 * multiple-scattering LUTs, a raymarched cloud volume, aerial perspective in a
 * 3D LUT, and volumetric shafts. The dome below is a THREE-BAND ANALYTIC
 * APPROXIMATION and the brief explicitly calls a gradient sky a hobby-demo tell:
 * it is here to establish the horizon line and the colour temperature, not to
 * survive review.
 */
import * as THREE from 'three';
import {
  RenderStage,
  SceneGroup,
  type AssetRegistry,
  type BootContext,
  type FrameCtx,
  type GpuUniform,
  type MaterialFactory,
  type QualitySettings,
  type RenderSystem,
  type SceneGraph,
  type SkyService,
} from '@/engine/types';
import { createNullSky, trackNull } from '@/bootstrap/nulls';

const SKY_VERTEX = /* glsl */ `
  out vec3 vDirection;
  void main() {
    vDirection = position;
    // Translation removed and z forced to w: the dome sits at infinity, so it
    // never clips and never moves with the camera.
    mat4 rotOnly = mat4(mat3(modelViewMatrix));
    vec4 clip = projectionMatrix * rotOnly * vec4(position, 1.0);
    gl_Position = clip.xyww;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  in vec3 vDirection;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uOvercast;
  uniform float uTurbidity;
  out vec4 outColor;

  void main() {
    vec3 dir = normalize(vDirection);
    float up = clamp(dir.y, -1.0, 1.0);
    float cosTheta = clamp(dot(dir, uSunDirection), -1.0, 1.0);

    // Three bands: zenith, horizon haze, and the ground half. The horizon band
    // is widened by turbidity, which is the one parameter that reads as "dusty
    // Mediterranean afternoon" rather than "clear alpine sky".
    float horizon = pow(1.0 - abs(up), 3.0 + uTurbidity * 0.6);
    vec3 zenith = mix(vec3(0.055, 0.13, 0.30), vec3(0.20, 0.22, 0.25), uOvercast);
    vec3 haze   = mix(vec3(0.62, 0.50, 0.36), vec3(0.42, 0.42, 0.44), uOvercast);
    vec3 col = mix(zenith, haze, horizon);

    // Mie forward scattering: the bright lobe around a low sun that makes
    // golden hour read as golden hour instead of as an orange filter.
    float mie = pow(max(cosTheta, 0.0), 8.0) * (1.0 - uOvercast * 0.85);
    col += uSunColor * mie * 1.1;
    float wide = pow(max(cosTheta, 0.0), 2.0) * 0.28 * (1.0 - uOvercast * 0.7);
    col += uSunColor * wide * horizon;

    // The disc itself. cos(0.00465 rad) ≈ 0.999989; we widen it slightly so it
    // survives the bloom threshold without aliasing into a single pixel.
    float disc = smoothstep(0.99985, 0.99995, cosTheta);
    col += uSunColor * disc * 24.0 * (1.0 - uOvercast * 0.95);

    // Below the horizon, fade to the aerial-perspective haze colour rather than
    // to black: the sea and the far headland both sit in this band.
    col = mix(col, mix(vec3(0.30, 0.28, 0.24), vec3(0.22, 0.23, 0.25), uOvercast), smoothstep(0.0, -0.12, up));

    outColor = vec4(col, 1.0);
    // A custom ShaderMaterial does NOT get three's automatic
    // <tonemapping_fragment>/<colorspace_fragment> injection, so we must apply
    // both by hand or the sky lands in a different colour space from every lit
    // surface next to it — which reads as a washed-out horizon nobody can trace.
    #ifdef TONE_MAPPING
      outColor.rgb = toneMapping(outColor.rgb);
    #endif
    outColor = linearToOutputTexel(outColor);
  }
`;

class PlaceholderSkyDome implements RenderSystem {
  readonly name = 'sky.placeholderDome';
  readonly stage = RenderStage.Scene;
  readonly order = 1;

  private readonly material: THREE.Material;
  private readonly fog: THREE.FogExp2;
  private readonly dir = new THREE.Vector3();
  private readonly colour = new THREE.Color();
  /**
   * The uniform CELLS handed to the factory. We keep the objects and mutate
   * `.value`; the factory holds the same objects, so there is no copy-back step
   * and no second source of truth. `materials.setUniform` is the alternative and
   * does the same thing with a name check.
   */
  private readonly uSunDirection: GpuUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 0.2, -1) };
  private readonly uSunColor: GpuUniform<THREE.Color> = { value: new THREE.Color(1, 0.8, 0.55) };
  private readonly uOvercast: GpuUniform<number> = { value: 0.06 };
  private readonly uTurbidity: GpuUniform<number> = { value: 3.4 };

  constructor(
    scene: SceneGraph,
    materials: MaterialFactory,
    private readonly sky: SkyService,
  ) {
    // Through the factory, not `new THREE.ShaderMaterial`: the sky is unlit and
    // the uber material cannot express it, which is exactly what `createUnlit`
    // is for. `toneMapped` is ON because the dome is drawn into an HDR scene
    // target — a sky in a different colour space from the surfaces next to it
    // reads as a washed-out horizon nobody can trace.
    this.material = materials.createUnlit({
      id: 'sky.placeholderDome',
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        uSunDirection: this.uSunDirection,
        uSunColor: this.uSunColor,
        uOvercast: this.uOvercast,
        uTurbidity: this.uTurbidity,
      },
      side: 'back',
      depthWrite: false,
      depthTest: true,
      toneMapped: true,
    });
    const dome = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    dome.name = 'sky.dome(placeholder)';
    dome.frustumCulled = false;
    // Render first so it fills the depth-cleared framebuffer before anything
    // else; with depthWrite off it can never occlude world geometry.
    dome.renderOrder = -1000;
    scene.group(SceneGroup.Sky).add(dome);

    // Exponential-squared fog stands in for aerial perspective. The real thing
    // is a 3D LUT applied IN-SHADER so transparents, water and particles all
    // receive it consistently — this cannot do that, and it is why the distant
    // headland reads flat until SKY lands.
    this.fog = new THREE.FogExp2(0x9a8f7a, 0.0018);
    scene.root.fog = this.fog;
  }

  update(_ctx: FrameCtx): void {
    const state = this.sky.state;
    this.sky.sunDirection(this.dir);
    this.sky.sunRadiance(this.colour);
    this.uSunDirection.value.copy(this.dir);
    this.uSunColor.value.copy(this.colour);
    this.uOvercast.value = state.overcast;
    this.uTurbidity.value = state.turbidity;
    // Fog takes the horizon haze colour, warmed toward the sun, so the far
    // headland desaturates into the same band the sky occupies behind it.
    this.fog.color.setRGB(
      0.62 * (1 - state.overcast) + 0.42 * state.overcast,
      0.50 * (1 - state.overcast) + 0.42 * state.overcast,
      0.36 * (1 - state.overcast) + 0.44 * state.overcast,
    ).lerp(this.colour, 0.18);
    // Tuned so a 400 m sightline sits around 45% haze: enough aerial perspective
    // to push the headland back, not so much that the map dissolves into fog.
    this.fog.density = state.fogDensity * 0.40 + state.dustDensity * 0.0015;
  }
}

/**
 * Factory referenced by `src/bootstrap/subsystems.ts`.
 *
 * SKY: replace the BODY of this file, keep this signature and this path.
 */
export function createSkyService(ctx: BootContext): SkyService {
  const sky = trackNull(createNullSky());
  ctx.addRender(new PlaceholderSkyDome(ctx.services.scene, ctx.services.materials, sky));
  return sky;
}

/** Transmittance / multi-scatter LUTs and the 128x128x32 cloud volume. */
export function registerSkyBakes(_assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  // The placeholder dome is an inline shader, not a baked asset.
}

/**
 * Harness reset chain. Clouds and aerial perspective are temporal feedback
 * loops (architecture 8.2): either converge inside the shot's frame count from
 * a clean state here, or declare a higher `frames` on the `ShotSpec`.
 */
export function resetSky(_seed: number): void {
  // The placeholder dome is stateless.
}
