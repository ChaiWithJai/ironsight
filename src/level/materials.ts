/**
 * LEVEL's material palette.
 *
 * OWNER: LEVEL.
 *
 * FIFTEEN materials for the entire town, and that number is a budget decision,
 * not an aesthetic one: `MaterialFactory.create()` throws past
 * `QualitySettings.budgets.shaderPrograms` (24 on Low, 40 on High/Ultra) and
 * that cap is shared with every other lane. Variety therefore has to come from
 * GEOMETRY and from per-plot choice among these fifteen, never from minting a
 * material per building.
 *
 * The four `plaster*` entries exist because a Levantine street is not one
 * colour: limewashed white, ochre, a faded rose and a pale sea-green, weathered
 * to different degrees, is the actual palette, and picking one per plot is what
 * stops 120 buildings reading as one extruded mass.
 *
 * Colours are authored in sRGB. Once RCORE's uber material lands these specs
 * gain wear masks, detail normals and triplanar tiling; the ids and the
 * `SurfaceId` mapping are the part that must be right today, because ballistics,
 * audio, VFX and AI all key off `SurfaceId`.
 */
import * as THREE from 'three';
import { MaterialFeature, SurfaceId, type MaterialFactory, type MaterialSpec } from '@/engine/types';

export type MatKey =
  | 'plasterWhite'
  | 'plasterOchre'
  | 'plasterRose'
  | 'plasterTeal'
  | 'sandstone'
  | 'concrete'
  | 'tile'
  | 'wood'
  | 'paint'
  | 'rust'
  | 'steel'
  | 'glass'
  | 'fabric'
  | 'rubble'
  | 'sand';

export const MAT_KEYS: readonly MatKey[] = [
  'plasterWhite',
  'plasterOchre',
  'plasterRose',
  'plasterTeal',
  'sandstone',
  'concrete',
  'tile',
  'wood',
  'paint',
  'rust',
  'steel',
  'glass',
  'fabric',
  'rubble',
  'sand',
];

/** The four wall washes, in the order a plot picks from them. */
export const WALL_MATS: readonly MatKey[] = ['plasterWhite', 'plasterOchre', 'plasterRose', 'plasterTeal'];

interface MatDef {
  readonly surface: SurfaceId;
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly doubleSided?: boolean;
  readonly features?: number;
}

/**
 * Roughness values are deliberately high and close together. Golden-hour sun at
 * 6–10° rakes across every one of these surfaces at a grazing angle, and a
 * roughness below ~0.55 on a wall turns that rake into a mirror strip that reads
 * as plastic. Only glass and bare steel go below 0.5.
 */
const DEFS: Record<MatKey, MatDef> = {
  plasterWhite: { surface: SurfaceId.Plaster, color: 0xc9bda6, roughness: 0.93, metalness: 0 },
  plasterOchre: { surface: SurfaceId.Stucco, color: 0xb08f5e, roughness: 0.92, metalness: 0 },
  plasterRose: { surface: SurfaceId.Stucco, color: 0xa87a68, roughness: 0.94, metalness: 0 },
  plasterTeal: { surface: SurfaceId.Plaster, color: 0x8fa093, roughness: 0.93, metalness: 0 },
  sandstone: { surface: SurfaceId.Sandstone, color: 0xa78c63, roughness: 0.95, metalness: 0 },
  concrete: { surface: SurfaceId.Concrete, color: 0x8e8a7d, roughness: 0.9, metalness: 0 },
  tile: { surface: SurfaceId.Tile, color: 0x8f4d33, roughness: 0.78, metalness: 0 },
  wood: { surface: SurfaceId.Wood, color: 0x6b4f33, roughness: 0.88, metalness: 0 },
  paint: { surface: SurfaceId.PaintedWood, color: 0x3d6470, roughness: 0.72, metalness: 0 },
  rust: { surface: SurfaceId.RustedMetal, color: 0x77503a, roughness: 0.82, metalness: 0.35 },
  steel: { surface: SurfaceId.PaintedMetal, color: 0x9d8f6f, roughness: 0.6, metalness: 0.5 },
  glass: { surface: SurfaceId.Glass, color: 0x18201f, roughness: 0.22, metalness: 0.05 },
  fabric: { surface: SurfaceId.Tarp, color: 0x9c8557, roughness: 0.96, metalness: 0, doubleSided: true },
  rubble: { surface: SurfaceId.Rubble, color: 0x8b7c62, roughness: 0.97, metalness: 0 },
  sand: { surface: SurfaceId.Sand, color: 0xb6a179, roughness: 0.98, metalness: 0 },
};

export function surfaceOf(key: MatKey): SurfaceId {
  return DEFS[key].surface;
}

export function createLevelMaterials(materials: MaterialFactory): Record<MatKey, THREE.Material> {
  const out = {} as Record<MatKey, THREE.Material>;
  for (const key of MAT_KEYS) {
    const d = DEFS[key];
    const spec: MaterialSpec = {
      id: `level.${key}`,
      surface: d.surface,
      layer: 0,
      // DetailNormal + WearMask are no-ops against the day-0 factory and become
      // the mesoscale break-up the brief demands the moment the uber material
      // lands. Declaring them now means LEVEL does not need a second pass.
      features: d.features ?? (MaterialFeature.DetailNormal | MaterialFeature.WearMask),
      baseColor: d.color,
      roughness: d.roughness,
      metalness: d.metalness,
      doubleSided: d.doubleSided,
      detailScale: 2.5,
      wearBias: 0.55,
      tilingScale: 1,
    };
    out[key] = materials.create(spec);
  }
  return out;
}
