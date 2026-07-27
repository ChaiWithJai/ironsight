/**
 * THE FLOATING-PROP GUARD. LEVEL owns this file.
 *
 * `docs/AAA_RUBRIC.md` scores "geometry floating above the terrain" as a
 * worldcraft defect, and twelve rounds of blind critics never found the one
 * this level had — five 6 m shipping containers hanging 4.7 m over open ground
 * at BRAVO — because it sat outside every hero-shot framing. A human playing
 * found it in minutes. A screenshot cannot see what is not in it; this can.
 *
 * It reports every prop-scale box whose underside stands clear of whatever is
 * under it. "Under it" means the terrain, any built nav deck, OR the top face
 * of any other collider — a crate on a slab, a container on a container and a
 * barrel on a ship's deck are all supported and none of them is a floater. The
 * count rides on LEVEL's boot report line, so `./tools/soak.sh` and any capture
 * run with `CAPTURE_VERBOSE=1` both show it, and it must stay at zero.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG, so the number stays honest and therefore
 * worth watching: roof clutter (anything more than 4 m over the terrain), and
 * boxes thinner than 40 cm — a wall panel or a partition stands on a structure's
 * buried plinth, which is mesh rather than collider and so is invisible here.
 */
import * as THREE from 'three';
import { type StaticColliderDef } from '@/engine/types';
import { type NavDeck } from '@/level/build';

const _pos = new THREE.Vector3();
const _corner = new THREE.Vector3();

interface Aabb {
  minX: number; maxX: number; minZ: number; maxZ: number; top: number; bottom: number;
}

function aabbOf(c: StaticColliderDef): Aabb | null {
  const m = c.matrix as unknown as THREE.Matrix4;
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  let top = -Infinity; let bottom = Infinity;
  if (c.shape.kind === 'box') {
    const h = c.shape.half as unknown as { x: number; y: number; z: number };
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      _corner.set(sx * h.x, sy * h.y, sz * h.z).applyMatrix4(m);
      minX = Math.min(minX, _corner.x); maxX = Math.max(maxX, _corner.x);
      minZ = Math.min(minZ, _corner.z); maxZ = Math.max(maxZ, _corner.z);
      top = Math.max(top, _corner.y); bottom = Math.min(bottom, _corner.y);
    }
    return { minX, maxX, minZ, maxZ, top, bottom };
  }
  if (c.shape.kind === 'cylinder') {
    const s = c.shape as unknown as { radius: number; halfHeight: number };
    _pos.setFromMatrixPosition(m);
    return {
      minX: _pos.x - s.radius, maxX: _pos.x + s.radius,
      minZ: _pos.z - s.radius, maxZ: _pos.z + s.radius,
      top: _pos.y + s.halfHeight, bottom: _pos.y - s.halfHeight,
    };
  }
  return null;
}

function deckUnder(decks: readonly NavDeck[], x: number, z: number, ceiling: number): number {
  let best = -Infinity;
  for (const d of decks) {
    if (d.y > ceiling + 0.001 && d.rise <= 0) continue;
    const c = Math.cos(-d.yaw);
    const s = Math.sin(-d.yaw);
    const lx = (x - d.x) * c + (z - d.z) * s;
    const lz = -(x - d.x) * s + (z - d.z) * c;
    if (Math.abs(lx) > d.halfX + 0.4 || Math.abs(lz) > d.halfZ + 0.4) continue;
    const y = d.y + (d.rise ? d.rise * ((lz + d.halfZ) / (2 * d.halfZ)) : 0);
    if (y <= ceiling && y > best) best = y;
  }
  return best;
}

export function auditFloaters(
  colliders: readonly StaticColliderDef[],
  tags: readonly string[],
  decks: readonly NavDeck[],
  ground: (x: number, z: number) => number,
): number {
  // Coarse XZ hash of every collider, so the "what is under this prop" query is
  // not a scan of the whole level per prop.
  const CELL = 8;
  const grid = new Map<number, number[]>();
  const boxes: (Aabb | null)[] = [];
  const key = (ix: number, iz: number): number => ix * 100003 + iz;
  for (let i = 0; i < colliders.length; i++) {
    const a = aabbOf(colliders[i]);
    boxes.push(a);
    if (!a) continue;
    for (let ix = Math.floor(a.minX / CELL); ix <= Math.floor(a.maxX / CELL); ix++) {
      for (let iz = Math.floor(a.minZ / CELL); iz <= Math.floor(a.maxZ / CELL); iz++) {
        const k = key(ix, iz);
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
  }

  const supportFrom = (self: number, x: number, z: number, ceiling: number): number => {
    let best = -Infinity;
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return best;
    for (const i of list) {
      if (i === self) continue;
      const a = boxes[i];
      if (!a) continue;
      if (a.top > ceiling || a.top < best) continue;
      if (x < a.minX - 0.25 || x > a.maxX + 0.25 || z < a.minZ - 0.25 || z > a.maxZ + 0.25) continue;
      best = a.top;
    }
    return best;
  };

  const rows: { gap: number; tag: string; x: number; y: number; z: number; hx: number; hy: number; hz: number }[] = [];
  for (let ci = 0; ci < colliders.length; ci++) {
    const c = colliders[ci];
    if (c.shape.kind !== 'box') continue;
    const half = c.shape.half as unknown as { x: number; y: number; z: number };
    // Props only. A box thinner than 40 cm is a wall panel or a partition, and
    // those stand on a structure's buried plinth — mesh, not collider — so they
    // read as floating to a collider-only sweep and are not.
    if (half.y > 2.2 || Math.max(half.x, half.z) > 6) continue;
    if (Math.min(half.x, half.z) < 0.2) continue;
    const a = boxes[ci];
    if (!a) continue;
    const m = c.matrix as unknown as THREE.Matrix4;
    _pos.setFromMatrixPosition(m);
    const bottom = a.bottom;
    // Roof clutter stands metres above the terrain by design; the defect class
    // this hunts is a GROUND prop that has come off the ground.
    if (bottom - ground(_pos.x, _pos.z) > 4) continue;
    const ceiling = bottom + 0.35;
    let support = -Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      _corner.set(sx * half.x, -half.y, sz * half.z).applyMatrix4(m);
      const s = Math.max(
        ground(_corner.x, _corner.z),
        deckUnder(decks, _corner.x, _corner.z, ceiling),
        supportFrom(ci, _corner.x, _corner.z, ceiling),
      );
      if (s > support) support = s;
    }
    const gap = bottom - support;
    if (gap > 0.3 && Number.isFinite(gap)) {
      rows.push({ gap, tag: tags[ci] ?? '?', x: _pos.x, y: _pos.y, z: _pos.z, hx: half.x, hy: half.y, hz: half.z });
    }
  }
  if (rows.length === 0) {
    // `[boot]`-prefixed so `tools/soak.sh` keeps it: the soak harness collects
    // exactly those lines, and a standing zero is the only form of this
    // instrument anyone will actually look at.
    console.info('[boot] level · 0 floating props');
    return 0;
  }
  rows.sort((a, b) => b.gap - a.gap);
  const byTag = new Map<string, number>();
  for (const r of rows) byTag.set(r.tag, (byTag.get(r.tag) ?? 0) + 1);
  const lines = rows.slice(0, 30).map(
    (r) => `  [${r.tag}] gap ${r.gap.toFixed(2)}m at (${r.x.toFixed(1)}, ${r.y.toFixed(1)}, ${r.z.toFixed(1)}) ` +
      `half ${r.hx.toFixed(2)}/${r.hy.toFixed(2)}/${r.hz.toFixed(2)}`,
  );
  console.warn(
    `[boot] level · ${rows.length} FLOATING prop(s) — nothing under them within 0.3 m · ` +
    `${[...byTag].map(([t, n]) => `${t}:${n}`).join(' ')}\n${lines.join('\n')}`,
  );
  return rows.length;
}
