/**
 * Weapon bake steps. WEAPONS owns this file.
 *
 * Architecture §6.1 step 9 — "weapon meshes + attachments" — at 90 units. The
 * work is pure geometry construction with no GL calls and no typed-array
 * round-trip worth transferring, so it is `BakeKind.MainThread`: a worker would
 * have to serialise `BufferGeometry` in both directions to save ~8 ms.
 *
 * Two assets per weapon, and the split is deliberate:
 *
 *   `weapons.<id>.model`  — the PART LIST. The viewmodel rig hangs these off
 *                           animated nodes, so the magazine can drop and the
 *                           charging handle can reciprocate.
 *   `weapons.<id>.mesh`   — one merged `MeshAsset` with LODs and convex
 *                           collision, which is what `WeaponDef.mesh` names and
 *                           what AI will put in a bot's hands.
 *
 * Both come out of ONE call to `buildWeaponModel`, so the gun in your hands and
 * the gun in a bot's hands can never drift apart.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type ColliderShape,
  type MeshAsset,
  type WeaponId,
} from '@/engine/types';
import { buildHand, buildWeaponModel, type WeaponModel } from '@/weapons/models/build';
import { bevelBox, mergeParts, place, tube } from '@/weapons/models/prim';

/** Every weapon this lane ships. The `WeaponDef` table is built from it. */
export const WEAPON_IDS: readonly WeaponId[] = [
  'ar_service',
  'smg_compact',
  'dmr_marksman',
  'lmg_support',
  'shotgun',
  'sidearm',
];

interface WeaponKeys {
  readonly model: AssetKey<WeaponModel>;
  readonly mesh: AssetKey<MeshAsset>;
}

const weaponKeys = new Map<WeaponId, WeaponKeys>();
let handsKey: AssetKey<{ left: THREE.BufferGeometry; right: THREE.BufferGeometry }> | null = null;

/** Declared in `registerWeaponsBakes`, resolved before any service is built. */
export function declareWeaponAssets(assets: AssetRegistry): void {
  if (weaponKeys.size > 0) return;
  for (const id of WEAPON_IDS) {
    const model = assets.define<WeaponModel>(`weapons.${id}.model`, AssetKind.Mesh, {
      kind: BakeKind.MainThread,
      version: 1,
      // ~90 units across three weapons plus the hands, matching the budget the
      // bake schedule reserves for step 9. Over the ceiling the scheduler
      // degrades resolution, and geometry ignores `grantedTexelSize`, so these
      // costs exist to keep the SHARE of the total honest.
      cost: 22,
      run: (ctx) => buildWeaponModel(id, ctx.rng),
    });
    const mesh = assets.define<MeshAsset>(`weapons.${id}.mesh`, AssetKind.Mesh, {
      kind: BakeKind.MainThread,
      version: 1,
      cost: 6,
      dependsOn: [model],
      run: (ctx) => mergeToMeshAsset(ctx.require(model)),
    });
    weaponKeys.set(id, { model, mesh });
  }
}

/** Declared in `registerViewmodelBakes`. Hands are the rig's, not the weapon's. */
export function declareHandAssets(assets: AssetRegistry): void {
  if (handsKey) return;
  handsKey = assets.define<{ left: THREE.BufferGeometry; right: THREE.BufferGeometry }>(
    'weapons.hands',
    AssetKind.Mesh,
    {
      kind: BakeKind.MainThread,
      version: 1,
      cost: 12,
      run: () => ({
        // The support hand is open around a handguard; the firing hand is a
        // closed fist on a grip. Two different wrap values, one builder.
        left: buildHand(-1, 0.32),
        right: buildHand(1, 0.86),
      }),
    },
  );
}

export function weaponMeshKey(id: WeaponId): AssetKey<MeshAsset> {
  const keys = weaponKeys.get(id);
  if (!keys) throw new Error(`weapon "${id}" has no declared mesh — declareWeaponAssets() did not run`);
  return keys.mesh;
}

export function weaponModelKey(id: WeaponId): AssetKey<WeaponModel> {
  const keys = weaponKeys.get(id);
  if (!keys) throw new Error(`weapon "${id}" has no declared model — declareWeaponAssets() did not run`);
  return keys.model;
}

export function handsAssetKey(): AssetKey<{ left: THREE.BufferGeometry; right: THREE.BufferGeometry }> {
  if (!handsKey) throw new Error('hands were never declared — declareViewmodelBakes() did not run');
  return handsKey;
}

/* --------------------------------------------------------------- merge/LOD -- */

/**
 * Merge the part list into the third-person `MeshAsset`.
 *
 * LOD1 is HAND-AUTHORED rather than decimated: a general decimator on a weapon
 * collapses the rail teeth and the trigger guard first (they are the smallest
 * triangles) and leaves a smooth rod, which is exactly the silhouette that
 * makes a distant soldier look unarmed. Six boxes that keep the outline are
 * worth more at 40 m than 800 decimated triangles.
 */
function mergeToMeshAsset(model: WeaponModel): MeshAsset {
  const lod0 = mergeParts(model.parts.map((p) => p.geometry.clone()));
  lod0.computeBoundingBox();
  const bounds = new THREE.Box3().copy(lod0.boundingBox ?? new THREE.Box3());

  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(centre);

  const lod1 = mergeParts([
    place(bevelBox(size.x * 0.62, 0.070, 0.30, 0.001), [0, -0.010, 0.150]),
    place(tube(0.011, 0.26, 8), [0, 0, -0.130]),
    place(bevelBox(0.026, 0.150, 0.040, 0.001), [0, -0.100, 0.090]),
    place(bevelBox(0.034, 0.052, 0.180, 0.001), [0, -0.006, 0.380]),
  ]);

  // Collision is a deliberate SECOND representation — never the render mesh.
  // A dropped weapon is a box; nothing in this game needs more.
  const collision: readonly ColliderShape[] = [
    {
      kind: 'box',
      half: new THREE.Vector3(size.x * 0.5, size.y * 0.5, size.z * 0.5),
      offset: centre.clone(),
    },
  ];

  return {
    lods: [lod0, lod1],
    // Projected radius in pixels below which each LOD is picked. A weapon is
    // ~0.9 m long, so 26 px is roughly 30 m at 1080p/68°.
    screenErrors: [26, 0],
    collision,
    bounds,
    surface: SurfaceId.PaintedMetal,
  };
}
