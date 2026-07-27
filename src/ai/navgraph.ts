/**
 * The searchable navmesh — convex polygons, portal-linked, plus a uniform
 * lookup grid so `sample()` and `raycastWalkable()` are O(1) rather than O(polys).
 *
 * OWNER: AI.
 *
 * TWO PRODUCERS, ONE STRUCTURE.
 *  1. `buildFromField` merges the walkable cells of a `NavField` into maximal
 *     axis-aligned rectangles and links neighbours by the OVERLAP of their
 *     shared edge. Rectangle merging is what keeps A* to a few thousand nodes
 *     over a 190 k-cell field; computing the portal from the overlap rather
 *     than from shared vertices is what makes partial-overlap neighbours work
 *     without re-splitting every rectangle.
 *  2. `buildFromNavmeshData` adopts a mesh baked by LEVEL, where polygons are
 *     triangles and `polyNeighbours` is edge-adjacency at stride 3. Both end up
 *     as the same portal graph, so the pathfinder has one implementation.
 *
 * Height discontinuities between adjacent cells are NOT holes: within step
 * height they are walk links, within vault height they are two-way OFF-MESH
 * links, and below the drop ceiling they are one-way drop links. That is where
 * vaults and drops come from — they are a property of the ground, not authored.
 */
import * as THREE from 'three';
import type { NavmeshData, Vec3 } from '@/engine/types';
import type { NavField } from '@/ai/navfield';

/** Traversal class of one adjacency. Steering reads it to know when to jump. */
export enum NavLink {
  Walk = 0,
  /** Two-way, needs a vault animation and costs time. */
  Vault = 1,
  /** One-way, downhill only. */
  Drop = 2,
}

export enum NavFlag {
  Walkable = 1,
  /** Temporarily closed by destruction debris or a dynamic obstacle. */
  Blocked = 2,
}

export interface NavAgent {
  readonly radius: number;
  readonly height: number;
  readonly stepHeight: number;
  readonly vaultHeight: number;
  readonly maxDrop: number;
}

export const DEFAULT_AGENT: NavAgent = Object.freeze({
  radius: 0.34,
  height: 1.8,
  stepHeight: 0.42,
  vaultHeight: 1.35,
  maxDrop: 4,
});

/** World-space AABB of something a soldier cannot walk through. */
export interface NavObstacle {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export class NavGraph {
  polyCount = 0;
  /** Polygon rings, CSR: `ringStart[p] … ringStart[p+1]` indices into `ringXyz`. */
  ringStart = new Int32Array(1);
  ringXyz = new Float32Array(0);
  centres = new Float32Array(0);
  flags = new Uint8Array(0);
  /** Adjacency, CSR by polygon. */
  adjStart = new Int32Array(1);
  adjPoly = new Int32Array(0);
  adjKind = new Uint8Array(0);
  /** Two portal endpoints per adjacency, 6 floats. Unordered; the funnel orients them. */
  adjPortal = new Float32Array(0);
  /** Extra metres of "effort" charged for this edge on top of its length. */
  adjPenalty = new Float32Array(0);

  /** Uniform lookup grid over the same footprint as the source field. */
  minX = 0;
  minZ = 0;
  cellSize = 1;
  nx = 0;
  nz = 0;
  cellPoly = new Int32Array(0);

  get ready(): boolean {
    return this.polyCount > 0;
  }

  cellIndexAt(x: number, z: number): number {
    const i = Math.floor((x - this.minX) / this.cellSize);
    const j = Math.floor((z - this.minZ) / this.cellSize);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  polyAt(x: number, z: number): number {
    const c = this.cellIndexAt(x, z);
    if (c < 0) return -1;
    const p = this.cellPoly[c];
    return p >= 0 && (this.flags[p] & NavFlag.Blocked) === 0 ? p : -1;
  }

  centre(poly: number, out: Vec3): Vec3 {
    return out.set(this.centres[poly * 3], this.centres[poly * 3 + 1], this.centres[poly * 3 + 2]);
  }

  /**
   * Ground height inside `poly` at (x, z), from the plane through its first
   * three ring vertices. Polygons are near-planar by construction, so this is
   * exact for rectangles and for triangles and within a few centimetres of
   * exact for anything LEVEL bakes.
   */
  heightAt(poly: number, x: number, z: number): number {
    const s = this.ringStart[poly] * 3;
    const ax = this.ringXyz[s];
    const ay = this.ringXyz[s + 1];
    const az = this.ringXyz[s + 2];
    const bx = this.ringXyz[s + 3];
    const by = this.ringXyz[s + 4];
    const bz = this.ringXyz[s + 5];
    const cx = this.ringXyz[s + 6];
    const cy = this.ringXyz[s + 7];
    const cz = this.ringXyz[s + 8];
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(ny) < 1e-5) return this.centres[poly * 3 + 1];
    return ay - (nx * (x - ax) + nz * (z - az)) / ny;
  }

  /** Nearest walkable point within `radius`, by expanding ring search. */
  sample(position: Vec3, radius: number, out: Vec3): boolean {
    const cs = this.cellSize;
    const i0 = Math.floor((position.x - this.minX) / cs);
    const j0 = Math.floor((position.z - this.minZ) / cs);
    const maxR = Math.max(1, Math.ceil(radius / cs));
    let best = -1;
    let bestD2 = Infinity;
    let bestX = 0;
    let bestZ = 0;
    for (let r = 0; r <= maxR; r++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        if (j < 0 || j >= this.nz) continue;
        const edge = j === j0 - r || j === j0 + r;
        for (let i = i0 - r; i <= i0 + r; i += edge ? 1 : 2 * r || 1) {
          if (i < 0 || i >= this.nx) continue;
          const p = this.cellPoly[j * this.nx + i];
          if (p < 0 || (this.flags[p] & NavFlag.Blocked) !== 0) continue;
          const cx = this.minX + (i + 0.5) * cs;
          const cz = this.minZ + (j + 0.5) * cs;
          const d2 = (cx - position.x) ** 2 + (cz - position.z) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = p;
            bestX = cx;
            bestZ = cz;
          }
        }
      }
      // Stop one ring after the first hit: the next ring cannot beat a hit that
      // is already inside it, and the search is otherwise O(radius²) every time.
      if (best >= 0 && bestD2 <= (r * cs) ** 2) break;
    }
    if (best < 0 || bestD2 > radius * radius) return false;
    out.set(bestX, this.heightAt(best, bestX, bestZ), bestZ);
    return true;
  }

  /**
   * Walk the grid from `from` toward `to`, stopping at the first cell that is
   * not walkable or that steps up more than the agent can. `out` receives the
   * last good point — the local steering primitive, and the string-pull's
   * shortcut test.
   */
  raycastWalkable(from: Vec3, to: Vec3, agent: NavAgent, out: Vec3): boolean {
    const cs = this.cellSize;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    out.copy(to);
    if (dist < 1e-4) return this.polyAt(from.x, from.z) >= 0;
    const steps = Math.ceil(dist / (cs * 0.5));
    let prevY = this.polyAt(from.x, from.z) >= 0 ? this.heightAt(this.polyAt(from.x, from.z), from.x, from.z) : from.y;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = from.x + dx * t;
      const z = from.z + dz * t;
      const p = this.polyAt(x, z);
      if (p < 0) {
        const back = Math.max(0, (s - 1) / steps);
        out.set(from.x + dx * back, prevY, from.z + dz * back);
        return false;
      }
      const y = this.heightAt(p, x, z);
      if (Math.abs(y - prevY) > agent.stepHeight + 0.15) {
        const back = Math.max(0, (s - 1) / steps);
        out.set(from.x + dx * back, prevY, from.z + dz * back);
        return false;
      }
      prevY = y;
    }
    out.y = prevY;
    return true;
  }

  /** Re-derive walkability inside a world rect after destruction changed it. */
  reblock(min: Vec3, max: Vec3, obstacles: readonly NavObstacle[], agent: NavAgent): void {
    const cs = this.cellSize;
    const i0 = Math.max(0, Math.floor((min.x - this.minX) / cs));
    const i1 = Math.min(this.nx - 1, Math.ceil((max.x - this.minX) / cs));
    const j0 = Math.max(0, Math.floor((min.z - this.minZ) / cs));
    const j1 = Math.min(this.nz - 1, Math.ceil((max.z - this.minZ) / cs));
    const touched = new Set<number>();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const p = this.cellPoly[j * this.nx + i];
        if (p >= 0) touched.add(p);
      }
    }
    for (const p of touched) {
      const cx = this.centres[p * 3];
      const cy = this.centres[p * 3 + 1];
      const cz = this.centres[p * 3 + 2];
      let blocked = false;
      for (const o of obstacles) {
        if (
          cx >= o.minX - agent.radius &&
          cx <= o.maxX + agent.radius &&
          cz >= o.minZ - agent.radius &&
          cz <= o.maxZ + agent.radius &&
          o.maxY > cy + agent.stepHeight &&
          o.minY < cy + agent.height
        ) {
          blocked = true;
          break;
        }
      }
      this.flags[p] = blocked ? NavFlag.Walkable | NavFlag.Blocked : NavFlag.Walkable;
    }
  }
}

interface PendingAdj {
  a: number;
  b: number;
  kind: NavLink;
  penalty: number;
  /** Portal interval along the shared edge, in world units. */
  lo: number;
  hi: number;
  /** True when the shared edge runs along Z (i.e. the neighbours differ in X). */
  vertical: boolean;
  /** Fixed coordinate of the shared edge. */
  at: number;
}

/**
 * How a height discontinuity between two neighbouring polygons is traversed —
 * or `null` when it cannot be.
 *
 * BOTH producers use this. Vaulting and dropping cost time a bot would rather
 * spend running, so they are charged as extra metres rather than forbidden;
 * anything beyond `maxDrop` is a fall, and a fall is not an edge. A navmesh
 * that omits this last clause offers the pathfinder routes off cliffs, which
 * present as bots standing at the top of one.
 */
function classifyLink(dy: number, agent: NavAgent): { kind: NavLink; penalty: number } | null {
  const a = Math.abs(dy);
  if (a <= agent.stepHeight) return { kind: NavLink.Walk, penalty: 0 };
  if (a <= agent.vaultHeight) return { kind: NavLink.Vault, penalty: 4 };
  if (a <= agent.maxDrop) return { kind: NavLink.Drop, penalty: 2.5 };
  return null;
}

/** Longest run of cells merged into one rectangle. Caps portal length and A* fan-out. */
const MAX_RECT = 10;
/** Height spread tolerated inside one rectangle. Above this the ground is a ramp, not a floor. */
const RECT_FLAT_TOLERANCE = 0.45;

export function buildFromField(
  field: NavField,
  obstacles: readonly NavObstacle[],
  agent: NavAgent,
): NavGraph {
  const { nx, nz, cellSize: cs, minX, minZ, cellY } = field;
  const walk = Uint8Array.from(field.terrainWalkable);

  // ---- stamp obstacles ----------------------------------------------------
  for (const o of obstacles) {
    const i0 = Math.max(0, Math.floor((o.minX - agent.radius - minX) / cs));
    const i1 = Math.min(nx - 1, Math.floor((o.maxX + agent.radius - minX) / cs));
    const j0 = Math.max(0, Math.floor((o.minZ - agent.radius - minZ) / cs));
    const j1 = Math.min(nz - 1, Math.floor((o.maxZ + agent.radius - minZ) / cs));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * nx + i;
        if (walk[idx] === 0) continue;
        const y = cellY[idx];
        // A kerb you step over and a beam you walk under are both not obstacles.
        if (o.maxY > y + agent.stepHeight && o.minY < y + agent.height) walk[idx] = 0;
      }
    }
  }

  // ---- greedy rectangle merge --------------------------------------------
  const cellPoly = new Int32Array(nx * nz).fill(-1);
  const rects: { i: number; j: number; w: number; h: number }[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (walk[idx] === 0 || cellPoly[idx] >= 0) continue;
      const y0 = cellY[idx];
      let w = 1;
      while (
        w < MAX_RECT &&
        i + w < nx &&
        walk[j * nx + i + w] === 1 &&
        cellPoly[j * nx + i + w] < 0 &&
        Math.abs(cellY[j * nx + i + w] - y0) <= RECT_FLAT_TOLERANCE
      ) {
        w++;
      }
      let h = 1;
      grow: while (h < MAX_RECT && j + h < nz) {
        for (let k = 0; k < w; k++) {
          const t = (j + h) * nx + i + k;
          if (walk[t] === 0 || cellPoly[t] >= 0 || Math.abs(cellY[t] - y0) > RECT_FLAT_TOLERANCE) break grow;
        }
        h++;
      }
      const id = rects.length;
      rects.push({ i, j, w, h });
      for (let b = 0; b < h; b++) for (let a = 0; a < w; a++) cellPoly[(j + b) * nx + i + a] = id;
    }
  }

  const graph = new NavGraph();
  graph.polyCount = rects.length;
  graph.minX = minX;
  graph.minZ = minZ;
  graph.cellSize = cs;
  graph.nx = nx;
  graph.nz = nz;
  graph.cellPoly = cellPoly;
  graph.flags = new Uint8Array(rects.length).fill(NavFlag.Walkable);
  graph.centres = new Float32Array(rects.length * 3);
  graph.ringStart = new Int32Array(rects.length + 1);
  graph.ringXyz = new Float32Array(rects.length * 4 * 3);

  const cw = nx + 1;
  for (let p = 0; p < rects.length; p++) {
    const r = rects[p];
    const x0 = minX + r.i * cs;
    const x1 = x0 + r.w * cs;
    const z0 = minZ + r.j * cs;
    const z1 = z0 + r.h * cs;
    const y00 = field.cornerY[r.j * cw + r.i];
    const y10 = field.cornerY[r.j * cw + r.i + r.w];
    const y11 = field.cornerY[(r.j + r.h) * cw + r.i + r.w];
    const y01 = field.cornerY[(r.j + r.h) * cw + r.i];
    graph.ringStart[p] = p * 4;
    const s = p * 12;
    graph.ringXyz.set([x0, y00, z0, x1, y10, z0, x1, y11, z1, x0, y01, z1], s);
    let ySum = 0;
    for (let b = 0; b < r.h; b++) for (let a = 0; a < r.w; a++) ySum += cellY[(r.j + b) * nx + r.i + a];
    graph.centres[p * 3] = (x0 + x1) * 0.5;
    graph.centres[p * 3 + 1] = ySum / (r.w * r.h);
    graph.centres[p * 3 + 2] = (z0 + z1) * 0.5;
  }
  graph.ringStart[rects.length] = rects.length * 4;

  // ---- adjacency, unioned per polygon pair --------------------------------
  const pending = new Map<number, PendingAdj>();
  const linkKind = (dy: number): { kind: NavLink; penalty: number } | null => classifyLink(dy, agent);
  const note = (pa: number, pb: number, kind: NavLink, penalty: number, vertical: boolean, at: number, lo: number, hi: number): void => {
    const key = pa * rects.length + pb;
    const found = pending.get(key);
    if (found) {
      found.lo = Math.min(found.lo, lo);
      found.hi = Math.max(found.hi, hi);
      return;
    }
    pending.set(key, { a: pa, b: pb, kind, penalty, lo, hi, vertical, at });
  };

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const pa = cellPoly[idx];
      if (pa < 0) continue;
      // +X neighbour
      if (i + 1 < nx) {
        const pb = cellPoly[idx + 1];
        if (pb >= 0 && pb !== pa) {
          const link = linkKind(cellY[idx + 1] - cellY[idx]);
          if (link) {
            const at = minX + (i + 1) * cs;
            const lo = minZ + j * cs;
            const hi = lo + cs;
            const drop = link.kind === NavLink.Drop;
            const down = cellY[idx + 1] < cellY[idx];
            if (!drop || down) note(pa, pb, link.kind, link.penalty, true, at, lo, hi);
            if (!drop || !down) note(pb, pa, link.kind, link.penalty, true, at, lo, hi);
          }
        }
      }
      // +Z neighbour
      if (j + 1 < nz) {
        const pb = cellPoly[idx + nx];
        if (pb >= 0 && pb !== pa) {
          const link = linkKind(cellY[idx + nx] - cellY[idx]);
          if (link) {
            const at = minZ + (j + 1) * cs;
            const lo = minX + i * cs;
            const hi = lo + cs;
            const drop = link.kind === NavLink.Drop;
            const down = cellY[idx + nx] < cellY[idx];
            if (!drop || down) note(pa, pb, link.kind, link.penalty, false, at, lo, hi);
            if (!drop || !down) note(pb, pa, link.kind, link.penalty, false, at, lo, hi);
          }
        }
      }
    }
  }

  finaliseAdjacency(graph, [...pending.values()], agent);
  return graph;
}

function finaliseAdjacency(graph: NavGraph, list: readonly PendingAdj[], agent: NavAgent): void {
  const counts = new Int32Array(graph.polyCount + 1);
  for (const e of list) counts[e.a]++;
  const start = new Int32Array(graph.polyCount + 1);
  let acc = 0;
  for (let p = 0; p < graph.polyCount; p++) {
    start[p] = acc;
    acc += counts[p];
  }
  start[graph.polyCount] = acc;
  const cursor = Int32Array.from(start);
  const adjPoly = new Int32Array(acc);
  const adjKind = new Uint8Array(acc);
  const adjPenalty = new Float32Array(acc);
  const adjPortal = new Float32Array(acc * 6);
  // Portals are inset by the agent radius at both ends: a corridor corner
  // string-pulled to the exact geometric portal endpoint puts the bot's
  // shoulder inside the wall, which reads as clipping rather than as pathing.
  const inset = Math.min(agent.radius, 0.45);
  for (const e of list) {
    const k = cursor[e.a]++;
    adjPoly[k] = e.b;
    adjKind[k] = e.kind;
    adjPenalty[k] = e.penalty;
    const lo = e.hi - e.lo > inset * 2 ? e.lo + inset : (e.lo + e.hi) * 0.5;
    const hi = e.hi - e.lo > inset * 2 ? e.hi - inset : (e.lo + e.hi) * 0.5;
    const o = k * 6;
    if (e.vertical) {
      adjPortal[o] = e.at;
      adjPortal[o + 1] = graph.heightAt(e.a, e.at, lo);
      adjPortal[o + 2] = lo;
      adjPortal[o + 3] = e.at;
      adjPortal[o + 4] = graph.heightAt(e.a, e.at, hi);
      adjPortal[o + 5] = hi;
    } else {
      adjPortal[o] = lo;
      adjPortal[o + 1] = graph.heightAt(e.a, lo, e.at);
      adjPortal[o + 2] = e.at;
      adjPortal[o + 3] = hi;
      adjPortal[o + 4] = graph.heightAt(e.a, hi, e.at);
      adjPortal[o + 5] = e.at;
    }
  }
  graph.adjStart = start;
  graph.adjPoly = adjPoly;
  graph.adjKind = adjKind;
  graph.adjPenalty = adjPenalty;
  graph.adjPortal = adjPortal;
}

/**
 * Adopt a navmesh baked by LEVEL. `polyNeighbours` is read at STRIDE 3 —
 * triangle edge adjacency, `-1` for a boundary edge, edge `e` spanning ring
 * vertices `e` and `(e + 1) % 3`. That is the only self-consistent reading of
 * `NavmeshData` (three indices per polygon, one flag and one centre per
 * polygon), and it is what `NavService.build` documents in `types.ts`.
 */
export function buildFromNavmeshData(data: NavmeshData, agent: NavAgent, lookupCell = 1): NavGraph {
  const triCount = Math.floor(data.indices.length / 3);
  const graph = new NavGraph();
  graph.polyCount = triCount;
  graph.ringStart = new Int32Array(triCount + 1);
  graph.ringXyz = new Float32Array(triCount * 9);
  graph.centres = new Float32Array(triCount * 3);
  graph.flags = new Uint8Array(triCount).fill(NavFlag.Walkable);

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let t = 0; t < triCount; t++) {
    graph.ringStart[t] = t * 3;
    for (let k = 0; k < 3; k++) {
      const v = data.indices[t * 3 + k] * 3;
      const x = data.vertices[v];
      const y = data.vertices[v + 1];
      const z = data.vertices[v + 2];
      graph.ringXyz[t * 9 + k * 3] = x;
      graph.ringXyz[t * 9 + k * 3 + 1] = y;
      graph.ringXyz[t * 9 + k * 3 + 2] = z;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    if (data.polyCentres.length >= (t + 1) * 3) {
      graph.centres[t * 3] = data.polyCentres[t * 3];
      graph.centres[t * 3 + 1] = data.polyCentres[t * 3 + 1];
      graph.centres[t * 3 + 2] = data.polyCentres[t * 3 + 2];
    } else {
      for (let k = 0; k < 3; k++) {
        graph.centres[t * 3 + k] =
          (graph.ringXyz[t * 9 + k] + graph.ringXyz[t * 9 + 3 + k] + graph.ringXyz[t * 9 + 6 + k]) / 3;
      }
    }
    if (data.polyFlags.length > t && data.polyFlags[t] === 0) graph.flags[t] = NavFlag.Walkable | NavFlag.Blocked;
  }
  graph.ringStart[triCount] = triCount * 3;

  const adjacency: { a: number; b: number; kind: NavLink; penalty: number; portal: number[] }[] = [];
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const nb = data.polyNeighbours[t * 3 + e];
      if (nb < 0 || nb >= triCount) continue;
      // HEIGHT DISCONTINUITIES ARE CLASSIFIED THE SAME WAY HERE AS IN
      // `buildFromField`. The version this replaced called every step over
      // `stepHeight` a `Drop`, charged it nothing, and made it TWO-WAY — so a
      // nine-metre quay wall was a free edge the pathfinder would happily route
      // both down AND up. Bots took those routes, walked to the lip, and stood
      // there: the character controller will not climb a wall the navmesh
      // promised. Measured symptom before this fix: clusters of bots parked at
      // exactly the same point on the edge of the ALPHA plateau, at full
      // throttle, for the whole run.
      const drop = graph.centres[nb * 3 + 1] - graph.centres[t * 3 + 1];
      const link = classifyLink(drop, agent);
      if (!link) continue;
      // A drop is one-way. `t → nb` exists only when `nb` is the lower of the
      // two; the reverse direction is generated when the neighbour's own edge
      // is visited, so nothing is lost by declining it here.
      if (link.kind === NavLink.Drop && drop > 0) continue;
      const a = t * 9 + e * 3;
      const b = t * 9 + ((e + 1) % 3) * 3;
      adjacency.push({
        a: t,
        b: nb,
        kind: link.kind,
        penalty: link.penalty,
        portal: [
          graph.ringXyz[a],
          graph.ringXyz[a + 1],
          graph.ringXyz[a + 2],
          graph.ringXyz[b],
          graph.ringXyz[b + 1],
          graph.ringXyz[b + 2],
        ],
      });
    }
  }

  const counts = new Int32Array(triCount + 1);
  for (const e of adjacency) counts[e.a]++;
  const start = new Int32Array(triCount + 1);
  let acc = 0;
  for (let p = 0; p < triCount; p++) {
    start[p] = acc;
    acc += counts[p];
  }
  start[triCount] = acc;
  const cursor = Int32Array.from(start);
  graph.adjStart = start;
  graph.adjPoly = new Int32Array(acc);
  graph.adjKind = new Uint8Array(acc);
  graph.adjPenalty = new Float32Array(acc);
  graph.adjPortal = new Float32Array(acc * 6);
  for (const e of adjacency) {
    const k = cursor[e.a]++;
    graph.adjPoly[k] = e.b;
    graph.adjKind[k] = e.kind;
    graph.adjPenalty[k] = e.penalty;
    graph.adjPortal.set(e.portal, k * 6);
  }

  // Lookup grid: rasterise each triangle's AABB and keep the triangle whose
  // centre is nearest the cell centre. Coarse, but `sample()` only needs a
  // starting polygon and the funnel corrects the rest.
  graph.minX = Math.floor(minX);
  graph.minZ = Math.floor(minZ);
  graph.cellSize = lookupCell;
  graph.nx = Math.max(1, Math.ceil((maxX - graph.minX) / lookupCell));
  graph.nz = Math.max(1, Math.ceil((maxZ - graph.minZ) / lookupCell));
  graph.cellPoly = new Int32Array(graph.nx * graph.nz).fill(-1);
  const bestD = new Float32Array(graph.nx * graph.nz).fill(Infinity);
  for (let t = 0; t < triCount; t++) {
    let tminX = Infinity;
    let tmaxX = -Infinity;
    let tminZ = Infinity;
    let tmaxZ = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = graph.ringXyz[t * 9 + k * 3];
      const z = graph.ringXyz[t * 9 + k * 3 + 2];
      tminX = Math.min(tminX, x);
      tmaxX = Math.max(tmaxX, x);
      tminZ = Math.min(tminZ, z);
      tmaxZ = Math.max(tmaxZ, z);
    }
    const i0 = Math.max(0, Math.floor((tminX - graph.minX) / lookupCell));
    const i1 = Math.min(graph.nx - 1, Math.floor((tmaxX - graph.minX) / lookupCell));
    const j0 = Math.max(0, Math.floor((tminZ - graph.minZ) / lookupCell));
    const j1 = Math.min(graph.nz - 1, Math.floor((tmaxZ - graph.minZ) / lookupCell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = graph.minX + (i + 0.5) * lookupCell;
        const cz = graph.minZ + (j + 0.5) * lookupCell;
        const d = (cx - graph.centres[t * 3]) ** 2 + (cz - graph.centres[t * 3 + 2]) ** 2;
        const c = j * graph.nx + i;
        if (d < bestD[c]) {
          bestD[c] = d;
          graph.cellPoly[c] = t;
        }
      }
    }
  }
  return graph;
}

/** Scratch shared by the callers below; AI is single-threaded per tick. */
export const NAV_SCRATCH = {
  a: new THREE.Vector3(),
  b: new THREE.Vector3(),
  c: new THREE.Vector3(),
};
