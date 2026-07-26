/**
 * THE FROZEN SURFACE PROFILE TABLE.
 *
 * OWNER: RCORE. Day-0 table; RCORE tunes the numbers against the real material
 * bakes, but the SHAPE is fixed and five lanes already read it.
 *
 * One row per `SurfaceId`, and it is read by five lanes that never talk to each
 * other: WEAPONS (penetration energy loss, ricochet), VFX (impact burst, decal
 * kind), AUDIO (impact cue, footstep cue, reverb absorption), AI (how loud an
 * impact is, in the same dB unit its hearing thresholds use) and PHYS
 * (friction, restitution). That is why it lives in the render tree but is not
 * about rendering — it is the shared vocabulary for "what is this made of".
 *
 * UNITS
 *  density                 kg/m³
 *  penetrationResistance   joules absorbed per centimetre of material
 *  hardness                0..1, Mohs-ish; drives spark count and impact flash
 *  ricochetRestitution     fraction of energy retained on a shallow deflection
 *  ricochetAngleDeg        impacts shallower than this (from the surface) may skip
 *  impactLoudnessDb        dB SPL at 1 m for a rifle impact
 *  acousticAbsorption      0 = reflective stone, 1 = dead cloth
 */
import {
  DecalKind,
  SurfaceId,
  type SoundId,
  type SurfaceProfile,
  type VfxId,
} from '@/engine/types';

interface Row {
  id: SurfaceId;
  name: string;
  density: number;
  pen: number;
  hardness: number;
  ricochet: number;
  ricochetDeg: number;
  friction: number;
  restitution: number;
  impactCue: SoundId;
  footstepCue: SoundId;
  impactVfx: VfxId;
  decal: DecalKind;
  db: number;
  absorption: number;
}

const ROWS: readonly Row[] = [
  { id: SurfaceId.Sandstone, name: 'sandstone', density: 2200, pen: 210, hardness: 0.35, ricochet: 0.18, ricochetDeg: 14, friction: 0.85, restitution: 0.06, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 108, absorption: 0.08 },
  { id: SurfaceId.Stucco, name: 'stucco', density: 1600, pen: 120, hardness: 0.25, ricochet: 0.12, ricochetDeg: 11, friction: 0.82, restitution: 0.05, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 104, absorption: 0.12 },
  { id: SurfaceId.Concrete, name: 'concrete', density: 2400, pen: 320, hardness: 0.5, ricochet: 0.22, ricochetDeg: 16, friction: 0.9, restitution: 0.08, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 111, absorption: 0.05 },
  { id: SurfaceId.Rubble, name: 'rubble', density: 1500, pen: 150, hardness: 0.4, ricochet: 0.10, ricochetDeg: 9, friction: 0.95, restitution: 0.04, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 100, absorption: 0.25 },
  { id: SurfaceId.Plaster, name: 'plaster', density: 900, pen: 55, hardness: 0.15, ricochet: 0.05, ricochetDeg: 8, friction: 0.78, restitution: 0.04, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 96, absorption: 0.2 },
  { id: SurfaceId.Tile, name: 'tile', density: 2000, pen: 140, hardness: 0.55, ricochet: 0.24, ricochetDeg: 18, friction: 0.6, restitution: 0.12, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.Crack, db: 107, absorption: 0.04 },
  { id: SurfaceId.Sand, name: 'sand', density: 1500, pen: 90, hardness: 0.05, ricochet: 0.02, ricochetDeg: 5, friction: 1.0, restitution: 0.01, impactCue: 'i.sand', footstepCue: 'p.footstep', impactVfx: 'impact.sand', decal: DecalKind.None, db: 88, absorption: 0.55 },
  { id: SurfaceId.WetSand, name: 'wet sand', density: 1900, pen: 110, hardness: 0.08, ricochet: 0.03, ricochetDeg: 6, friction: 1.05, restitution: 0.01, impactCue: 'i.sand', footstepCue: 'p.footstep', impactVfx: 'impact.sand', decal: DecalKind.Puddle, db: 90, absorption: 0.5 },
  { id: SurfaceId.Dirt, name: 'dirt', density: 1400, pen: 85, hardness: 0.1, ricochet: 0.03, ricochetDeg: 6, friction: 0.98, restitution: 0.02, impactCue: 'i.sand', footstepCue: 'p.footstep', impactVfx: 'impact.sand', decal: DecalKind.None, db: 89, absorption: 0.45 },
  { id: SurfaceId.Gravel, name: 'gravel', density: 1700, pen: 100, hardness: 0.3, ricochet: 0.06, ricochetDeg: 7, friction: 1.02, restitution: 0.03, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.None, db: 95, absorption: 0.4 },
  { id: SurfaceId.Cobble, name: 'cobble', density: 2500, pen: 300, hardness: 0.6, ricochet: 0.26, ricochetDeg: 19, friction: 0.88, restitution: 0.09, impactCue: 'i.stone', footstepCue: 'p.footstep', impactVfx: 'impact.stone', decal: DecalKind.BulletStone, db: 110, absorption: 0.06 },
  { id: SurfaceId.Wood, name: 'wood', density: 650, pen: 70, hardness: 0.2, ricochet: 0.04, ricochetDeg: 8, friction: 0.7, restitution: 0.15, impactCue: 'i.wood', footstepCue: 'p.footstep', impactVfx: 'impact.wood', decal: DecalKind.BulletWood, db: 98, absorption: 0.3 },
  { id: SurfaceId.PaintedWood, name: 'painted wood', density: 680, pen: 75, hardness: 0.22, ricochet: 0.05, ricochetDeg: 8, friction: 0.68, restitution: 0.16, impactCue: 'i.wood', footstepCue: 'p.footstep', impactVfx: 'impact.wood', decal: DecalKind.BulletWood, db: 99, absorption: 0.28 },
  { id: SurfaceId.PaintedMetal, name: 'painted metal', density: 7800, pen: 520, hardness: 0.8, ricochet: 0.42, ricochetDeg: 26, friction: 0.45, restitution: 0.2, impactCue: 'i.metal', footstepCue: 'p.footstep', impactVfx: 'impact.metal', decal: DecalKind.BulletMetal, db: 116, absorption: 0.03 },
  { id: SurfaceId.RustedMetal, name: 'rusted metal', density: 7400, pen: 430, hardness: 0.7, ricochet: 0.34, ricochetDeg: 23, friction: 0.6, restitution: 0.14, impactCue: 'i.metal', footstepCue: 'p.footstep', impactVfx: 'impact.metal', decal: DecalKind.BulletMetal, db: 114, absorption: 0.05 },
  { id: SurfaceId.BareMetal, name: 'bare metal', density: 7850, pen: 560, hardness: 0.85, ricochet: 0.46, ricochetDeg: 28, friction: 0.4, restitution: 0.24, impactCue: 'i.metal', footstepCue: 'p.footstep', impactVfx: 'impact.metal', decal: DecalKind.BulletMetal, db: 118, absorption: 0.02 },
  { id: SurfaceId.Grating, name: 'grating', density: 3000, pen: 180, hardness: 0.75, ricochet: 0.3, ricochetDeg: 22, friction: 0.75, restitution: 0.1, impactCue: 'i.metal', footstepCue: 'p.footstep', impactVfx: 'impact.metal', decal: DecalKind.None, db: 113, absorption: 0.35 },
  { id: SurfaceId.Glass, name: 'glass', density: 2500, pen: 25, hardness: 0.65, ricochet: 0.02, ricochetDeg: 4, friction: 0.35, restitution: 0.05, impactCue: 'i.glass', footstepCue: 'p.footstep', impactVfx: 'impact.glass', decal: DecalKind.BulletGlass, db: 105, absorption: 0.03 },
  { id: SurfaceId.Fabric, name: 'fabric', density: 300, pen: 12, hardness: 0.03, ricochet: 0.01, ricochetDeg: 3, friction: 0.9, restitution: 0.02, impactCue: 'i.fabric', footstepCue: 'p.footstep', impactVfx: 'impact.fabric', decal: DecalKind.None, db: 82, absorption: 0.9 },
  { id: SurfaceId.Tarp, name: 'tarp', density: 400, pen: 15, hardness: 0.05, ricochet: 0.01, ricochetDeg: 3, friction: 0.7, restitution: 0.06, impactCue: 'i.fabric', footstepCue: 'p.footstep', impactVfx: 'impact.fabric', decal: DecalKind.None, db: 85, absorption: 0.8 },
  { id: SurfaceId.Sandbag, name: 'sandbag', density: 1600, pen: 240, hardness: 0.12, ricochet: 0.02, ricochetDeg: 5, friction: 1.0, restitution: 0.01, impactCue: 'i.sand', footstepCue: 'p.footstep', impactVfx: 'impact.sand', decal: DecalKind.None, db: 92, absorption: 0.7 },
  { id: SurfaceId.Rope, name: 'rope', density: 700, pen: 30, hardness: 0.1, ricochet: 0.01, ricochetDeg: 3, friction: 1.1, restitution: 0.05, impactCue: 'i.fabric', footstepCue: 'p.footstep', impactVfx: 'impact.fabric', decal: DecalKind.None, db: 84, absorption: 0.75 },
  { id: SurfaceId.Rubber, name: 'rubber', density: 1100, pen: 60, hardness: 0.18, ricochet: 0.08, ricochetDeg: 9, friction: 1.2, restitution: 0.5, impactCue: 'i.fabric', footstepCue: 'p.footstep', impactVfx: 'impact.fabric', decal: DecalKind.None, db: 90, absorption: 0.6 },
  { id: SurfaceId.Water, name: 'water', density: 1000, pen: 45, hardness: 0.0, ricochet: 0.35, ricochetDeg: 12, friction: 0.05, restitution: 0.0, impactCue: 'i.water', footstepCue: 'p.footstep', impactVfx: 'impact.water', decal: DecalKind.None, db: 86, absorption: 0.15 },
  { id: SurfaceId.Foliage, name: 'foliage', density: 200, pen: 8, hardness: 0.02, ricochet: 0.0, ricochetDeg: 0, friction: 0.6, restitution: 0.05, impactCue: 'i.foliage', footstepCue: 'p.footstep', impactVfx: 'impact.foliage', decal: DecalKind.None, db: 80, absorption: 0.85 },
  { id: SurfaceId.Bark, name: 'bark', density: 750, pen: 95, hardness: 0.25, ricochet: 0.03, ricochetDeg: 7, friction: 0.85, restitution: 0.08, impactCue: 'i.wood', footstepCue: 'p.footstep', impactVfx: 'impact.wood', decal: DecalKind.BulletWood, db: 97, absorption: 0.45 },
  { id: SurfaceId.Flesh, name: 'flesh', density: 1050, pen: 40, hardness: 0.05, ricochet: 0.0, ricochetDeg: 0, friction: 0.9, restitution: 0.02, impactCue: 'i.flesh', footstepCue: 'p.footstep', impactVfx: 'impact.flesh', decal: DecalKind.Blood, db: 88, absorption: 0.8 },
  { id: SurfaceId.Kevlar, name: 'kevlar', density: 1440, pen: 380, hardness: 0.45, ricochet: 0.12, ricochetDeg: 15, friction: 0.8, restitution: 0.05, impactCue: 'i.fabric', footstepCue: 'p.footstep', impactVfx: 'impact.fabric', decal: DecalKind.None, db: 94, absorption: 0.65 },
];

const TABLE: SurfaceProfile[] = [];
for (const r of ROWS) {
  TABLE[r.id] = Object.freeze({
    id: r.id,
    name: r.name,
    density: r.density,
    penetrationResistance: r.pen,
    hardness: r.hardness,
    ricochetRestitution: r.ricochet,
    ricochetAngleDeg: r.ricochetDeg,
    friction: r.friction,
    restitution: r.restitution,
    impactCue: r.impactCue,
    footstepCue: r.footstepCue,
    impactVfx: r.impactVfx,
    decalKind: r.decal,
    impactLoudnessDb: r.db,
    acousticAbsorption: r.absorption,
  });
}

export const SURFACE_PROFILES: readonly Readonly<SurfaceProfile>[] = Object.freeze(TABLE);

export function surfaceProfile(id: SurfaceId): Readonly<SurfaceProfile> {
  const p = SURFACE_PROFILES[id];
  if (!p) throw new Error(`no SurfaceProfile for SurfaceId ${id}`);
  return p;
}

/**
 * Day-0 base colours per surface, linear-Rec.709 as 0xRRGGBB in sRGB notation.
 * These are the HARBOUR REACH palette: warm sandstone and ochre against
 * desaturated teal shadow. They stand in until the real material arrays exist,
 * and they are what makes an unbaked frame read as the right *film* rather than
 * as grey clay.
 */
export const SURFACE_BASE_COLOR: Readonly<Record<SurfaceId, number>> = {
  [SurfaceId.Sandstone]: 0xc4a67a,
  [SurfaceId.Stucco]: 0xd8c3a1,
  [SurfaceId.Concrete]: 0x9a958c,
  [SurfaceId.Rubble]: 0x8e8377,
  [SurfaceId.Plaster]: 0xe0d5c0,
  [SurfaceId.Tile]: 0xa85c4a,
  [SurfaceId.Sand]: 0xcbb188,
  [SurfaceId.WetSand]: 0x8d7856,
  [SurfaceId.Dirt]: 0x8a7458,
  [SurfaceId.Gravel]: 0x968b7c,
  [SurfaceId.Cobble]: 0x8b8377,
  [SurfaceId.Wood]: 0x7a5a38,
  [SurfaceId.PaintedWood]: 0x5f6f6a,
  [SurfaceId.PaintedMetal]: 0x4d5a5e,
  [SurfaceId.RustedMetal]: 0x7a4a2e,
  [SurfaceId.BareMetal]: 0x8d9196,
  [SurfaceId.Grating]: 0x5a5f62,
  [SurfaceId.Glass]: 0x9fb6bd,
  [SurfaceId.Fabric]: 0x9c8a70,
  [SurfaceId.Tarp]: 0x6d7c6a,
  [SurfaceId.Sandbag]: 0xa08c66,
  [SurfaceId.Rope]: 0xa08a62,
  [SurfaceId.Rubber]: 0x2e3033,
  [SurfaceId.Water]: 0x2b4a52,
  [SurfaceId.Foliage]: 0x5c6b3a,
  [SurfaceId.Bark]: 0x6b5641,
  [SurfaceId.Flesh]: 0x9a6a58,
  [SurfaceId.Kevlar]: 0x5b5a4a,
};
