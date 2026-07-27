/**
 * The weapon SURFACE shaders. WEAPONS owns this file.
 *
 * WHY THESE EXIST AT ALL.
 *
 * `SurfaceId` has 28 members and the bake affords six recipes, so
 * `PaintedMetal`, `BareMetal` and `Grating` all alias onto `mat.rusted_metal`
 * and `Fabric` aliases onto `mat.stucco` (`src/bake/textures.ts`,
 * `SURFACE_ALIASES`). Those bakes are authored for a HARBOUR — a 2.6 m repeat of
 * corroded sheet with rust-orange flecking, and a 1.8 m repeat of lime render.
 * They are correct for a crane and a wall. Sampled across a 44 mm receiver they
 * are a single blown-up rust blotch, which is precisely the "high-contrast
 * splatter that reads as moss or lichen" a critic sees on the viewmodel.
 *
 * No amount of tiling scale fixes that, because the PALETTE is wrong: orange
 * corrosion and pale stone are not what a service rifle is made of. So the
 * weapon writes its own surface through `MaterialFactory.registerSurface`,
 * which is the sanctioned seam for exactly this (`types.ts` §10) — it runs
 * after albedo/normal/roughness resolve and BEFORE lighting, so the weapon
 * still receives CSM, clustered lights, GTAO and aerial perspective identically
 * to every other surface in the frame. That is the difference between a weapon
 * lit like the world and a weapon lit by itself.
 *
 * WHAT IT DRAWS, in the three bands LOOK_SPEC §4.1 asks for:
 *
 *   macro (~7 cm)  — anodising density and handling polish, so the receiver is
 *                    not one flat value from apex to buttpad.
 *   meso  (~2 cm)  — cerakote orange-peel and the fouling gradient toward the
 *                    muzzle, driven off the bore coordinate the box map gives us.
 *   micro (~1.5 mm)— bead-blast grain, stretched 8:1 ALONG the bore so it reads
 *                    as the brushing direction of a machined part.
 *
 * And the thing the noise-splatter map could never do: WEAR ON EDGES. Every
 * part in `models/build.ts` carries a real 0.4–0.8 mm machining chamfer, so a
 * convex edge is where the interpolated shading normal swings hard across two
 * pixels. `length(fwidth(N))` is therefore a genuine curvature signal, and the
 * wear it drives lands on the rail teeth, the magwell lip, the handguard
 * corners and the charging-handle latch — the places a rifle actually goes
 * silver — instead of being sprayed over flat panels by a noise field.
 *
 * COORDINATES. `vUv` here is the weapon-space BOX MAP in metres laid down by
 * `prim.boxProjectUv`, and its `u` runs down the bore on every face whose
 * dominant normal is ±X or ±Y. That single property is what makes the streaking
 * axial and the fouling gradient possible without a second attribute.
 */
import type { SurfaceChunk } from '@/engine/types';

/**
 * Value noise and a four-octave fBm. Hand-rolled rather than fetched, because a
 * texture fetch here would put us straight back on the 2.6 m harbour bake.
 */
const HELPERS = /* glsl */ `
float wpnHash21( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

float wpnValue( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = wpnHash21( i );
  float b = wpnHash21( i + vec2( 1.0, 0.0 ) );
  float c = wpnHash21( i + vec2( 0.0, 1.0 ) );
  float d = wpnHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float wpnFbm( vec2 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 4; i++ ) {
    sum += amp * wpnValue( p );
    p = p * 2.03 + vec2( 17.0, 9.0 );
    amp *= 0.5;
  }
  return sum;
}
`;

/** Everything one weapon material needs to say about itself. */
export interface WeaponSurfaceParams {
  /** LINEAR base colour. `diffuseColor` is linear at the injection point. */
  readonly base: readonly [number, number, number];
  /** LINEAR colour the finish wears THROUGH to on edges. */
  readonly substrate: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
  /** Metalness once the finish is gone. Cerakote over aluminium goes to ~1. */
  readonly substrateMetalness: number;
  /** 0..1 how far edge wear is allowed to go on this material. */
  readonly wear: number;
  /** 0..1 carbon fouling that fades in toward the muzzle. Zero on furniture. */
  readonly fouling: number;
  /**
   * 0..1 strength of the axial brushing streak. Above zero this is the
   * low-roughness anisotropic line down the top of the receiver that makes
   * gunmetal read as metal rather than as dark plastic.
   */
  readonly streak: number;
  /** Micro-relief amplitude, in normal-slope units. */
  readonly grain: number;
  /**
   * Micro-relief cycles per metre ACROSS the bore and ALONG it.
   *
   * The 8:1 default is a machining artefact and belongs only on machined parts:
   * a bead-blasted receiver is combed by the tool path, so its grain is
   * stretched down the bore and reads as brushing. A woven Nomex glove has no
   * tool path and no preferred direction, and running the metal figures on it
   * gave the support hand a corduroy nap that made it read as a rolled sleeve
   * rather than as a fist — a defect visible at ADS scale and at no other.
   */
  readonly grainU?: number;
  readonly grainV?: number;
}

/**
 * Build the surface chunk for one weapon material.
 *
 * Parameters are baked into the GLSL as literals rather than passed as
 * uniforms. `MaterialFactory` throws if two specs declare the same uniform name
 * (`factory.ts`, `bindUniforms`), so four roles sharing one uniform block would
 * mean four different names and four ways to get them out of step — and each
 * role compiles its own program anyway, because `customProgramCacheKey`
 * includes the spec id. Literals cost nothing and cannot drift.
 */
export function weaponSurfaceChunk(p: WeaponSurfaceParams): SurfaceChunk {
  const f = (v: number): string => v.toFixed(5);
  const v3 = (c: readonly [number, number, number]): string =>
    `vec3( ${f(c[0])}, ${f(c[1])}, ${f(c[2])} )`;

  return {
    common: HELPERS,
    shade: /* glsl */ `
    {
      // Weapon-space box map, metres. u runs down the bore on the side, top and
      // bottom faces — which is most of a rifle.
      vec2 wpnUv = vUv;
      float wpnBore = wpnUv.x;

      // ---- the three detail bands -----------------------------------------
      // 1.4 mm across, 11 mm along: bead-blast grain combed by the machining
      // pass. The 8:1 aspect IS the anisotropy — an isotropic grain at this
      // frequency reads as sand.
      float wpnGrain = wpnFbm( vec2( wpnBore * ${f(p.grainU ?? 88)}, wpnUv.y * ${f(p.grainV ?? 700)} ) );
      // ~4.5 mm: cerakote orange-peel and anodising density.
      //
      // ROUND 3 TOOK THIS FROM 56 (1.8 cm) TO 210. The frequency is the whole
      // finding: at an ADS eye relief of 0.295 m and a 44° viewmodel FOV, the
      // 41 mm optic housing is 200 px tall, so an 18 mm feature is a 90-pixel
      // blotch. Ninety-pixel grey blotches with a two-octave falloff are what
      // gravel looks like, and the round-2 critique read them exactly that way:
      // "a low-resolution greyscale gravel noise reading as concrete, not
      // gunmetal". Real cerakote orange-peel is under a millimetre; 4.5 mm is
      // the compromise that survives one mip level down at hipfire distance and
      // still lands at 22 px in ADS, which is texture rather than terrain.
      float wpnMeso = wpnFbm( wpnUv * 210.0 );
      // ~7 cm: which parts of this weapon have been handled.
      float wpnMacro = wpnValue( wpnUv * 13.0 + vec2( 4.7, 1.3 ) );

      // ---- curvature -------------------------------------------------------
      // The divergence of the shading normal across one pixel. On a chamfered
      // edge it spikes; on a flat panel it is ~0. This is the edge-weighted
      // mask the wear rides, and it is why the silver lands on rail teeth and
      // magwell lips rather than in the middle of the receiver flat.
      // ROUND 3 MOVED THIS OFF normal AND ONTO vNormal, AND IT IS THE FIX
      // FOR THE WHOLE "RECEIVER READS AS AGGREGATE" FAMILY OF DEFECTS.
      //
      // normal at this point in the shader has been through the bake's normal
      // map AND the uber material's detail and micro normal bands. The micro
      // band alone runs at 6x the detail frequency, which puts it at or under
      // one pixel — so dFdx( normal ) is not measuring curvature, it is
      // measuring per-pixel noise, and it SATURATES on flat panels. The wear it
      // gates then fires everywhere, and wear is not a subtle term: it lifts the
      // albedo 6x toward bare metal AND takes metalness from 0.10 to 0.95. A
      // scatter of near-mirror metal specks across a flat panel reflects the sky
      // on one pixel and the sunlit street on the next, which is the actual
      // mechanism behind the blue-and-orange speckle a critic reads as lichen on
      // concrete. Two earlier round-3 attempts — dropping the normal-map
      // frequency, then raising this threshold to 0.32 — both failed because
      // they treated the symptom while the input stayed noisy.
      //
      // vNormal is the INTERPOLATED VERTEX normal, before any map touches it.
      // Its screen derivative is zero across a flat panel, ~0.04 across a
      // smooth-shaded barrel facet, and 0.3-0.5 across the two pixels of a
      // 0.6 mm machining chamfer. That is a real curvature signal with a real
      // zero, which is what an edge-wear mask needs and what puts the silver on
      // the rail teeth and the magwell lip instead of over everything.
      //
      // ROUND 5 DIVIDED IT BY THE TEXEL FOOTPRINT, AND THAT TURNED A SCREEN-SPACE
      // MEASURE INTO A PHYSICAL ONE. This is the fix for a defect that made the
      // same weapon look like two different objects at two distances.
      //
      // sqrt(|dNdx|^2 + |dNdy|^2) is radians of normal swing PER PIXEL, so its
      // value at a given chamfer depends entirely on how many pixels that
      // chamfer happens to occupy. A 0.6 mm chamfer at the ADS eye relief is 3 px
      // and reads 0.5; the same chamfer at the hipfire distance is under a pixel
      // and reads 1.0 — and so does every smooth-shaded facet on the barrel and
      // the optic tube, because at that scale everything is curvy. The mask
      // therefore SATURATED across the whole weapon in hipfire, took the albedo
      // to the 0.322 substrate and the metalness to 0.78, and rendered a
      // cerakoted carbine as a brass one. Measured on the round-4 hipfire frame:
      // the weapon's sunlit side ran 0.75/0.60/0.35 sRGB, which is polished
      // bronze, not a service rifle.
      //
      // Dividing by fwidth(uv) — metres of surface per pixel, which the
      // weapon-space box map gives us for free — converts the numerator to
      // radians per METRE, a property of the geometry alone. A flat panel is 0
      // whatever the distance, a 20 mm-radius tube is 1/R = 50, and a 0.6 mm
      // machining chamfer is ~2600. The band below sits between the last two, so
      // the wear lands on chamfers and only on chamfers, at every distance.
      vec3 wpnDnx = dFdx( vNormal );
      vec3 wpnDny = dFdy( vNormal );
      float wpnTexel = max( length( vec2( fwidth( wpnUv.x ), fwidth( wpnUv.y ) ) ), 1e-6 );
      float wpnCurv = sqrt( dot( wpnDnx, wpnDnx ) + dot( wpnDny, wpnDny ) ) / wpnTexel;
      // Radians per metre. 500 is ten times a 20 mm-radius smooth tube and a
      // fifth of a 0.6 mm chamfer, so a cylinder never reaches it and every
      // machined break does.
      float wpnEdge = smoothstep( 500.0, 1800.0, wpnCurv );

      // Broken by the macro band so the wear is a history rather than an
      // outline: a rifle has a bright rail and a bright magwell lip, not a
      // uniform silver rim around every single feature.
      // The macro modulation is HALVED from round 3 (0.30 + 1.05 m). It is
      // there so the wear reads as a history rather than as an outline, but at
      // the old spread a 7 cm noise band was doubling the wear on one end of a
      // rail and killing it on the other, which on a part that is 51 identical
      // teeth reads as staining rather than as handling.
      float wpnWear = clamp( wpnEdge * ( 0.52 + 0.55 * wpnMacro ) * ${f(p.wear)}, 0.0, 1.0 );

      // ---- carbon fouling --------------------------------------------------
      // Gas rifles blow soot back over the last 60 mm of the muzzle device and
      // out of the ejection port. wpnBore is weapon-space z, negative toward the
      // muzzle, so this is a single smoothstep rather than a painted mask.
      // Both terms are written 1 − smoothstep(lo, hi, x) rather than
      // smoothstep(hi, lo, x): GLSL leaves smoothstep UNDEFINED when edge0 >
      // edge1, and "undefined" on one driver is "works fine" on the one you
      // tested on.
      float wpnSoot = ( 1.0 - smoothstep( -0.30, -0.13, wpnBore ) ) * ( 0.45 + 0.55 * wpnMeso );
      wpnSoot += ( 1.0 - smoothstep( 0.075, 0.14, abs( wpnBore - 0.10 ) ) ) * 0.35 * wpnMeso;
      wpnSoot = clamp( wpnSoot * ${f(p.fouling)}, 0.0, 1.0 );

      // ---- albedo ----------------------------------------------------------
      // ±7 % of value on the macro band and ±3 % on the meso: LOOK_SPEC's
      // "two bricks in a wall are never the same colour", applied to a finish
      // that was sprayed by a person. Both were halved in round 3 alongside the
      // meso frequency change above — a ±6 % albedo swing at 4.5 mm is fine
      // grain, the same swing at 18 mm was mottling, and mottling on a 44 mm
      // receiver is the single strongest "this is a rock, not a rifle" signal
      // there is. Value variation on a weapon belongs almost entirely in the
      // ROUGHNESS, which is where it moved to.
      vec3 wpnBase = ${v3(p.base)} * ( 0.93 + 0.14 * wpnMacro + 0.06 * ( wpnMeso - 0.5 ) );
      vec3 wpnCol = mix( wpnBase, ${v3(p.substrate)}, wpnWear );
      // Soot is near-black and slightly warm; it also kills the specular, which
      // is most of why a fouled muzzle device looks fouled.
      wpnCol = mix( wpnCol, vec3( 0.0130, 0.0118, 0.0102 ), wpnSoot * 0.88 );
      diffuseColor.rgb = wpnCol;

      material.metalness = clamp(
        mix( ${f(p.metalness)}, ${f(p.substrateMetalness)}, wpnWear ) * ( 1.0 - wpnSoot * 0.75 ),
        0.0, 1.0 );

      // ---- roughness -------------------------------------------------------
      float wpnRough = ${f(p.roughness)};
      // Both bands halved in round 3. Roughness variation is the right place for
      // a metal's surface interest — but at +-0.08 on a 1.4 mm grain it was
      // swinging the specular lobe hard enough to speckle on its own, on top of
      // everything the wear mask was doing.
      wpnRough += ( wpnGrain - 0.5 ) * 0.08;
      wpnRough += ( wpnMeso - 0.5 ) * 0.09;
      // Handled edges polish: worn metal is SMOOTHER than the finish it lost.
      wpnRough -= wpnWear * 0.14;
      // Fouling is soot, and soot is matte.
      wpnRough += wpnSoot * 0.30;
      // The axial brushing line. One long low-roughness streak down the bore
      // axis, which is what throws the sun into a stretched highlight along the
      // top of the receiver instead of a round blob.
      float wpnStreak = wpnFbm( vec2( wpnBore * 21.0, wpnUv.y * 240.0 ) );
      wpnRough -= smoothstep( 0.52, 0.95, wpnStreak ) * ${f(p.streak)};
      material.roughness = clamp( wpnRough, 0.085, 0.98 );

      // ---- micro relief ----------------------------------------------------
      // The grain has to SELF-SHADE or it is a printed pattern. Slopes are taken
      // analytically off the same field, in the tangent frame the uber material
      // already reconstructs from screen-space derivatives.
      // A SEVENTH of a noise cell on each axis — and therefore a different
      // metric step on each, because the grain is 8:1 anisotropic. Stepping the
      // same 1.6 mm on both would cross a whole cell in y and return a
      // decorrelated sample rather than a gradient, which is noise, not relief.
      float wpnGx = wpnFbm( vec2( wpnBore * ${f(p.grainU ?? 88)} + 0.14, wpnUv.y * ${f(p.grainV ?? 700)} ) ) - wpnGrain;
      float wpnGy = wpnFbm( vec2( wpnBore * ${f(p.grainU ?? 88)}, wpnUv.y * ${f(p.grainV ?? 700)} + 0.14 ) ) - wpnGrain;

      // ROUND 5: THE TANGENT FRAME — AND THE WHOLE NORMAL — IS REBUILT ON THE
      // INTERPOLATED VERTEX NORMAL, WHICH DISCARDS THE BAKE'S NORMAL MAP
      // OUTRIGHT. This is the fix for the defect four earlier rounds chased
      // through frequency, amplitude and curvature-source changes without ever
      // removing the cause.
      //
      // normal arriving here has been through mat.rusted_metal's normal map
      // — 2.6 m of corroded sheet, divided by WEAPON_TILING to a 186 mm
      // repeat. In ADS the rear of the receiver passes within 90 mm of the eye,
      // where 186 mm of surface spans roughly 1900 px, so what lands on the
      // near third of the frame is the bake's 20-50 mm corrosion dents blown up
      // to 200-500 px. They are far too large to read as texture and far too
      // irregular to read as form, and — this is the mechanism — a dent's two
      // flanks tilt opposite ways, so against the viewmodel's sky-over-ground
      // hemisphere one flank samples the teal half and the other the sandstone
      // half. That is the blue-and-gold mottle every round-2/3/4 critic has read
      // as "lichen on concrete", measured directly: with this one line changed
      // to vNormal and nothing else touched, the mottle disappears completely.
      //
      // Nothing of value is lost. The bake's normal map is authored for a
      // 2.6 m sheet of rusted steel; a rifle has no such relief at any scale.
      // Its AO and roughness channels are still consumed upstream, and every
      // band of relief a weapon does have — bead blast, broaching, chamfer wear —
      // is written analytically below at the right frequency for a 44 mm part.
      vec3 wpnFlat = normalize( vNormal );
      normal = wpnFlat;
      mat3 wpnTbn = ironTangentFrame( wpnFlat, vWorldPosition, wpnUv );
      // NEGATED, because the tangent-space normal of a height field h is
      // (-dh/du, -dh/dv, 1): a rising slope tilts the normal BACKWARDS. With
      // symmetric noise the sign is statistically invisible, which is exactly
      // why it is worth getting right rather than discovering later on a field
      // that is not symmetric.
      //
      // ROUND 3 TOOK THE GAIN FROM 5.0 TO 1.9, and this is the other half of the
      // "concrete, not gunmetal" finding. At 5.0 a typical delta of 0.05 became
      // a tangent slope of 0.25 — 14° of per-pixel normal swing. Fourteen
      // degrees is not bead blasting, it is a rock face, and it interacts
      // catastrophically with a hemisphere light: every micro-facet tilted UP
      // sampled the blue sky half and every one tilted DOWN sampled the warm
      // ground bounce, so a flat receiver panel resolved into a five-pixel
      // blue-and-orange dazzle that reads as lichen on stone. The mottle was
      // never in the albedo — it was the NORMAL sampling a two-colour dome.
      // 1.9 lands the same delta at 5.4°, which is the real figure for a
      // 120-grit blast, and the panel goes quiet without going smooth.
      vec2 wpnSlope = -vec2( wpnGx, wpnGy ) * ( ${f(p.grain)} * 1.9 );

      // BROACHING MARKS. Shallow ridges running ALONG the bore at a 6 mm pitch,
      // on the metal roles only (they are gated by 'streak', which is zero on
      // polymer and on the glove — a moulded part has no tool path).
      //
      // This is the mesoscale band the round-2 critique said was missing: "one
      // tiled noise texture applied identically to the top, side and front faces
      // ... no receiver machining". A noise field cannot supply it, because the
      // thing that says "milled" is not randomness, it is PERIODICITY WITH A
      // DIRECTION — parallel highlights that stay parallel across a face and
      // break at every edge. The peak slope works out at 0.055 on the receiver
      // and 0.067 on parkerised steel — 3.1 and 3.8 degrees, i.e. 52 and 64
      // micrometres of relief at this pitch. Invisible in silhouette, and a run
      // of thin parallel specular lines the moment the key rakes across the
      // receiver. The pitch is in the box map's metres, so it is the same 6 mm
      // on the magazine as on the rail, which is what a broach actually does.
      //
      // FADED OUT BY TEXEL DENSITY, because this is the one term in the file
      // that is PERIODIC and periodic detail is the only kind that aliases into
      // a moving moire rather than into harmless mush. fwidth( wpnUv.y ) is
      // metres of surface per pixel; the pitch is 6 mm, so Nyquist is 3 mm per
      // pixel and the ramp is placed under it. On the viewmodel the term is
      // always at full strength (0.02 mm per pixel in ADS); on the third-person
      // MeshAsset, which shares these materials, it is gone by about 12 m.
      float wpnBroach = 1.0 - smoothstep( 0.0009, 0.0030, fwidth( wpnUv.y ) );
      wpnSlope.y += cos( wpnUv.y * 1047.0 ) * ${f(p.streak)} * 0.42 * wpnBroach;

      normal = normalize( wpnTbn * normalize( vec3( wpnSlope, 1.0 ) ) );
    }
`,
  };
}

/**
 * The optic window.
 *
 * A reflex sight is not a dark plate — it is a coated, slightly spherical
 * combiner you look THROUGH, and an ADS frame whose optical centre is filled
 * with an opaque rectangle has destroyed the only thing an ADS frame exists to
 * show. `MaterialSpec` carries no opacity field and the uber material only
 * takes alpha from `AlphaFromHeight` (i.e. from a bake's height channel), so
 * this chunk is the only place the lens can become genuinely transparent.
 *
 * Three things happen here, and each is one of the properties that separates
 * real glass from a tinted quad:
 *
 *  1. FRESNEL-WEIGHTED OPACITY. 0.4 % reflectance head-on rising to a hard
 *     bright rim past 60°, which is why the geometry is DOMED — a flat pane has
 *     one normal and therefore no rim at all.
 *  2. THE COATING RESIDUAL. A broadband AR stack is tuned for the middle of the
 *     visible band and leaks at both ends, so what it reflects is the
 *     blue-green every coated lens shows. That colour is the tell.
 *  3. THE EYE BOX. The reflection strengthens toward the rim of the combiner,
 *     so the sight picture darkens into the housing over a gradient instead of
 *     ending at a hard line.
 */
export function opticLensChunk(): SurfaceChunk {
  return {
    common: HELPERS,
    shade: /* glsl */ `
    {
      // THE GEOMETRIC NORMAL, taken back from the position derivatives.
      //
      // The normal arriving here has already been perturbed by the bake's
      // normal map, and the bake SurfaceId.Glass resolves to is a 4 m generic
      // surface — across a 41 mm combiner that is one enormous tilt, which drags
      // the Fresnel term below off zero everywhere and renders the lens as a
      // milky plate. Optical glass has NO surface relief; taking the facet
      // normal is not an approximation here, it is the correct answer. The
      // dome is 12 × 12, so facet-to-facet is under a degree.
      vec3 wpnGeo = normalize( cross( dFdx( vWorldPosition ), dFdy( vWorldPosition ) ) );
      if ( dot( wpnGeo, normal ) < 0.0 ) wpnGeo = -wpnGeo;
      normal = wpnGeo;

      vec3 wpnView = normalize( cameraPosition - vWorldPosition );
      float wpnNdv = clamp( dot( normal, wpnView ), 0.0, 1.0 );
      float wpnFres = pow( 1.0 - wpnNdv, 5.0 );

      // THE EYE BOX, radially. The lens keeps domePane's own 0..1 plane UVs
      // (it is exempted from the weapon-space box map in models/build.ts
      // precisely so this coordinate survives), so the centre of the combiner is
      // at 0.5 and this is a true radius.
      //
      // It has to be radial rather than Fresnel-driven, and that is worth
      // stating: the dome is a 75 mm-radius section, so the normal never leaves
      // 7.4° of the axis and a Schlick term stays flat to five decimal places
      // across the whole aperture. What actually darkens the edge of a real
      // sight picture is the coating thinning at the rim, the pane's own bevel,
      // and the inside of the housing reflected off it — all of which are
      // functions of radius, not of angle.
      float wpnRadius = length( vUv - 0.5 ) * 2.0;
      float wpnRim = smoothstep( 0.55, 1.05, wpnRadius );

      // ALPHA IS THE REFLECTANCE, and that is the whole trick. Three multiplies
      // the shaded result by alpha on the way into the blend, so writing the
      // Fresnel term here makes the pane composite as
      // reflected*F + transmitted*(1-F) — real glass — using nothing but the
      // sorted alpha pass the graph already runs. 0.045 head-on rather than
      // glass's 0.04 keeps a whisper of the coating visible; 0.94 at grazing
      // stops short of a perfect mirror because the rim of the combiner is
      // always slightly hazed.
      diffuseColor.a = clamp( 0.045 + 0.90 * wpnFres + 0.30 * wpnRim, 0.0, 0.94 );

      // What the coating LEAKS. A broadband AR stack is tuned near 550 nm and
      // leaks at both ends, so the residual it reflects is blue-green — that
      // colour is the single most recognisable property of coated optical glass
      // and it costs one line. Kept dark: it is a residual, not a paint, and
      // since alpha rises with the same terms, a brighter tint here would put a
      // green ring round the sight picture rather than a soft graduation.
      diffuseColor.rgb = vec3( 0.030, 0.098, 0.086 ) * ( 0.4 + 0.9 * wpnFres + 0.5 * wpnRim );

      /* WHAT IS ON THE GLASS, WHICH IS THE PART NOBODY MODELS AND EVERYBODY SEES.
       *
       * A combiner that has been in a chest rig for a fortnight is not optically
       * clean, and in ADS it is 40 % of the frame's height with the player's eye
       * fixed on it — the least forgiving surface in the game. Two layers, both
       * on the pane's own 0..1 plane UVs so they sit on the GLASS and do not
       * swim when the weapon moves:
       *
       *  1. FINGERPRINT AND SMEAR, at ~4 mm. Sebum does not block light, it
       *     SCATTERS it: the reflectance rises a little and the polish drops a
       *     lot, so a smear is invisible against a dark target and flares into a
       *     soft milky patch when there is a bright sky behind it — which is
       *     exactly when a shooter notices it, and exactly what this shot has.
       *  2. DUST, at ~0.8 mm and much sparser, riding the top of the same field.
       *
       * Both are deliberately weak. The test for this term is that you cannot
       * see it until you look for it; a lens with a visible pattern on it is a
       * dirty window, not an optic.
       */
      float wpnSmudge = wpnFbm( vUv * 11.0 + vec2( 3.1, 7.7 ) );
      wpnSmudge = smoothstep( 0.46, 0.86, wpnSmudge );
      float wpnDust = smoothstep( 0.72, 0.95, wpnFbm( vUv * 62.0 ) ) * wpnSmudge;
      diffuseColor.a = clamp( diffuseColor.a + wpnSmudge * 0.045 + wpnDust * 0.10, 0.0, 0.96 );
      // The smear picks up the warm side of the sky rather than the coating's
      // blue-green residual: it is sitting ON the coating, not in it.
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.115, 0.101, 0.086 ), wpnSmudge * 0.5 + wpnDust * 0.4 );

      // Optical polish. The specular lobe is what carries the reflection, and
      // it is already being scaled by the alpha above, so it needs no help.
      material.roughness = 0.035 + wpnSmudge * 0.16 + wpnDust * 0.22;
      material.metalness = 0.0;
    }
`,
  };
}
