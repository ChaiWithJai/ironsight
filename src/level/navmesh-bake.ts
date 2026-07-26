/**
 * NAVMESH BAKE — voxelise → span → region → poly.
 *
 * OWNER: LEVEL. The other half of bake step 12.
 *
 * LEVEL bakes this rather than AI because LEVEL is the lane that knows where the
 * floors are. A navmesh derived from colliders alone (which is what AI's
 * fallback does) cannot tell a rampart from the underside of a rampart, and it
 * has no idea that the market hall's arcade is walkable while its roof slab is a
 * different storey two metres up.
 *
 * WHY SPANS, AND WHY THIS IS NOT A HEIGHTFIELD
 * --------------------------------------------
 * A single height per cell cannot represent a fort with a wall-walk over a
 * courtyard, a warehouse with a roof, or a container you can climb onto. So each
 * cell carries a short SORTED LIST of walkable surfaces — one from the terrain,
 * plus one per `NavDeck` that covers it — and each surface becomes its own node.
 * Two surfaces closer together than `MIN_SPAN_GAP` collapse to the upper one,
 * because you cannot stand between them.
 *
 * Blocking is then a HEADROOM test rather than a footprint test: a surface is
 * walkable only if no `NavBlocker` occupies the column from just above it to
 * `AGENT_HEIGHT` above it. That is what makes the arcade walkable and the pier
 * between two arches not, from the same data.
 *
 * THE OUTPUT CONTRACT, restated because it is easy to get subtly wrong and
 * silently produce a mesh that pathfinds through walls (`NavService.build` in
 * `src/engine/types.ts` states it, and this is the producer side):
 *
 *   - `indices` is TRIPLES: one triangle per polygon.
 *   - `polyFlags`, `polyCentres` (3 floats) and `polyNeighbours` (3 ints) are
 *     indexed by TRIANGLE, not by vertex.
 *   - neighbour slot `e` is the triangle across the edge from ring vertex `e` to
 *     ring vertex `(e + 1) % 3`, or −1 at a border.
 *   - `polyFlags[i] === 0` means polygon `i` is NOT walkable.
 *
 * Each walkable span emits its cell quad as two triangles, wound so their normal
 * is +Y, with a fixed ring order. Adjacency is then read straight off the grid
 * topology instead of by hashing edges — exact, allocation-free, and immune to
 * the floating-point near-miss that edge hashing hits wherever two surfaces meet
 * at a fractionally different height.
 */
import type { NavmeshData } from '@/engine/types';
import type { NavBlocker, NavDeck } from '@/level/build';

/** Character capsule height. Anything with less headroom is not walkable. */
const AGENT_HEIGHT = 1.85;
/** Radius used to shrink the walkable set back from walls. */
const AGENT_RADIUS = 0.42;
/** Biggest height difference two adjacent cells can have and still connect. */
const MAX_STEP = 0.52;
/** Two surfaces closer than this in the same column collapse to one. */
const MIN_SPAN_GAP = 1.9;
/** Surfaces below this are in the sea. */
const MIN_WALKABLE_Y = 0.35;
/** Max walkable slope, as a rise over the cell size. tan(46°) ≈ 1.04. */
const MAX_SLOPE = 1.04;

export interface NavBakeInput {
  readonly bounds: Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number; cell: number }>;
  readonly decks: readonly NavDeck[];
  readonly blockers: readonly NavBlocker[];
  readonly groundAt: (x: number, z: number) => number;
}

export interface NavBakeStats {
  readonly cells: number;
  readonly spans: number;
  readonly triangles: number;
  readonly regions: number;
  readonly droppedIslands: number;
}

export interface NavBakeResult {
  readonly data: NavmeshData;
  readonly stats: NavBakeStats;
}

/** Uniform bucket grid over axis-aligned-ish footprints. */
class Buckets<T> {
  private readonly map = new Map<number, T[]>();

  constructor(private readonly cell: number) {}

  private key(gx: number, gz: number): number {
    return (gx & 0xffff) * 65536 + (gz & 0xffff);
  }

  insert(minX: number, minZ: number, maxX: number, maxZ: number, item: T): void {
    const gx0 = Math.floor(minX / this.cell);
    const gx1 = Math.floor(maxX / this.cell);
    const gz0 = Math.floor(minZ / this.cell);
    const gz1 = Math.floor(maxZ / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const k = this.key(gx, gz);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(item);
      }
    }
  }

  query(x: number, z: number): readonly T[] | undefined {
    return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  }
}

/** Is (x,z) inside a yawed rectangle? */
function insideRect(
  x: number, z: number,
  cx: number, cz: number, halfX: number, halfZ: number, yaw: number,
  grow: number,
): boolean {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // The build's convention: world = (lx·cos + lz·sin, −lx·sin + lz·cos), so the
  // inverse rotation is this one. Getting it backwards makes every yawed deck
  // and blocker land at a mirrored angle, which is invisible in a top-down debug
  // draw and catastrophic in the fort.
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= halfX + grow && Math.abs(lz) <= halfZ + grow;
}

interface Span {
  y: number;
  /** Index into the flat triangle arrays of this span's FIRST triangle. */
  tri: number;
  region: number;
}

export function bakeNavmesh(input: NavBakeInput): NavBakeResult {
  const { bounds, decks, blockers, groundAt } = input;
  const cell = bounds.cell;
  const nx = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / cell));
  const nz = Math.max(1, Math.floor((bounds.maxZ - bounds.minZ) / cell));

  // ---- 1. index the decks and blockers -----------------------------------
  const deckBuckets = new Buckets<NavDeck>(8);
  for (const d of decks) {
    const r = Math.hypot(d.halfX, d.halfZ);
    deckBuckets.insert(d.x - r, d.z - r, d.x + r, d.z + r, d);
  }
  const blockerBuckets = new Buckets<NavBlocker>(8);
  for (const b of blockers) {
    // A blocker smaller than the agent radius is something you walk around
    // without noticing — a bollard, a pipe, a merlon. Keeping them turns the
    // navmesh into swiss cheese at a 2 m cell size for no behavioural gain.
    if (Math.min(b.halfX, b.halfZ) < 0.3) continue;
    if (b.yMax - b.yMin < 0.35) continue;
    const r = Math.hypot(b.halfX, b.halfZ);
    blockerBuckets.insert(b.x - r, b.z - r, b.x + r, b.z + r, b);
  }

  // ---- 2. voxelise into spans --------------------------------------------
  const columns: Span[][] = new Array(nx * nz);
  const surfaces: number[] = [];
  let spanCount = 0;

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = bounds.minX + (ix + 0.5) * cell;
      const z = bounds.minZ + (iz + 0.5) * cell;
      surfaces.length = 0;

      const g = groundAt(x, z);
      if (g >= MIN_WALKABLE_Y) surfaces.push(g);

      const nearby = deckBuckets.query(x, z);
      if (nearby) {
        for (const d of nearby) {
          // Shrink decks by the agent radius: a bot whose centre is on the very
          // edge of a rampart is a bot that falls off it.
          if (!insideRect(x, z, d.x, d.z, d.halfX, d.halfZ, d.yaw, -AGENT_RADIUS)) continue;
          let y = d.y;
          if (d.rise !== 0) {
            // Sloped deck: interpolate across its local Z, low edge at −halfZ.
            const dx = x - d.x;
            const dz = z - d.z;
            const c = Math.cos(d.yaw);
            const s = Math.sin(d.yaw);
            const lz = dx * s + dz * c;
            const t = Math.min(1, Math.max(0, (lz + d.halfZ) / Math.max(1e-3, d.halfZ * 2)));
            y = d.y + d.rise * t;
          }
          if (y >= MIN_WALKABLE_Y) surfaces.push(y);
        }
      }
      if (surfaces.length === 0) {
        columns[iz * nx + ix] = [];
        continue;
      }

      surfaces.sort((a, b) => a - b);
      // Collapse surfaces you cannot stand between.
      const kept: number[] = [];
      for (let i = 0; i < surfaces.length; i++) {
        if (i + 1 < surfaces.length && surfaces[i + 1] - surfaces[i] < MIN_SPAN_GAP) continue;
        kept.push(surfaces[i]);
      }

      // Headroom test against the blockers.
      const bl = blockerBuckets.query(x, z);
      const spans: Span[] = [];
      for (const y of kept) {
        let blocked = false;
        if (bl) {
          for (const b of bl) {
            if (b.yMax <= y + 0.22 || b.yMin >= y + AGENT_HEIGHT) continue;
            if (!insideRect(x, z, b.x, b.z, b.halfX, b.halfZ, b.yaw, AGENT_RADIUS * 0.5)) continue;
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        spans.push({ y, tri: -1, region: -1 });
        spanCount++;
      }
      columns[iz * nx + ix] = spans;
    }
  }

  // ---- 3. connectivity + region flood fill --------------------------------
  // Neighbour offsets in the fixed ring order the triangle contract needs.
  const NEIGHBOURS: readonly [number, number][] = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  /** links[cellIndex][spanIndex][dir] = span index in that neighbour, or -1. */
  const links: Int32Array = new Int32Array(spanCount * 4).fill(-1);
  {
    let id = 0;
    for (let c = 0; c < nx * nz; c++) {
      for (const s of columns[c]) s.tri = id++;
    }
  }

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const spans = columns[iz * nx + ix];
      for (let si = 0; si < spans.length; si++) {
        const s = spans[si];
        for (let d = 0; d < 4; d++) {
          const [ox, oz] = NEIGHBOURS[d];
          const jx = ix + ox;
          const jz = iz + oz;
          if (jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
          const other = columns[jz * nx + jx];
          let bestIdx = -1;
          let bestDy = MAX_STEP;
          for (let oi = 0; oi < other.length; oi++) {
            const dy = Math.abs(other[oi].y - s.y);
            if (dy < bestDy) {
              bestDy = dy;
              bestIdx = oi;
            }
          }
          if (bestIdx < 0) continue;
          // A step is walkable; a cliff is not, and a slope steeper than
          // MAX_SLOPE is a cliff regardless of how small the step is.
          if (bestDy / cell > MAX_SLOPE) continue;
          links[s.tri * 4 + d] = other[bestIdx].tri;
        }
      }
    }
  }

  // Force the link graph SYMMETRIC. "Nearest span within MAX_STEP" is not a
  // mutual relation where three spans stack unevenly, and an asymmetric edge
  // produces a corridor the funnel algorithm cannot string-pull through — the
  // bot walks to the corner, re-plans, and oscillates. Dropping the one-way
  // half costs a handful of edges and removes the whole failure mode.
  for (let i = 0; i < spanCount; i++) {
    for (let d = 0; d < 4; d++) {
      const n = links[i * 4 + d];
      if (n < 0) continue;
      if (links[n * 4 + ((d + 2) % 4)] !== i) links[i * 4 + d] = -1;
    }
  }

  // Flood fill into regions, then drop the islands. An unreachable 30-cell
  // pocket on a roof is worse than useless: bots path INTO it and get stuck.
  const spanIndex: Span[] = new Array(spanCount);
  for (let c = 0; c < nx * nz; c++) for (const s of columns[c]) spanIndex[s.tri] = s;

  let regionCount = 0;
  const regionSize: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < spanCount; i++) {
    if (spanIndex[i].region >= 0) continue;
    const r = regionCount++;
    let size = 0;
    stack.length = 0;
    stack.push(i);
    spanIndex[i].region = r;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      size++;
      for (let d = 0; d < 4; d++) {
        const n = links[cur * 4 + d];
        if (n < 0 || spanIndex[n].region >= 0) continue;
        spanIndex[n].region = r;
        stack.push(n);
      }
    }
    regionSize.push(size);
  }
  let biggest = 0;
  for (let r = 1; r < regionCount; r++) if (regionSize[r] > regionSize[biggest]) biggest = r;
  // Keep the main region and anything big enough to be a real place (a rooftop,
  // a rampart, the breakwater). 12 cells at 2 m is ~48 m².
  const MIN_REGION = 12;
  let dropped = 0;
  const alive = new Uint8Array(spanCount);
  for (let i = 0; i < spanCount; i++) {
    const r = spanIndex[i].region;
    if (r === biggest || regionSize[r] >= MIN_REGION) alive[i] = 1;
    else dropped++;
  }

  // ---- 4. emit triangles --------------------------------------------------
  // Compact the surviving spans and assign each a pair of triangle slots.
  const triOfSpan = new Int32Array(spanCount).fill(-1);
  let liveSpans = 0;
  for (let i = 0; i < spanCount; i++) {
    if (!alive[i]) continue;
    triOfSpan[i] = liveSpans * 2;
    liveSpans++;
  }

  const triCount = liveSpans * 2;
  const vertices = new Float32Array(liveSpans * 4 * 3);
  const indices = new Uint32Array(triCount * 3);
  const polyFlags = new Uint8Array(triCount).fill(1);
  const polyNeighbours = new Int32Array(triCount * 3).fill(-1);
  const polyCentres = new Float32Array(triCount * 3);

  let v = 0;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const spans = columns[iz * nx + ix];
      for (const s of spans) {
        if (!alive[s.tri]) continue;
        const t = triOfSpan[s.tri];
        const x0 = bounds.minX + ix * cell;
        const x1 = x0 + cell;
        const z0 = bounds.minZ + iz * cell;
        const z1 = z0 + cell;
        // Ring order v0(x0,z0) v1(x0,z1) v2(x1,z1) v3(x1,z0): cross((v1−v0),
        // (v3−v0)) is +Y, so both triangles face up.
        const base = v / 3;
        for (const [px, pz] of [[x0, z0], [x0, z1], [x1, z1], [x1, z0]] as const) {
          vertices[v++] = px;
          vertices[v++] = s.y;
          vertices[v++] = pz;
        }
        indices[t * 3 + 0] = base + 0;
        indices[t * 3 + 1] = base + 1;
        indices[t * 3 + 2] = base + 2;
        indices[(t + 1) * 3 + 0] = base + 0;
        indices[(t + 1) * 3 + 1] = base + 2;
        indices[(t + 1) * 3 + 2] = base + 3;
        // Centroids.
        polyCentres[t * 3 + 0] = x0 + cell / 3;
        polyCentres[t * 3 + 1] = s.y;
        polyCentres[t * 3 + 2] = z0 + (cell * 2) / 3;
        polyCentres[(t + 1) * 3 + 0] = x0 + (cell * 2) / 3;
        polyCentres[(t + 1) * 3 + 1] = s.y;
        polyCentres[(t + 1) * 3 + 2] = z0 + cell / 3;
      }
    }
  }

  // Adjacency, straight off the grid topology. See the header for the mapping;
  // in short, triangle A owns the −X and +Z edges, triangle B owns +X and −Z,
  // and slot 2 of A / slot 0 of B is the shared diagonal.
  for (let i = 0; i < spanCount; i++) {
    if (!alive[i]) continue;
    const a = triOfSpan[i];
    const bIdx = a + 1;
    const west = links[i * 4 + 0];
    const north = links[i * 4 + 1];
    const east = links[i * 4 + 2];
    const south = links[i * 4 + 3];
    polyNeighbours[a * 3 + 0] = west >= 0 && alive[west] ? triOfSpan[west] + 1 : -1;
    polyNeighbours[a * 3 + 1] = north >= 0 && alive[north] ? triOfSpan[north] + 1 : -1;
    polyNeighbours[a * 3 + 2] = bIdx;
    polyNeighbours[bIdx * 3 + 0] = a;
    polyNeighbours[bIdx * 3 + 1] = east >= 0 && alive[east] ? triOfSpan[east] : -1;
    polyNeighbours[bIdx * 3 + 2] = south >= 0 && alive[south] ? triOfSpan[south] : -1;
  }

  return {
    data: { vertices, indices, polyFlags, polyNeighbours, polyCentres, cellSize: cell },
    stats: {
      cells: nx * nz,
      spans: spanCount,
      triangles: triCount,
      regions: regionCount,
      droppedIslands: dropped,
    },
  };
}
