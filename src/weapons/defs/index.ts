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
import { smgCompact } from '@/weapons/defs/smg-compact';

/** The classes authored in this pass, in roster order. */
export const AUTHORED: readonly WeaponId[] = ['ar_service', 'smg_compact', 'dmr_marksman', 'lmg_support'];

/**
 * `WeaponId` carries seven classes and four are authored. Rather than fabricate
 * a shotgun and a sidearm nobody has tuned, unauthored ids resolve to the
 * nearest authored class and say so once. `carbine` is a genuine alias — a
 * carbine IS a short service rifle — and the other two are honest stand-ins
 * that keep HUD, AI and AUDIO working until the classes land.
 */
const ALIASES: Readonly<Partial<Record<WeaponId, WeaponId>>> = {
  carbine: 'ar_service',
  shotgun: 'smg_compact',
  sidearm: 'smg_compact',
};

const warned = new Set<string>();

export function buildWeaponTable(): Map<WeaponId, WeaponDef> {
  const table = new Map<WeaponId, WeaponDef>();
  table.set('ar_service', arService(weaponMeshKey('ar_service')));
  table.set('smg_compact', smgCompact(weaponMeshKey('smg_compact')));
  table.set('dmr_marksman', dmrMarksman(weaponMeshKey('dmr_marksman')));
  table.set('lmg_support', lmgSupport(weaponMeshKey('lmg_support')));
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
