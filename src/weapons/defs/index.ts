/**
 * The frozen `WeaponDef` table. WEAPONS owns this file.
 *
 * Built ONCE, after the bake, because every def names a baked `MeshAsset` key.
 * From that point it is immutable and shared: `WeaponService.def` hands out the
 * same object to HUD, AI, VFX and AUDIO, and nothing anywhere mutates it.
 */
import type { WeaponDef, WeaponId } from '@/engine/types';
import { weaponMeshKey } from '@/weapons/models/assets';
import { arService } from '@/weapons/defs/ar-service';
import { dmrMarksman } from '@/weapons/defs/dmr-marksman';
import { lmgSupport } from '@/weapons/defs/lmg-support';
import { shotgunBreacher } from '@/weapons/defs/shotgun';
import { sidearmService } from '@/weapons/defs/sidearm';
import { smgCompact } from '@/weapons/defs/smg-compact';

/** The classes authored, in roster order. Six of `WeaponId`'s seven values —
 * see `ALIASES` below for why the seventh, `carbine`, is not a seventh file. */
export const AUTHORED: readonly WeaponId[] = [
  'ar_service',
  'smg_compact',
  'dmr_marksman',
  'lmg_support',
  'shotgun',
  'sidearm',
];

/**
 * `WeaponId` carries seven values and `carbine` IS THE ONE DELIBERATE ALIAS,
 * not a placeholder awaiting a class that never shipped. Issue #3 asked this
 * pass to decide the question explicitly rather than leave it as an accident
 * of the old fallback table, and the decision is: a carbine is a short-barrel
 * service rifle, not a distinct weapon class — real militaries issue an M4 and
 * call the M16-length version "the rifle" and the shorter one "the carbine"
 * without pretending they are different guns. `ar_service`'s `WeaponShape` in
 * `models/build.ts` already IS that short-barrel silhouette (a 14.5" gun, not a
 * 20"), so resolving `carbine` to it is not a stand-in — it is the correct
 * weapon under its other name. `shotgun` and `sidearm` are no longer in this
 * table: `defs/shotgun.ts` and `defs/sidearm.ts` are real, tuned classes now,
 * so the two rows that used to alias them to `smg_compact` are simply gone.
 */
const ALIASES: Readonly<Partial<Record<WeaponId, WeaponId>>> = {
  carbine: 'ar_service',
};

const warned = new Set<string>();

export function buildWeaponTable(): Map<WeaponId, WeaponDef> {
  const table = new Map<WeaponId, WeaponDef>();
  table.set('ar_service', arService(weaponMeshKey('ar_service')));
  table.set('smg_compact', smgCompact(weaponMeshKey('smg_compact')));
  table.set('dmr_marksman', dmrMarksman(weaponMeshKey('dmr_marksman')));
  table.set('lmg_support', lmgSupport(weaponMeshKey('lmg_support')));
  table.set('shotgun', shotgunBreacher(weaponMeshKey('shotgun')));
  table.set('sidearm', sidearmService(weaponMeshKey('sidearm')));
  return table;
}

export function resolveId(id: WeaponId): WeaponId {
  const alias = ALIASES[id];
  if (!alias) return id;
  if (!warned.has(id)) {
    warned.add(id);
    console.warn(`[weapons] "${id}" is not authored yet; falling back to "${alias}".`);
  }
  return alias;
}
