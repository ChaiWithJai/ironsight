/**
 * The six viewmodel materials. WEAPONS owns this file.
 *
 * Six is the entire budget. `MaterialFactory.permutationCap` is 24–40 for the
 * whole game and fifteen other lanes are drawing from it, so a weapon that
 * wants twelve materials is a weapon that gets cut. The split is by SHADING
 * BEHAVIOUR, not by part: everything that is a painted-aluminium receiver
 * shades identically whether it is the upper, the rail or the optic housing.
 *
 * FOUR OF THE SIX WRITE THEIR OWN SURFACE. `SurfaceId.PaintedMetal` and
 * `BareMetal` both alias onto the harbour's `mat.rusted_metal` bake and
 * `Fabric` onto `mat.stucco` (`src/bake/textures.ts`), which is right for a
 * crane and a wall and catastrophic on a rifle: a 2.6 m repeat of rust-orange
 * corroded sheet sampled across a 44 mm receiver is one blown-up blotch. The
 * gunmetal, the polymer and the glove are therefore authored in
 * `surface.ts` and injected through `MaterialFactory.registerSurface`, which
 * keeps them inside the one lighting model — CSM, GTAO, clustered lights,
 * aerial perspective — while replacing the palette. See that file for why the
 * detail is generated rather than fetched.
 *
 * `tilingScale` and `detailScale` still matter even so: the bake's NORMAL and AO
 * maps survive underneath the chunk, and the uber material adds a detail normal
 * on top of both. All three are NORMAL sources, all three feed the same
 * hemisphere light, and getting their frequencies wrong is what made a receiver
 * read as aggregate — see `WEAPON_TILING` and the `detailScale` note below.
 */
import type * as THREE from 'three';
import { MaterialFeature, SurfaceId, type MaterialFactory } from '@/engine/types';
import type { PartRole } from '@/weapons/models/build';
import { opticLensChunk, weaponSurfaceChunk } from '@/weapons/viewmodel/surface';

export type RoleMaterials = Readonly<Record<PartRole, THREE.Material>>;

/**
 * Divisor on the bake's own repeat rate. The harbour bakes run 1.8–2.6 m; /14
 * puts one repeat at 130–186 mm, so the recipe's coarsest octave (3 per repeat)
 * lands at ~5 cm and its finest (48 per repeat) at 3.9 mm.
 *
 * ROUND 3 TOOK IT FROM 40 DOWN TO 14, reversing the round-2 move, and the
 * measurement that forced it is worth writing down because the intuition points
 * the wrong way.
 *
 * All the surface chunk keeps of the bake is its NORMAL and AO — the albedo is
 * overwritten outright. A normal map's SLOPE is its amplitude over its
 * wavelength, so shortening the repeat does not add detail, it adds TILT: at /40
 * the finest octave was 1.4 mm and every one of those 1.4 mm facets picked its
 * own colour off the hemisphere light, the up-tilted ones blue and the
 * down-tilted ones warm. Six pixels of blue against six pixels of orange, across
 * a whole receiver panel, is the "low-resolution greyscale gravel reading as
 * concrete" the round-2 critic saw — and no albedo change could have fixed it,
 * because it was never in the albedo.
 *
 * Lengthening the repeat 2.9x divides that tilt by 2.9 and moves what remains
 * from a 6-pixel dazzle to a 20-pixel undulation, which is form rather than
 * noise. The fine band is not lost: `surface.ts` supplies it analytically at
 * 1.4 mm with a slope authored for bead blast rather than for rusted sheet.
 *
 * The second win is the curvature signal. `wpnEdge` reads the screen-space
 * divergence of this same normal to find chamfers, and at /40 the map's own
 * noise floor cleared the threshold on flat panels, spraying edge wear over
 * them as silver speckle. At /14 the floor drops below it and the wear lands
 * where the geometry actually is.
 */
const WEAPON_TILING = 14;

export function buildViewmodelMaterials(materials: MaterialFactory): RoleMaterials {
  const layer = (id: string, surface: SurfaceId): number => {
    const tex = materials.textures(surface);
    return materials.allocateLayer(id, tex.albedoHeight, tex.normalRoughAo);
  };

  /**
   * The four SOLID roles say so out loud rather than relying on the factory's
   * defaults (`blending ?? (transparent ? 'alpha' : 'opaque')`,
   * `depthWrite ?? !transparent`). The defaults are correct today and this
   * changes nothing about the frame — it is here because "is the viewmodel
   * being drawn with transparency or depthWrite off?" is a question that came up
   * in review and cost real time to answer, and a spec that states the answer
   * cannot be misread the next time. The only two roles allowed to be
   * transparent on this weapon are the combiner and the dot, and both say so
   * explicitly below.
   */
  const solid = { transparent: false, depthWrite: true, depthTest: true } as const;

  /* AND WHY ALL FOUR SOLID ROLES NOW ASK FOR `MaterialFeature.None`.
   *
   * `DetailNormal` is the uber material's own two-band procedural normal, and on
   * a wall it is exactly right. On a weapon it is REDUNDANT and destructive:
   * `surface.ts` already writes a bead-blast grain at 1.4 mm and a broaching
   * pattern at 6 mm, both authored with slopes measured for machined metal, and
   * the uber bands sit on top of them at `20 x detailScale` and six times that
   * again. At the bottom of an ADS frame the buttstock passes within 5 cm of the
   * eye, where the micro band lands at well under a pixel — so it contributes no
   * detail at all, only per-pixel normal noise, and that noise sampled against a
   * sky-over-ground hemisphere is the blue-and-orange speckle that three
   * successive round-3 attempts (bake frequency, curvature source, roughness
   * amplitude) failed to shift, because none of them were the source.
   *
   * `detailScale` is kept on the specs below even though the feature bit is off:
   * it is the only place the intended mesoscale of each role is written down,
   * and turning the bit back on without it would put the band at 5 cm.
   */

  /* A NOTE ON `detailScale`, WHICH IS THE THIRD NORMAL SOURCE AND WAS THE
   * LOUDEST OF THE THREE.
   *
   * `iron-material.ts` turns it into `20 x detailScale` repeats per METRE and
   * then runs a micro band a further 6x up. The round-2 values (42-140) put the
   * weapon's detail band at 0.4-1.2 mm and its micro band at 0.07-0.2 mm — i.e.
   * both at or below one pixel even in ADS. Sub-pixel normal detail does not
   * resolve as detail; it resolves as per-pixel normal noise, which under a
   * two-colour hemisphere is exactly the blue-and-orange speckle that made a
   * receiver read as aggregate. Round 3 brings the detail band to 4.5-5.6 mm
   * (20-26 px in ADS, ~2 px at hipfire) where it is legible as machining.
   *
   * They stay ABOVE 8 deliberately: `iron-material.ts` reads `detailScale > 8`
   * as "this is a weapon, not a wall" and drops the parallax depth from 12 mm to
   * 2 mm. Fall under 8 and the uber material starts parallax-shifting a rifle by
   * a centimetre.
   */

  // Registered BEFORE any create() that names them — the factory throws
  // otherwise, which is the correct place to find out rather than at first draw.
  //
  // Colours are LINEAR. Cerakote is a dark desaturated green-grey with a warm
  // cast: pure black has no shading information anywhere and mid-grey reads as
  // untextured clay, so the finish sits at ~0.055 linear, which is a 25 % sRGB
  // value — dark enough to be a weapon, bright enough for the golden-hour key
  // to model the form.
  materials.registerSurface(
    'weapon.receiver',
    weaponSurfaceChunk({
      base: [0.0552, 0.0602, 0.0492],
      // Cerakote over 7075 aluminium: what shows through is bright bare metal.
      substrate: [0.322, 0.334, 0.351],
      roughness: 0.42,
      // Paint is a dielectric FILM over metal, so the unworn finish is barely
      // metallic; only where it is gone does the substrate assert itself.
      metalness: 0.10,
      substrateMetalness: 0.95,
      wear: 0.85,
      fouling: 0.7,
      streak: 0.13,
      grain: 0.9,
    }),
  );

  materials.registerSurface(
    'weapon.steel',
    weaponSurfaceChunk({
      // Manganese-phosphated steel: genuinely metal, and dark because the
      // phosphate conversion coat is porous and scatters.
      base: [0.118, 0.121, 0.128],
      substrate: [0.505, 0.512, 0.527],
      roughness: 0.34,
      metalness: 1.0,
      substrateMetalness: 1.0,
      wear: 0.95,
      // The barrel, the muzzle device and the gas block take nearly all of it.
      fouling: 1.0,
      streak: 0.16,
      grain: 0.7,
    }),
  );

  materials.registerSurface(
    'weapon.polymer',
    weaponSurfaceChunk({
      // FLAT DARK EARTH glass-filled nylon, and the two-tone is the point.
      //
      // The round-1 critique was that the viewmodel has "no recognisable weapon
      // silhouette", and a monochrome weapon is most of why: every reference
      // frame in the corpus (`bf6_gp_032`, `bf2042_gp_000`, `bf6_gp_024`) shows
      // a DARK receiver, rail and barrel against TAN furniture — handguard,
      // grip, magazine, stock — and that single value break is what lets an eye
      // parse a rifle in a tenth of a second. At 0.157 linear the furniture is
      // 2.8× the receiver, which separates hard, and it is still well under
      // sunlit sandstone at 0.35 so the weapon does not dissolve into this
      // town's walls.
      base: [0.1570, 0.1075, 0.0512],
      // Polymer does not wear to metal; it BURNISHES, going darker and shinier
      // where a hand has been.
      substrate: [0.0905, 0.0602, 0.0288],
      roughness: 0.66,
      metalness: 0.0,
      substrateMetalness: 0.0,
      wear: 0.55,
      fouling: 0.35,
      // No brushing on a moulded part.
      streak: 0.0,
      // Moulding texture is coarser and softer than bead blast.
      grain: 1.15,
    }),
  );

  materials.registerSurface(
    'weapon.glove',
    weaponSurfaceChunk({
      // Nomex over a leather palm. Lifted from 0.039 to 0.062 linear after the
      // round-1 read: at the lower value the support hand merged into the
      // handguard and the critique recorded "no hands anywhere in frame" on a
      // frame that had two. It sits BETWEEN the dark receiver and the tan
      // furniture, which is where a real glove sits and is what lets the hand
      // separate from both.
      base: [0.0622, 0.0538, 0.0424],
      // Knuckle plate and finger ridges scuff pale and dusty, not shiny.
      substrate: [0.1080, 0.0905, 0.0668],
      roughness: 0.90,
      metalness: 0.0,
      substrateMetalness: 0.0,
      wear: 0.40,
      fouling: 0.0,
      streak: 0.0,
      grain: 1.4,
    }),
  );

  materials.registerSurface('weapon.lens', opticLensChunk());

  const receiver = materials.create({
    ...solid,
    id: 'weapon.receiver',
    surface: SurfaceId.PaintedMetal,
    layer: layer('weapon.receiver', SurfaceId.PaintedMetal),
    features: MaterialFeature.None,
    surfaceShader: 'weapon.receiver',
    tilingScale: WEAPON_TILING,
    baseColor: 0x33362f,
    roughness: 0.44,
    metalness: 0.18,
    detailScale: 9,
  });

  const steel = materials.create({
    ...solid,
    id: 'weapon.steel',
    surface: SurfaceId.BareMetal,
    layer: layer('weapon.steel', SurfaceId.BareMetal),
    features: MaterialFeature.None,
    surfaceShader: 'weapon.steel',
    tilingScale: WEAPON_TILING,
    baseColor: 0x4a4a4c,
    roughness: 0.31,
    metalness: 1.0,
    detailScale: 10,
  });

  // NOTE on `baseColor` in the four chunk-driven specs below: the surface chunk
  // writes `diffuseColor.rgb` outright, so these tints no longer reach the
  // frame. They are kept in step with the chunk's own `base` anyway, because a
  // spec whose stated colour disagrees with what it draws is a trap for the next
  // person to read it.
  const polymer = materials.create({
    ...solid,
    id: 'weapon.polymer',
    surface: SurfaceId.Rubber,
    layer: layer('weapon.polymer', SurfaceId.Rubber),
    features: MaterialFeature.None,
    surfaceShader: 'weapon.polymer',
    tilingScale: WEAPON_TILING,
    baseColor: 0x6f5c40,
    roughness: 0.68,
    metalness: 0.0,
    detailScale: 11,
  });

  // The optic combiner. Transparent, DEPTH-WRITE OFF and driven by
  // `weapon.lens`, so the reticle in front of it and the world behind it both
  // composite correctly and the sight picture is something the player can
  // actually see through.
  const glass = materials.create({
    id: 'weapon.glass',
    surface: SurfaceId.Glass,
    layer: layer('weapon.glass', SurfaceId.Glass),
    features: MaterialFeature.None,
    surfaceShader: 'weapon.lens',
    baseColor: 0x2a3a34,
    roughness: 0.06,
    metalness: 0.0,
    transparent: true,
    depthWrite: false,
    blending: 'alpha',
  });

  // The reticle. This is the one thing in the game that genuinely EMITS, which
  // is what makes additive blending correct here and a defect almost anywhere
  // else.
  //
  // `emissiveIntensity` is DRIVEN AT RUNTIME by the rig (`updateLightRig`), not
  // set here, and that is not a refinement — it is the difference between a
  // visible reticle and no reticle at all. This renderer works in absolute
  // photometric units: the sun is ~47 000 lux and sunlit sandstone leaves the
  // shader at ~5 000 cd/m² before the derived exposure divides it down. A
  // reticle authored at 3.5 is four thousand times under the scene and vanishes.
  // A shooter turns the dot up until it beats the background, so the rig does
  // the same thing from the live sun and sky illuminance. The value here is
  // only what the first frame uses before the rig has run once.
  const reticle = materials.create({
    id: 'weapon.reticle',
    surface: SurfaceId.Glass,
    layer: layer('weapon.reticle', SurfaceId.Glass),
    features: MaterialFeature.Emissive,
    baseColor: 0x120000,
    emissive: 0xff2a12,
    emissiveIntensity: 2200,
    roughness: 1,
    metalness: 0,
    blending: 'additive',
    transparent: true,
    depthWrite: false,
  });

  const glove = materials.create({
    ...solid,
    id: 'weapon.glove',
    surface: SurfaceId.Fabric,
    layer: layer('weapon.glove', SurfaceId.Fabric),
    features: MaterialFeature.None,
    surfaceShader: 'weapon.glove',
    tilingScale: WEAPON_TILING,
    baseColor: 0x453f38,
    roughness: 0.88,
    metalness: 0.0,
    detailScale: 14,
  });

  return { receiver, steel, polymer, glass, reticle, glove };
}
