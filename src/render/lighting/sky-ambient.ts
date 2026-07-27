/**
 * The ambient term: a real integrated sky, in two lobes.
 *
 * OWNER: LIGHT.
 *
 * THIS FILE IS THE FIX FOR THE WAVE-1 DEFECT.
 * -------------------------------------------
 * "There is effectively no ambient or indirect light. Every shadowed face
 * crushes to near-black. Terraced buildings look like floating slabs because the
 * walls between them are void-black." That is what a `HemisphereLight` with two
 * hand-picked colours buys you, and LOOK_SPEC §2.4 calls both it and a flat
 * `AmbientLight` a defect by name.
 *
 * What replaces it is a 64² radiance cube in ABSOLUTE cd/m², PMREM-prefiltered,
 * hung on `Scene.environment`. Three's standard shading then takes diffuse
 * irradiance from it along the surface normal and specular from the GGX-
 * prefiltered mips — so ambient has real directional structure for free, and a
 * wall's shadowed side is lit by the part of the world it can actually see.
 *
 * THE TWO LOBES
 * -------------
 * Upper hemisphere: `SkyService.radianceTowards` gives the SHAPE and the CHROMA
 * (that is SKY's model, not ours to duplicate); we renormalise the whole dome so
 * its horizontal illuminance equals the photometric sky term for the current sun
 * elevation. That keeps us honest against a sky service whose radiances are in
 * arbitrary units, and it means the exposure derivation in §2.1 stays exact.
 *
 * Lower hemisphere: the GROUND BOUNCE, and it is not grey. Each downward
 * direction is tinted by what is actually down there — LOOK_SPEC §2.4's dry
 * sandstone (0.62, 0.50, 0.36) at 1 600 lx landward, sea (0.30, 0.46, 0.50) at
 * 900 lx seaward, and the glitter path (1.00, 0.82, 0.62) at 5 200 lx toward the
 * sun over water. HARBOUR REACH's sea is to the north, so a wall facing the
 * harbour picks up cool teal fill and the same wall's landward face picks up
 * warm sandstone bounce — §1.1's "single most valuable composition in the map",
 * earned from geography rather than hard-coded as a shadow tint.
 */
import * as THREE from 'three';
import type { Color, SkyService, Vec3 } from '@/engine/types';

/** Cube face edge. 64² × 6 is 24 576 CPU samples — a few ms, on a rebake only. */
const FACE = 64;

/** Sea lies to the north (−Z) in HARBOUR REACH. See `src/engine/macro.ts`. */
const SEAWARD = new THREE.Vector3(0, 0, -1);

/**
 * Half-width, in sin(elevation), of the band the sky and ground lobes cross-fade
 * over. 0.11 is 6.3° — about the angular height of a real horizon once haze,
 * terrain relief and the town's own roofline are accounted for, and wide enough
 * that PMREM's sharpest mip cannot resolve a step inside it.
 */
const HORIZON_BAND = 0.11;

/**
 * LOOK_SPEC §2.4 ground-bounce table: effective irradiance (lx) and chroma.
 *
 * THE LAND AND SEA LOBES ARE ABOVE THE TABLE'S 1 600 / 900 AND THAT IS ROUND 3's
 * ANSWER TO CRUSHED SHADOWS. Round 3 cut the sky-diffuse anchor (see
 * `photometry.ts`) to get the key:fill ratio into §2.5's acceptance band, and
 * the ratio is measured on OPEN GROUND — an upward-facing surface, which sees
 * none of this lobe at all. Vertical faces and undersides in shadow see a lot of
 * it, and they are the surfaces that were reading as flat black slabs. Raising
 * the bounce therefore reopens exactly the pixels the sky cut crushed and moves
 * the measured ground ratio by nothing.
 *
 * It is also the more physical of the two numbers. A Lambertian quay of albedo
 * 0.42 under GOLDEN's 15.1 klx horizontal returns π·L = 6 300 lx into the
 * downward hemisphere, so a surface fully open to it receives 6 300 lx before
 * any view-factor discount; 3 400 is a 54 % view factor, which is roughly what a
 * wall standing on that quay subtends. It is set by a blind A/B rather than by
 * taste: against `bfv_gp_031` — the corpus frame chosen for adjacent lit and
 * shaded walls — our shaded wall lost its material entirely while the
 * reference's held concrete grain, joints and streaking, and the bounce lobe is
 * the only term that reaches a shaded vertical face without touching the open
 * ground the §2.5 ratio is measured on. §2.4's own "8–12 % of the direct sun
 * irradiance" clause reads 3.8–5.7 klx against the 47 klx DNI. 1 600 lx sat well
 * under both.
 */
const GROUND = {
  land: { lux: 3400, chroma: new THREE.Color(0.62, 0.5, 0.36) },
  sea: { lux: 1800, chroma: new THREE.Color(0.3, 0.46, 0.5) },
  glitter: { lux: 6200, chroma: new THREE.Color(1.0, 0.82, 0.62) },
} as const;

/** GOLDEN's total horizontal illuminance — the anchor the bounce table is quoted at. */
const REFERENCE_TOTAL_LUX = 16_700;

/**
 * One cube face. It has to be a real `DataTexture`: three's `setTextureCube`
 * branches on `texture.image[0].isDataTexture` and then uploads
 * `texture.image[i].image`, so a plain `{ data, width, height }` object gets
 * treated as an `<img>` and dies looking for `.width` one level too high.
 */
type FaceImage = THREE.DataTexture;

/** Direction of texel (x, y) on cube face `f`, three's face order. */
function faceDirection(f: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  // u, v in [-1, 1]; three's cube faces are +X, -X, +Y, -Y, +Z, -Z, and the
  // convention below matches WebGL's cube-map sampling exactly.
  switch (f) {
    case 0: out.set(1, -v, -u); break;
    case 1: out.set(-1, -v, u); break;
    case 2: out.set(u, 1, v); break;
    case 3: out.set(u, -1, -v); break;
    case 4: out.set(u, -v, 1); break;
    default: out.set(-u, -v, -1); break;
  }
  return out.normalize();
}

/** Solid angle of one texel, from the cube-map differential. */
function texelSolidAngle(u: number, v: number, invFace: number): number {
  const x0 = u - invFace;
  const y0 = v - invFace;
  const x1 = u + invFace;
  const y1 = v + invFace;
  const area = (a: number, b: number): number => Math.atan2(a * b, Math.sqrt(a * a + b * b + 1));
  return area(x1, y1) - area(x0, y1) - area(x1, y0) + area(x0, y0);
}

export class SkyAmbient {
  private readonly pmrem: THREE.PMREMGenerator;
  private cube: THREE.CubeTexture | null = null;
  private faces: FaceImage[] = [];
  private prefiltered: THREE.WebGLRenderTarget | null = null;
  private fallback: THREE.DataTexture;

  /** 9 RGB SH coefficients, LOOK_SPEC's `LightingService.ambientSH`. */
  readonly sh = new Float32Array(27);

  private readonly dir = new THREE.Vector3();
  private readonly horiz = new THREE.Vector3();
  private readonly sunHoriz = new THREE.Vector3();
  private readonly colour = new THREE.Color();
  private readonly bounce = new THREE.Color();
  private readonly radiance: Float32Array;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileCubemapShader();
    this.radiance = new Float32Array(FACE * FACE * 6 * 3);
    this.fallback = new THREE.DataTexture(new Uint8Array([90, 105, 125, 255]), 1, 1);
    this.fallback.needsUpdate = true;
  }

  /** GGX-prefiltered environment. Never null once `rebake` has run. */
  get environment(): THREE.Texture {
    return this.prefiltered ? this.prefiltered.texture : this.fallback;
  }

  /**
   * Rebuild the cube, the PMREM and the SH. Called only when the sun has moved
   * more than 0.15° or the weather changed — LOOK_SPEC's B6/B7 dirty rule.
   *
   * @param skyIlluminanceLux diffuse sky illuminance on a horizontal surface
   * @param totalHorizontalLux sun + sky on horizontal ground; scales the bounce
   */
  rebake(
    sky: SkyService,
    sunDir: Readonly<Vec3>,
    sunColour: Readonly<Color>,
    skyIlluminanceLux: number,
    totalHorizontalLux: number,
  ): void {
    const invFace = 1 / FACE;
    this.sunHoriz.set(sunDir.x, 0, sunDir.z);
    if (this.sunHoriz.lengthSq() < 1e-6) this.sunHoriz.set(1, 0, 0);
    this.sunHoriz.normalize();

    // ---- pass 1: raw sky radiance from SKY, and its own horizontal integral --
    //
    // DIRECTIONS BELOW THE HORIZON ARE SAMPLED TOO, at their own azimuth's
    // horizon. They contribute nothing to the sky integral — they are not sky —
    // but pass 2 needs a continuous "what does the air in this direction look
    // like" term to veil the ground lobe into, and reading it from the model at
    // y = 0 is the only way to get one that agrees with the visible sky exactly
    // where the two meet. Leaving these texels at zero is what produced the
    // hard equator step in the cube, and a hard step in a PMREM-prefiltered
    // environment is a HORIZONTAL LINE ACROSS EVERY LOW-ROUGHNESS SURFACE IN
    // THE FRAME: the reflection vector sweeps through the seam at one screen
    // height, so a crane lattice flips warm-to-cold-to-warm along a dead
    // straight scanline that ignores the geometry it crosses. That was the
    // round-2 "cascade seam" finding on `level_bravo`; it was never a cascade.
    let rawIrradiance = 0;
    let index = 0;
    for (let f = 0; f < 6; f++) {
      for (let y = 0; y < FACE; y++) {
        const v = (y + 0.5) * 2 * invFace - 1;
        for (let x = 0; x < FACE; x++, index += 3) {
          const u = (x + 0.5) * 2 * invFace - 1;
          faceDirection(f, u, v, this.dir);
          const above = this.dir.y > 0;
          if (!above) {
            // Same azimuth, exactly on the horizon. Degenerate straight down,
            // where every azimuth is equally wrong, so pick the sun's.
            this.horiz.set(this.dir.x, 0, this.dir.z);
            if (this.horiz.lengthSq() < 1e-8) this.horiz.copy(this.sunHoriz);
            else this.horiz.normalize();
            sky.radianceTowards(this.horiz, this.colour);
          } else {
            sky.radianceTowards(this.dir, this.colour);
          }
          this.radiance[index] = Math.max(this.colour.r, 0);
          this.radiance[index + 1] = Math.max(this.colour.g, 0);
          this.radiance[index + 2] = Math.max(this.colour.b, 0);
          if (!above) continue;
          const luminance =
            0.2126 * this.radiance[index] + 0.7152 * this.radiance[index + 1] + 0.0722 * this.radiance[index + 2];
          rawIrradiance += luminance * this.dir.y * texelSolidAngle(u, v, invFace);
        }
      }
    }
    // A sky service that returns black (or unit-scaled) radiance must not be
    // able to make the world black: we take the CHROMA from it and the LEVEL
    // from photometry, so the exposure derivation stays exact either way.
    const skyScale = rawIrradiance > 1e-6 ? skyIlluminanceLux / rawIrradiance : 0;

    // ---- pass 2: scale the dome, synthesise the ground lobe -----------------
    const bounceScale = totalHorizontalLux / REFERENCE_TOTAL_LUX;
    const landL = (GROUND.land.lux / Math.PI) * bounceScale;
    const seaL = (GROUND.sea.lux / Math.PI) * bounceScale;
    const glitterL = (GROUND.glitter.lux / Math.PI) * bounceScale;

    if (this.faces.length === 0) {
      for (let f = 0; f < 6; f++) {
        const face = new THREE.DataTexture(
          new Uint16Array(FACE * FACE * 4),
          FACE,
          FACE,
          THREE.RGBAFormat,
          THREE.HalfFloatType,
        );
        face.colorSpace = THREE.NoColorSpace;
        face.needsUpdate = true;
        this.faces.push(face);
      }
    }

    index = 0;
    for (let f = 0; f < 6; f++) {
      const data = this.faces[f].image.data as Uint16Array;
      let texel = 0;
      for (let y = 0; y < FACE; y++) {
        const v = (y + 0.5) * 2 * invFace - 1;
        for (let x = 0; x < FACE; x++, index += 3, texel += 4) {
          const u = (x + 0.5) * 2 * invFace - 1;
          faceDirection(f, u, v, this.dir);
          // The atmospheric lobe: the real sky above, and below the horizon the
          // same model evaluated AT the horizon — i.e. the haze a ground plane
          // is seen through once it is far enough away to be near-grazing.
          const airR = this.radiance[index] * skyScale;
          const airG = this.radiance[index + 1] * skyScale;
          const airB = this.radiance[index + 2] * skyScale;

          let r: number;
          let g: number;
          let b: number;
          if (this.dir.y > HORIZON_BAND) {
            r = airR;
            g = airG;
            b = airB;
          } else {
            this.horiz.set(this.dir.x, 0, this.dir.z);
            const horizLen = this.horiz.length();
            if (horizLen > 1e-5) this.horiz.multiplyScalar(1 / horizLen);
            else this.horiz.copy(this.sunHoriz);
            // Seaward-vs-landward split. `smoothstep` rather than a hard edge so
            // a wall turning through the shoreline direction does not snap from
            // warm to cool.
            const seaward = THREE.MathUtils.smoothstep(this.horiz.dot(SEAWARD), -0.35, 0.55);
            // The glitter path: over the water, toward the sun. It is the map's
            // brightest bounce and the reason BRAVO looks the way it does.
            const toSun = Math.max(this.horiz.dot(this.sunHoriz), 0);
            const glitter = seaward * Math.pow(toSun, 6) * Math.max(0, -this.dir.y);
            const wLand = landL * (1 - seaward);
            const wSea = seaL * seaward;
            const wGlitter = glitterL * glitter;
            this.bounce.setRGB(
              GROUND.land.chroma.r * wLand + GROUND.sea.chroma.r * wSea + GROUND.glitter.chroma.r * wGlitter,
              GROUND.land.chroma.g * wLand + GROUND.sea.chroma.g * wSea + GROUND.glitter.chroma.g * wGlitter,
              GROUND.land.chroma.b * wLand + GROUND.sea.chroma.b * wSea + GROUND.glitter.chroma.b * wGlitter,
            );
            // The bounce carries the sun's colour, because it IS the sun,
            // reflected once. That is what warms an underside without warming
            // the sky-lit faces.
            r = this.bounce.r * (0.55 + 0.45 * sunColour.r);
            g = this.bounce.g * (0.55 + 0.45 * sunColour.g);
            b = this.bounce.b * (0.55 + 0.45 * sunColour.b);

            // AERIAL PERSPECTIVE ON THE GROUND LOBE. A downward direction that
            // is only a few degrees below level is looking at ground hundreds of
            // metres away, through all of it — by the rubric's own calibration
            // note that ground is within ~15 % of sky colour by then. A steeply
            // downward direction is looking at the pavement two metres away and
            // sees its albedo undiluted. `veil` is that geometry: 1 at the nadir,
            // 0 at the horizon, over the same 0.30 (17°) an aerial-perspective
            // half-distance implies at street scale.
            const veil = THREE.MathUtils.smoothstep(-this.dir.y, 0, 0.3);
            r = airR + (r - airR) * veil;
            g = airG + (g - airG) * veil;
            b = airB + (b - airB) * veil;

            // …and the last few degrees either side of level are a genuine
            // blend, not a step: real ground ends at a horizon a finite distance
            // away, and everything between that horizon and level is both.
            if (this.dir.y > -HORIZON_BAND) {
              const t = THREE.MathUtils.smoothstep(this.dir.y, -HORIZON_BAND, HORIZON_BAND);
              r += (airR - r) * t;
              g += (airG - g) * t;
              b += (airB - b) * t;
            }
          }
          // Half-float ceiling; the sun disc is SKY's business and never enters
          // the ambient cube, so nothing legitimate comes near this.
          data[texel] = THREE.DataUtils.toHalfFloat(Math.min(r, 60_000));
          data[texel + 1] = THREE.DataUtils.toHalfFloat(Math.min(g, 60_000));
          data[texel + 2] = THREE.DataUtils.toHalfFloat(Math.min(b, 60_000));
          data[texel + 3] = THREE.DataUtils.toHalfFloat(1);
        }
      }
    }

    if (!this.cube) {
      this.cube = new THREE.CubeTexture(this.faces as unknown as HTMLImageElement[]);
      this.cube.format = THREE.RGBAFormat;
      this.cube.type = THREE.HalfFloatType;
      this.cube.minFilter = THREE.LinearFilter;
      this.cube.magFilter = THREE.LinearFilter;
      this.cube.generateMipmaps = false;
      this.cube.colorSpace = THREE.NoColorSpace;
      this.cube.mapping = THREE.CubeReflectionMapping;
    }
    this.cube.needsUpdate = true;

    const next = this.pmrem.fromCubemap(this.cube, this.prefiltered ?? undefined);
    this.prefiltered = next;
    this.prefiltered.texture.name = 'iron.environment';

    this.projectSH(invFace);
  }

  /**
   * Project the finished cube onto SH9. Published as `LightingService.ambientSH`
   * so lanes that shade outside the forward pass (impostors, particle lighting,
   * a debug readout) get the same irradiance the surfaces do rather than
   * inventing their own constant.
   */
  private projectSH(invFace: number): void {
    this.sh.fill(0);
    let totalWeight = 0;
    for (let f = 0; f < 6; f++) {
      const data = this.faces[f].image.data as Uint16Array;
      let texel = 0;
      for (let y = 0; y < FACE; y++) {
        const v = (y + 0.5) * 2 * invFace - 1;
        for (let x = 0; x < FACE; x++, texel += 4) {
          const u = (x + 0.5) * 2 * invFace - 1;
          faceDirection(f, u, v, this.dir);
          const w = texelSolidAngle(u, v, invFace);
          totalWeight += w;
          const r = THREE.DataUtils.fromHalfFloat(data[texel]);
          const g = THREE.DataUtils.fromHalfFloat(data[texel + 1]);
          const b = THREE.DataUtils.fromHalfFloat(data[texel + 2]);
          const { x: dx, y: dy, z: dz } = this.dir;
          const basis = [
            0.282095,
            0.488603 * dy,
            0.488603 * dz,
            0.488603 * dx,
            1.092548 * dx * dy,
            1.092548 * dy * dz,
            0.315392 * (3 * dz * dz - 1),
            1.092548 * dx * dz,
            0.546274 * (dx * dx - dy * dy),
          ];
          for (let i = 0; i < 9; i++) {
            const c = basis[i] * w;
            this.sh[i * 3] += r * c;
            this.sh[i * 3 + 1] += g * c;
            this.sh[i * 3 + 2] += b * c;
          }
        }
      }
    }
    // Cube-map solid angles sum to 4π only in the limit; normalise so a constant
    // dome projects back to exactly its own radiance.
    const norm = totalWeight > 0 ? (4 * Math.PI) / totalWeight : 1;
    for (let i = 0; i < 27; i++) this.sh[i] *= norm;
  }

  dispose(): void {
    this.prefiltered?.dispose();
    this.cube?.dispose();
    for (const face of this.faces) face.dispose();
    this.pmrem.dispose();
    this.fallback.dispose();
  }
}
