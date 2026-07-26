/**
 * RCORE's material shot file. Owned by RCORE and by nobody else.
 *
 * MUST PROVE: the uber material across every SurfaceId, wear and micro-detail
 * readable at 0.3 m, and correct response at grazing angles.
 *
 * BOTH SHOTS ARE POSED ON REAL LEVEL GEOMETRY, not on a chart of spheres. A
 * sphere chart proves that a shader compiles; it does not prove that a town
 * built by another lane, with that lane's UVs and that lane's proportions, has
 * stopped reading as flat single-colour geometry. `bake.ts` already owns the
 * chart-of-spheres review surface, so duplicating it here would spend a slow
 * capture on information we already have.
 *
 * Coordinates are literals: boundary CI forbids a shot file from importing
 * `@/level/**`, and a shot that silently followed a level edit would stop being
 * a regression test. They are kept in step with `src/level/layout.ts` by hand.
 */
import { registerShot } from '@/engine/harness';

registerShot({
  name: 'material_chart',
  description:
    'ALPHA market hall west facade at 4 m, raking cross-sun. Proves: baked PBR ' +
    'reaches the level (albedo, normal, roughness, cavity AO), curvature wear on ' +
    'convexities, grime in cavities, dust on upward faces, detail + micro normal ' +
    'holding at arm’s length, and paving that does not repeat under the camera.',
  frames: 14,
  setup(ctx) {
    ctx.seed(0x4d);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 4.0, fog: 0.0028 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // Standing eye height on the terrace (ground 11.5 m), on the square's west
    // approach, pitched down so the paving runs out from 2.5 m under the camera
    // to the market hall's arcade at ~20 m. That range is the point of the shot:
    // the same material has to hold at 2 m (micro normal), at 8 m (detail
    // normal + wear) and at 20 m (macro break-up, no visible repeat).
    //
    // The camera position is LEVEL's own `level_alpha` station, unchanged. Two
    // earlier poses four metres off the hall's west wall both rendered black —
    // they stood inside a plot's geometry, which is invisible from outside and
    // costs a five-minute capture to discover. Do not move this camera without
    // a capture to prove the new station is in the open.
    ctx.poseCamera([52, 13.22, 76], [66.0, 11.6, 88.0], 45);
  },
});

registerShot({
  name: 'material_grazing',
  description:
    'The ALPHA square paving running 60 m to a vanishing point. Proves: Fresnel ' +
    'sheen rising toward the horizon on a nominally matte 0.95-roughness ' +
    'surface, no visible tiling from 2 m to 60 m, and the detail/micro layers ' +
    'fading out by distance instead of aliasing.',
  frames: 14,
  setup(ctx) {
    ctx.seed(0x4e);
    ctx.setTimeOfDay(17.4);
    ctx.setWeather(0.05, { wind: 5.0, fog: 0.0032 });
    ctx.setOverlays({ viewmodel: false, hud: false });
    // LEVEL's own `level_alpha` station again — the only camera position in
    // this quadrant proven to stand in the open — but aimed nearly level along
    // the square's 60 m diagonal so the paving occupies most of the frame and
    // runs to a vanishing point. That is the geometry the test needs: one
    // material, one roughness, seen from 2 m to 60 m with the view vector
    // sweeping from 60° to 2° off the surface.
    ctx.poseCamera([52, 13.22, 76], [104.0, 12.6, 122.0], 55);
  },
});
