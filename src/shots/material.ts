/**
 * RCORE's material shot file. Owned by RCORE and by nobody else.
 *
 * MUST PROVE: the uber material across every SurfaceId, wear and micro-detail
 * readable at arm's length, and correct response at grazing angles.
 *
 * BOTH SHOTS ARE POSED ON REAL LEVEL GEOMETRY, not on a chart of spheres. A
 * sphere chart proves that a shader compiles; it does not prove that a town
 * built by another lane, with that lane's UVs and that lane's proportions, has
 * stopped reading as flat single-colour geometry. `bake.ts` already owns the
 * chart-of-spheres review surface, so duplicating it here would spend a slow
 * capture on information we already have.
 *
 * SOLAR STAGING — the reason both cameras moved
 * ---------------------------------------------
 * `docs/LOOK_SPEC.md` §2.3: the sun must sit 100–150° in azimuth from the
 * sightline. At 17.4 h the sun is at azimuth 261°, elevation 11°, so the light
 * TRAVELS along azimuth 81° and a camera's staging angle is
 *
 *     offLight = wrap180( atan2(dx, dz)·180/π − 81 )
 *
 * The old poses measured 32° and 34° — front-lit, which is the single worst
 * staging for a MATERIAL shot specifically. Front light lands near the surface
 * normal, so every bump, chip and quoin arris throws its shadow directly behind
 * itself where the camera cannot see it; the normal map does no visible work and
 * the wear masks read as printed pattern. What a material shot wants is the
 * opposite: light near the surface PLANE, where a 3 mm chamfer casts a 15 mm
 * shadow and the mesoscale layer becomes the dominant thing in the image.
 *
 * The new poses land at 126° and 108°. Both are staged on a CORNER so a single
 * frame carries the same material at three incidences at once — see each shot.
 *
 * Coordinates are literals: boundary CI forbids a shot file from importing
 * `@/level/**`, and a shot that silently followed a level edit would stop being
 * a regression test. They are kept in step with `src/level/layout.ts` by hand.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'material_chart',
  description:
    'The ALPHA market hall’s south-east corner at 5 m, with the raking-lit south ' +
    'facade running 33 m to the right and the sky-lit east arcade to the left. ' +
    'Proves: baked PBR reaches the level (albedo, normal, roughness, cavity AO), ' +
    'curvature wear on convexities, grime in cavities, dust on upward faces, ' +
    'detail + micro normal holding at arm’s length, and the SAME material read ' +
    'at 79° incidence and at pure sky light in one frame.',
  frames: 14,
  setup(ctx) {
    ctx.seed(0x4d);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 4.0, fog: 0.0028 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing eye height on the square's paving (deck 11.60 + 1.62), 5.4 m off
    // the hall's south-east corner, sighting 315° — 126° off the light.
    //
    // The corner is the whole shot. The hall is very nearly axis-aligned
    // (yaw 0.02), so at a light azimuth of 81°:
    //   - the SOUTH facade (normal 181°) takes the sun at 79° incidence. That is
    //     raking light: 18 % of full irradiance, but every course joint, every
    //     chipped arris and every bit of the detail-normal layer throws a shadow
    //     several times its own depth. This is the face the wear masks are
    //     judged on, and it runs from 8 m out to 33 m at the frame's right edge,
    //     so one surface is sampled across two decades of texel density.
    //   - the EAST facade (normal 271°) sees no sun at all and is lit purely by
    //     the sky dome. It is the control: same material, no key, and it is what
    //     proves the ambient is a real two-lobe integration rather than a flat
    //     term. It fills the left of frame out to 21 m and is the frame's dark
    //     near-field mass.
    // §2.3's "lit face and sky-lit face simultaneously" is therefore satisfied
    // by construction, on one object, at one corner.
    //
    // The station is in the open: it stands 1.5 m clear of the plinth outline
    // (hall half-extents 13 × 9 plus 0.85 of plinth, centred 71, 97). Two
    // earlier poses four metres off the hall's WEST wall both rendered black —
    // they stood inside a plot's geometry, which is invisible from outside and
    // costs a five-minute capture to discover. Do not move this camera without a
    // capture to prove the new station is in the open.
    ctx.poseCamera([88.5, 13.22, 85.0], [70.8, 12.78, 102.7], 50);
  },
});

registerShot({
  name: 'material_grazing',
  description:
    'The ALPHA square paving running 48 m up the strip east of the market hall ' +
    'to a vanishing point, with the hall’s sky-lit east arcade up the right edge ' +
    'and the hall’s own 35 m cast shadow crossing the run at 12 m. Proves: ' +
    'Fresnel sheen rising toward the horizon on a nominally matte 0.95-roughness ' +
    'surface, no visible tiling from 2 m to 48 m, ONE material read sunlit and ' +
    'sky-lit on a single continuous plane, and the detail/micro layers fading ' +
    'out by distance instead of aliasing.',
  frames: 14,
  setup(ctx) {
    ctx.seed(0x4e);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 5.0, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Sightline 333°, 108° off the light — the low end of §2.3's window, and
    // that is the deliberate choice for this shot rather than a compromise. The
    // paving's own normal is up, so at an 11° sun it is ALWAYS at 79° incidence;
    // what changes with staging is where the cast shadows go. At 108° off, the
    // shadows of the cistern head, the crate stacks and the stalls run 5.1×
    // their own height ACROSS the run, left to right, instead of hiding under
    // their objects. Tiling is far easier to spot on a surface with a shadow
    // pattern laid over it than on a flat-lit one, so this staging makes the
    // test harder, not easier.
    //
    // The line is chosen to miss the market hall: from (99.5, 80.5) a 333°
    // bearing crosses x = 84 at z = 111, five metres past the hall's north-east
    // corner, so the run stays on open paving for its whole 48 m before the
    // square's north edge and the block behind it close the frame. The obvious
    // choice — either square diagonal — is blocked by the hall at 21–24 m.
    //
    // The run is deliberately NOT uniformly sunlit. The hall is 6.9 m to its
    // parapet, so at an 11° sun it lays a 35 m shadow east across exactly this
    // strip, and the terminator crosses the run at about 12 m. That is the
    // strongest single test on the frame: the identical paving material appears
    // at full key in the near field and at pure sky light beyond the line, on
    // one continuous plane with no material change to hide behind. If the albedo
    // hue shifts across that boundary, or the shadow side loses its micro
    // normal, it is visible here and nowhere else.
    //
    // View vector sweeps from 40° off the surface at 2 m to 2° at 48 m, which is
    // the range the Fresnel term has to be right over.
    ctx.poseCamera([99.5, 13.22, 80.5], [81.3, 11.82, 116.1], 55);
  },
});
