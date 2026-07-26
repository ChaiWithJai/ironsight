/**
 * The walkable-height field — the CPU half of the navmesh bake.
 *
 * OWNER: AI.
 *
 * This is the expensive, service-free half of navigation: one evaluation of the
 * frozen macro silhouette per grid corner, from which slope, water depth and a
 * per-cell walkability bit are derived. It is service-free ON PURPOSE, because
 * `registerNavBakes` runs after `assets` and BEFORE every subsystem exists —
 * there is no `LevelService` to ask at that point. Obstacles are stamped later,
 * at `createNavService`, when `level` is constructed (see `navgraph.ts`).
 *
 * Everything here is plain typed arrays, so the whole field is transferable and
 * the job can move into BAKE's worker pool the moment that pool has a protocol.
 */
import { MACRO_TERRAIN } from '@/engine/macro';

export interface NavFieldDesc {
  readonly minX: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly cellSize: number;
  /** Steepest ground a soldier walks up, degrees. Matches CharacterConfig.maxSlopeDeg. */
  readonly maxSlopeDeg: number;
  /** Ground below `seaLevel + this` is water and is not walkable. */
  readonly minFreeboard: number;
}

export interface NavField {
  readonly minX: number;
  readonly minZ: number;
  readonly cellSize: number;
  /** Cell counts. Corner arrays are (nx + 1) × (nz + 1). */
  readonly nx: number;
  readonly nz: number;
  /** Ground height at every grid corner, row-major over z. */
  readonly cornerY: Float32Array;
  /** Ground height at every cell centre (mean of its four corners). */
  readonly cellY: Float32Array;
  /** 1 = terrain here is walkable before obstacles are stamped. */
  readonly terrainWalkable: Uint8Array;
}

/**
 * The combat envelope. Deliberately NOT the full 800 × 800 m macro bounds: two
 * thirds of that is open sea and inland hill nobody fights over, and a nav grid
 * is quadratic in the side it covers. This rectangle contains all three capture
 * points (ALPHA 78,96 · BRAVO −26,6 · CHARLIE −212,−48), the town between them
 * and 60 m of run-up on every side.
 */
export const NAV_FIELD_DESC: NavFieldDesc = Object.freeze({
  minX: -300,
  minZ: -140,
  sizeX: 500,
  sizeZ: 380,
  cellSize: 1,
  maxSlopeDeg: 50,
  minFreeboard: 0.35,
});

/**
 * Build the field. `onBand` is awaited every `bandRows` rows so the bake can
 * yield to the browser — a 190 k-cell field is ~60 ms of solid arithmetic and
 * the capture harness cannot tell a long synchronous loop from a hang.
 */
export async function buildNavField(
  desc: NavFieldDesc,
  onBand?: (fraction01: number) => Promise<void> | void,
): Promise<NavField> {
  const cs = desc.cellSize;
  const nx = Math.max(1, Math.round(desc.sizeX / cs));
  const nz = Math.max(1, Math.round(desc.sizeZ / cs));
  const cw = nx + 1;
  const cornerY = new Float32Array(cw * (nz + 1));
  const cellY = new Float32Array(nx * nz);
  const terrainWalkable = new Uint8Array(nx * nz);

  const bandRows = 48;
  for (let j = 0; j <= nz; j++) {
    const z = desc.minZ + j * cs;
    for (let i = 0; i <= nx; i++) {
      cornerY[j * cw + i] = MACRO_TERRAIN.height(desc.minX + i * cs, z);
    }
    if (onBand && j % bandRows === bandRows - 1) await onBand((j + 1) / (nz + 1));
  }

  // Slope is measured from the cell's own corners rather than a central
  // difference: a soldier is blocked by the steepest thing INSIDE the cell he
  // would stand in, not by the average gradient around it.
  const maxSlopeTan = Math.tan((desc.maxSlopeDeg * Math.PI) / 180);
  const waterY = MACRO_TERRAIN.seaLevel + desc.minFreeboard;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = cornerY[j * cw + i];
      const b = cornerY[j * cw + i + 1];
      const c = cornerY[(j + 1) * cw + i];
      const d = cornerY[(j + 1) * cw + i + 1];
      const y = (a + b + c + d) * 0.25;
      const dx = Math.max(Math.abs(b - a), Math.abs(d - c));
      const dz = Math.max(Math.abs(c - a), Math.abs(d - b));
      const slope = Math.hypot(dx, dz) / cs;
      const idx = j * nx + i;
      cellY[idx] = y;
      terrainWalkable[idx] = slope <= maxSlopeTan && y >= waterY ? 1 : 0;
    }
  }

  return { minX: desc.minX, minZ: desc.minZ, cellSize: cs, nx, nz, cornerY, cellY, terrainWalkable };
}
