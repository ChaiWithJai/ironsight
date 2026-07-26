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
      float wpnGrain = wpnFbm( vec2( wpnBore * 88.0, wpnUv.y * 700.0 ) );
      // ~1.8 cm: cerakote orange-peel and anodising density.
      float wpnMeso = wpnFbm( wpnUv * 56.0 );
      // ~7 cm: which parts of this weapon have been handled.
      float wpnMacro = wpnValue( wpnUv * 13.0 + vec2( 4.7, 1.3 ) );

      // ---- curvature -------------------------------------------------------
      // The divergence of the shading normal across one pixel. On a chamfered
      // edge it spikes; on a flat panel it is ~0. This is the edge-weighted
      // mask the wear rides, and it is why the silver lands on rail teeth and
      // magwell lips rather than in the middle of the receiver flat.
      vec3 wpnDnx = dFdx( normal );
      vec3 wpnDny = dFdy( normal );
      float wpnCurv = clamp( sqrt( dot( wpnDnx, wpnDnx ) + dot( wpnDny, wpnDny ) ) * 3.1, 0.0, 1.0 );
      float wpnEdge = smoothstep( 0.14, 0.66, wpnCurv );

      // Broken by the macro band so the wear is a history rather than an
      // outline: a rifle has a bright rail and a bright magwell lip, not a
      // uniform silver rim around every single feature.
      float wpnWear = clamp( wpnEdge * ( 0.30 + 1.05 * wpnMacro ) * ${f(p.wear)}, 0.0, 1.0 );

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
      // ±11 % of value on the macro band and ±6 % on the meso: LOOK_SPEC's
      // "two bricks in a wall are never the same colour", applied to a finish
      // that was sprayed by a person.
      vec3 wpnBase = ${v3(p.base)} * ( 0.89 + 0.22 * wpnMacro + 0.12 * ( wpnMeso - 0.5 ) );
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
      wpnRough += ( wpnGrain - 0.5 ) * 0.16;
      wpnRough += ( wpnMeso - 0.5 ) * 0.10;
      // Handled edges polish: worn metal is SMOOTHER than the finish it lost.
      wpnRough -= wpnWear * 0.26;
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
      float wpnGx = wpnFbm( vec2( wpnBore * 88.0 + 0.14, wpnUv.y * 700.0 ) ) - wpnGrain;
      float wpnGy = wpnFbm( vec2( wpnBore * 88.0, wpnUv.y * 700.0 + 0.14 ) ) - wpnGrain;
      mat3 wpnTbn = ironTangentFrame( normal, vWorldPosition, wpnUv );
      // NEGATED, because the tangent-space normal of a height field h is
      // (-dh/du, -dh/dv, 1): a rising slope tilts the normal BACKWARDS. With
      // symmetric noise the sign is statistically invisible, which is exactly
      // why it is worth getting right rather than discovering later on a field
      // that is not symmetric.
      //
      // ×5 lands a typical delta of 0.05 on a tangent slope near 0.25 — about
      // 14° of tilt, which is bead blasting. Past ~0.5 it turns to gravel.
      vec2 wpnSlope = -vec2( wpnGx, wpnGy ) * ( ${f(p.grain)} * 5.0 );
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
    common: '',
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

      // Optical polish. The specular lobe is what carries the reflection, and
      // it is already being scaled by the alpha above, so it needs no help.
      material.roughness = 0.035;
      material.metalness = 0.0;
    }
`,
  };
}
