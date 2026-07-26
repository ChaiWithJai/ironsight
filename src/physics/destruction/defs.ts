/**
 * The destructible catalogue, and the bake steps that pre-fracture it. OWNER: PHYS.
 *
 * A destructible is authored ONCE as a solid with a material and a shard count,
 * and the Voronoi fracture that turns it into rubble runs during the load bake
 * (see `fracture.ts` for why it can never run at runtime). LEVEL will hand out
 * its own `DestructibleDef`s through `collectDestructibles()`; these three
 * templates are the ones PHYS itself needs — the cover the destruction shot is
 * posed against, and the kit the proving ground is built from.
 *
 * SHARD COUNT IS A QUALITY DECISION, TAKEN AT BAKE TIME. It cannot be taken
 * later: the shards ARE the baked asset. Low bakes a wall into fifteen pieces
 * and Ultra into thirty-eight, and the runtime `maxChunks` ceiling then limits
 * how many of them may be live at once. Two independent knobs, because the cost
 * they each control is different — geometry memory versus solver time.
 */
import * as THREE from 'three';
import {
  AssetKind,
  BakeKind,
  QualityTier,
  SurfaceId,
  type AssetKey,
  type AssetRegistry,
  type DestructibleDef,
  type MeshAsset,
  type QualitySettings,
} from '@/engine/types';
import { fractureBox } from '@/physics/destruction/fracture';
import { physicsLayoutRng } from '@/physics/world';

export type TemplateId = 'cover_wall_sandstone' | 'barrier_concrete' | 'crate_timber';

interface Template {
  readonly id: TemplateId;
  /** Half-extents of the intact solid, metres. */
  readonly half: THREE.Vector3;
  readonly surface: SurfaceId;
  readonly material: DestructibleDef['material'];
  /** Shard count at QualityTier.High; other tiers scale from this. */
  readonly sites: number;
  readonly health: number;
  readonly chipThreshold: number;
  readonly explosiveMultiplier: number;
  readonly coverValue: number;
}

const TEMPLATES: readonly Template[] = [
  {
    id: 'cover_wall_sandstone',
    // Chest-high plus a course: 5 m of frontage, 2.4 m tall, 450 mm thick. The
    // proportions of the low masonry garden walls the whole town is made of.
    half: new THREE.Vector3(2.5, 1.2, 0.225),
    surface: SurfaceId.Sandstone,
    material: 'brick',
    sites: 30,
    // ~7 rifle magazines, or one rocket. Masonry shrugs off bullets.
    health: 2400,
    chipThreshold: 90,
    explosiveMultiplier: 6.5,
    coverValue: 0.85,
  },
  {
    id: 'barrier_concrete',
    half: new THREE.Vector3(1.1, 0.55, 0.35),
    surface: SurfaceId.Concrete,
    material: 'concrete',
    sites: 14,
    health: 1800,
    chipThreshold: 120,
    explosiveMultiplier: 5,
    coverValue: 0.6,
  },
  {
    id: 'crate_timber',
    half: new THREE.Vector3(0.5, 0.45, 0.5),
    surface: SurfaceId.Wood,
    material: 'wood',
    sites: 10,
    health: 340,
    chipThreshold: 25,
    explosiveMultiplier: 3,
    coverValue: 0.3,
  },
];

const keys = new Map<TemplateId, AssetKey<MeshAsset>>();
const defs = new Map<TemplateId, DestructibleDef>();

/** Shard count multiplier per tier. Geometry memory, not solver time. */
function siteScale(tier: QualityTier): number {
  switch (tier) {
    case QualityTier.Low:
      return 0.5;
    case QualityTier.Medium:
      return 0.72;
    case QualityTier.Ultra:
      return 1.28;
    default:
      return 1;
  }
}

export function registerFractureBakes(assets: AssetRegistry, quality: Readonly<QualitySettings>): void {
  keys.clear();
  defs.clear();
  for (const template of TEMPLATES) {
    const sites = Math.max(6, Math.round(template.sites * siteScale(quality.tier)));
    const key = assets.define<MeshAsset>(`phys.fracture.${template.id}`, AssetKind.Mesh, {
      kind: BakeKind.WorkerMesh,
      version: 1,
      // Triple-plane enumeration over ~16 planes per shard: real work, but
      // linear in shard count and measured in single-digit milliseconds.
      cost: 6 + Math.round(sites * 0.4),
      cacheable: false,
      run: () =>
        fractureBox(template.half, sites, physicsLayoutRng(`fracture.${template.id}`), template.surface),
    });
    keys.set(template.id, key);
    defs.set(template.id, {
      id: template.id,
      material: template.material,
      health: template.health,
      surface: template.surface,
      chunks: key,
      chipThreshold: template.chipThreshold,
      explosiveMultiplier: template.explosiveMultiplier,
      // Rubble that vanishes while you are looking at it is worse than rubble
      // that never spawned. 45 s is longer than any firefight over one wall.
      debrisLifetime: 45,
      settleAfter: quality.destruction.settleSeconds,
      blocksLosWhenIntact: true,
      coverValue: template.coverValue,
    });
  }
}

export function templateDef(id: TemplateId): DestructibleDef | undefined {
  return defs.get(id);
}

export function templateHalf(id: TemplateId): THREE.Vector3 {
  const t = TEMPLATES.find((x) => x.id === id);
  return t ? t.half.clone() : new THREE.Vector3(0.5, 0.5, 0.5);
}
