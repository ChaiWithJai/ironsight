/**
 * A* over the polygon graph, funnel string-pull, and the time-sliced request
 * queue that keeps both off the frame budget.
 *
 * OWNER: AI.
 *
 * A path is never computed in the middle of a bot's think: `PathQueue.request`
 * returns a handle, the queue expands a bounded number of nodes per tick, and
 * the bot keeps following its previous corridor until the new one lands. That
 * is the whole reason bots can re-path on contact without a hitch — an
 * unbudgeted A* across a 500 × 380 m field is a 3 ms spike, which at 24 bots
 * re-pathing on the same tick is the frame.
 *
 * The string-pull is Mikko Mononen's "simple stupid funnel", run in the XZ
 * plane with Z playing the part of Y. Without it a path is a staircase of
 * polygon centres and every bot walks like it is on a chess board.
 */
import * as THREE from 'three';
import type { Vec3 } from '@/engine/types';
import { NavFlag, NavLink, type NavGraph } from '@/ai/navgraph';

export interface PathCorner {
  readonly position: Vec3;
  /** How the bot leaves this corner: walk, vault or drop. */
  readonly link: NavLink;
}

export type PathStatus = 'queued' | 'running' | 'ready' | 'failed';

export class PathRequest {
  status: PathStatus = 'queued';
  readonly from = new THREE.Vector3();
  readonly to = new THREE.Vector3();
  readonly corners: PathCorner[] = [];
  cornerCount = 0;
  /** Bumped every time the request is reused, so a stale reader can tell. */
  generation = 0;
  /** Set when the goal polygon was unreachable and the path is a best effort. */
  partial = false;

  reset(from: Vec3, to: Vec3): void {
    this.from.copy(from);
    this.to.copy(to);
    this.status = 'queued';
    this.cornerCount = 0;
    this.partial = false;
    this.generation++;
  }
}

/** Binary min-heap over (poly, f). Flat arrays: no allocation during a search. */
class Heap {
  private poly = new Int32Array(1024);
  private cost = new Float32Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  private grow(): void {
    const poly = new Int32Array(this.poly.length * 2);
    const cost = new Float32Array(this.cost.length * 2);
    poly.set(this.poly);
    cost.set(this.cost);
    this.poly = poly;
    this.cost = cost;
  }

  push(p: number, f: number): void {
    if (this.size === this.poly.length) this.grow();
    let i = this.size++;
    this.poly[i] = p;
    this.cost[i] = f;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.poly[0];
    this.size--;
    if (this.size > 0) {
      this.poly[0] = this.poly[this.size];
      this.cost[0] = this.cost[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.cost[l] < this.cost[m]) m = l;
        if (r < this.size && this.cost[r] < this.cost[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const p = this.poly[a];
    const c = this.cost[a];
    this.poly[a] = this.poly[b];
    this.cost[a] = this.cost[b];
    this.poly[b] = p;
    this.cost[b] = c;
  }
}

/** 2D cross product in the XZ plane, Z standing in for Y. */
function triarea2(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
}

/**
 * One reusable A* workspace. `stamp` is a generation counter so a search never
 * has to clear a 6 000-entry array it will touch forty cells of.
 */
/**
 * How much the heuristic outweighs the cost so far. 1.0 is textbook A* and is
 * the wrong trade for a game navmesh: a 51 k-triangle town has thousands of
 * routes within a few metres of optimal, and plain A* expands most of them
 * before committing. Measured on HARBOUR REACH, 1.0 cost a median 5 632 node
 * expansions per 115 m route; at 1.6 the same routes cost hundreds. The path
 * may be up to 60% longer in the worst case and in practice is visually
 * identical, because the string-pull straightens it afterwards anyway.
 */
const HEURISTIC_WEIGHT = 1.6;

/**
 * Hard ceiling on one search, in node expansions.
 *
 * A goal on an unreachable island has no answer, and A* discovers that by
 * expanding the ENTIRE connected component — 58 624 nodes in the run this was
 * measured on, i.e. one such request eats twenty-five ticks of the whole
 * lane's path budget and returns nothing. Past this cap the search stops and
 * hands back the best-so-far corridor, which is a partial path toward the goal
 * and is what the bot wanted anyway.
 */
const MAX_NODES_PER_SEARCH = 9000;

export class NavSearch {
  private g = new Float32Array(0);
  private cameFrom = new Int32Array(0);
  private cameEdge = new Int32Array(0);
  private stamp = new Int32Array(0);
  /**
   * Generation stamp for CLOSED, separate from the open stamp above.
   *
   * Without it a polygon that has already been expanded is expanded again
   * every time a cheaper route into it is found, and on a mesh this dense that
   * is most of them. It is the difference between "A* with a decent heuristic"
   * and "A* that re-walks the town".
   */
  private closed = new Int32Array(0);
  private generation = 0;
  private readonly heap = new Heap();
  private graph: NavGraph | null = null;

  private startPoly = -1;
  private goalPoly = -1;
  private goalX = 0;
  private goalY = 0;
  private goalZ = 0;
  /** Best node seen so far by heuristic, so a blocked goal still yields a useful path. */
  private bestPoly = -1;
  private bestH = Infinity;
  /** Expansions spent by THIS search, against `MAX_NODES_PER_SEARCH`. */
  private expanded = 0;
  running = false;

  attach(graph: NavGraph): void {
    if (this.graph === graph && this.g.length === graph.polyCount) return;
    this.graph = graph;
    this.g = new Float32Array(graph.polyCount);
    this.cameFrom = new Int32Array(graph.polyCount);
    this.cameEdge = new Int32Array(graph.polyCount);
    this.stamp = new Int32Array(graph.polyCount);
    this.closed = new Int32Array(graph.polyCount);
    this.generation = 0;
  }

  begin(graph: NavGraph, startPoly: number, goalPoly: number, goal: Vec3): void {
    this.attach(graph);
    this.generation++;
    this.heap.clear();
    this.startPoly = startPoly;
    this.goalPoly = goalPoly;
    this.goalX = goal.x;
    this.goalY = goal.y;
    this.goalZ = goal.z;
    this.stamp[startPoly] = this.generation;
    this.g[startPoly] = 0;
    this.cameFrom[startPoly] = -1;
    this.cameEdge[startPoly] = -1;
    this.bestPoly = startPoly;
    this.bestH = this.heuristic(startPoly);
    this.expanded = 0;
    this.heap.push(startPoly, this.bestH);
    this.running = true;
  }

  private heuristic(poly: number): number {
    const g = this.graph as NavGraph;
    const dx = g.centres[poly * 3] - this.goalX;
    const dy = g.centres[poly * 3 + 1] - this.goalY;
    const dz = g.centres[poly * 3 + 2] - this.goalZ;
    // Vertical distance is weighted up: a route that gains and loses 8 m of
    // stairs is not equivalent to one 8 m longer on the flat.
    return Math.hypot(dx, dz) + Math.abs(dy) * 1.5;
  }

  /** Expand at most `budget` nodes. Returns true when the search has finished. */
  step(budget: number): boolean {
    const g = this.graph;
    if (!g || !this.running) return true;
    for (let n = 0; n < budget; n++) {
      if (this.heap.size === 0 || this.expanded >= MAX_NODES_PER_SEARCH) {
        this.running = false;
        return true;
      }
      const current = this.heap.pop();
      // Already expanded through a cheaper route; the heap holds stale copies
      // by design and skipping them here is what makes the closed set free.
      if (this.closed[current] === this.generation) continue;
      this.closed[current] = this.generation;
      this.expanded++;
      if (current === this.goalPoly) {
        this.bestPoly = current;
        this.running = false;
        return true;
      }
      const gc = this.g[current];
      const cx = g.centres[current * 3];
      const cy = g.centres[current * 3 + 1];
      const cz = g.centres[current * 3 + 2];
      const end = g.adjStart[current + 1];
      for (let e = g.adjStart[current]; e < end; e++) {
        const next = g.adjPoly[e];
        if ((g.flags[next] & NavFlag.Blocked) !== 0) continue;
        const dx = g.centres[next * 3] - cx;
        const dy = g.centres[next * 3 + 1] - cy;
        const dz = g.centres[next * 3 + 2] - cz;
        const tentative = gc + Math.hypot(dx, dz) + Math.abs(dy) + g.adjPenalty[e];
        if (this.stamp[next] === this.generation && this.g[next] <= tentative) continue;
        this.stamp[next] = this.generation;
        this.g[next] = tentative;
        this.cameFrom[next] = current;
        this.cameEdge[next] = e;
        const h = this.heuristic(next);
        if (h < this.bestH) {
          this.bestH = h;
          this.bestPoly = next;
        }
        this.heap.push(next, tentative + h);
      }
    }
    return false;
  }

  /** True when the search reached the requested polygon rather than a fallback. */
  get reachedGoal(): boolean {
    return this.bestPoly === this.goalPoly;
  }

  /**
   * Walk the parent chain back from the best node and string-pull it. Returns
   * the number of corners written into `out`.
   */
  extract(from: Vec3, to: Vec3, out: PathCorner[], maxCorners: number): number {
    const g = this.graph;
    if (!g) return 0;
    const chain: number[] = [];
    const edges: number[] = [];
    let node = this.bestPoly;
    let guard = 0;
    while (node >= 0 && guard++ < 4096) {
      chain.push(node);
      const e = this.cameEdge[node];
      edges.push(e);
      if (node === this.startPoly) break;
      node = this.cameFrom[node];
    }
    chain.reverse();
    edges.reverse();

    const endPoint = NAV_TMP_END;
    if (this.reachedGoal) endPoint.copy(to);
    else g.centre(this.bestPoly, endPoint);

    return funnel(g, chain, edges, from, endPoint, out, maxCorners);
  }
}

const NAV_TMP_END = new THREE.Vector3();
const PORTAL_LEFT = new THREE.Vector3();
const PORTAL_RIGHT = new THREE.Vector3();

/**
 * Simple stupid funnel over the corridor's portals. `chain[0]` is the start
 * polygon; `edges[i]` is the adjacency index used to ENTER `chain[i]`, so its
 * portal is the doorway between `chain[i-1]` and `chain[i]`.
 */
function funnel(
  g: NavGraph,
  chain: readonly number[],
  edges: readonly number[],
  start: Vec3,
  end: Vec3,
  out: PathCorner[],
  maxCorners: number,
): number {
  const count = chain.length;
  // Portal list: [start, start], every doorway, [end, end].
  const lx = new Float64Array(count + 1);
  const lz = new Float64Array(count + 1);
  const ly = new Float64Array(count + 1);
  const rx = new Float64Array(count + 1);
  const rz = new Float64Array(count + 1);
  const ry = new Float64Array(count + 1);
  const kind = new Uint8Array(count + 1);
  let np = 0;
  lx[np] = rx[np] = start.x;
  ly[np] = ry[np] = start.y;
  lz[np] = rz[np] = start.z;
  kind[np] = NavLink.Walk;
  np++;

  for (let i = 1; i < count; i++) {
    const e = edges[i];
    if (e < 0) continue;
    const o = e * 6;
    const prev = chain[i - 1];
    const cur = chain[i];
    const ax = g.centres[prev * 3];
    const az = g.centres[prev * 3 + 2];
    const bx = g.centres[cur * 3];
    const bz = g.centres[cur * 3 + 2];
    const p0x = g.adjPortal[o];
    const p0y = g.adjPortal[o + 1];
    const p0z = g.adjPortal[o + 2];
    const p1x = g.adjPortal[o + 3];
    const p1y = g.adjPortal[o + 4];
    const p1z = g.adjPortal[o + 5];
    // Which endpoint is "left" in the XZ convention triarea2 uses.
    const leftIsZero = triarea2(ax, az, bx, bz, p0x, p0z) > 0;
    lx[np] = leftIsZero ? p0x : p1x;
    ly[np] = leftIsZero ? p0y : p1y;
    lz[np] = leftIsZero ? p0z : p1z;
    rx[np] = leftIsZero ? p1x : p0x;
    ry[np] = leftIsZero ? p1y : p0y;
    rz[np] = leftIsZero ? p1z : p0z;
    kind[np] = g.adjKind[e];
    np++;
  }
  lx[np] = rx[np] = end.x;
  ly[np] = ry[np] = end.y;
  lz[np] = rz[np] = end.z;
  kind[np] = NavLink.Walk;
  np++;

  let written = 0;
  const push = (x: number, y: number, z: number, link: NavLink): void => {
    if (written >= maxCorners) return;
    let corner = out[written];
    if (!corner) {
      corner = { position: new THREE.Vector3(), link };
      out[written] = corner;
    }
    corner.position.set(x, y, z);
    (corner as { link: NavLink }).link = link;
    written++;
  };

  let apexX = lx[0];
  let apexY = ly[0];
  let apexZ = lz[0];
  let portalLeftX = lx[0];
  let portalLeftZ = lz[0];
  let portalRightX = rx[0];
  let portalRightZ = rz[0];
  let apexIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;

  for (let i = 1; i < np; i++) {
    const nlx = lx[i];
    const nlz = lz[i];
    const nrx = rx[i];
    const nrz = rz[i];

    // Tighten the funnel on the right.
    if (triarea2(apexX, apexZ, portalRightX, portalRightZ, nrx, nrz) <= 0) {
      if (
        (apexX === portalRightX && apexZ === portalRightZ) ||
        triarea2(apexX, apexZ, portalLeftX, portalLeftZ, nrx, nrz) > 0
      ) {
        portalRightX = nrx;
        portalRightZ = nrz;
        rightIndex = i;
      } else {
        // Right crossed left: the left endpoint is a corner.
        push(portalLeftX, ly[leftIndex], portalLeftZ, kind[leftIndex]);
        apexX = portalLeftX;
        apexY = ly[leftIndex];
        apexZ = portalLeftZ;
        apexIndex = leftIndex;
        portalLeftX = apexX;
        portalLeftZ = apexZ;
        portalRightX = apexX;
        portalRightZ = apexZ;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
    // Tighten on the left.
    if (triarea2(apexX, apexZ, portalLeftX, portalLeftZ, nlx, nlz) >= 0) {
      if (
        (apexX === portalLeftX && apexZ === portalLeftZ) ||
        triarea2(apexX, apexZ, portalRightX, portalRightZ, nlx, nlz) < 0
      ) {
        portalLeftX = nlx;
        portalLeftZ = nlz;
        leftIndex = i;
      } else {
        push(portalRightX, ry[rightIndex], portalRightZ, kind[rightIndex]);
        apexX = portalRightX;
        apexY = ry[rightIndex];
        apexZ = portalRightZ;
        apexIndex = rightIndex;
        portalLeftX = apexX;
        portalLeftZ = apexZ;
        portalRightX = apexX;
        portalRightZ = apexZ;
        leftIndex = apexIndex;
        rightIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
  }
  void apexY;
  push(end.x, end.y, end.z, NavLink.Walk);
  return written;
}

/**
 * The per-frame budget keeper. One search runs at a time and owns the shared
 * workspace; requests are served oldest-first so a bot cannot starve behind a
 * neighbour that re-paths every tick.
 */
export class PathQueue {
  private readonly search = new NavSearch();
  private readonly pending: PathRequest[] = [];
  private active: PathRequest | null = null;
  private graph: NavGraph | null = null;
  /** Diagnostics for the debug overlay. */
  searchesCompleted = 0;
  nodesLastTick = 0;
  submits = 0;
  startFails = 0;
  readyResults = 0;
  failedResults = 0;
  partialResults = 0;
  droppedNoGraph = 0;
  nodesThisSearch = 0;
  readonly searchNodes: number[] = [];
  readonly searchReached: number[] = [];
  readonly searchLen: number[] = [];
  nodesTotal = 0;
  cancelledActive = 0;
  wastedNodes = 0;
  ticksIdle = 0;
  ticksStarved = 0;
  stepCalls = 0;

  setGraph(graph: NavGraph | null): void {
    this.graph = graph;
    this.pending.length = 0;
    this.active = null;
    if (graph) this.search.attach(graph);
  }

  submit(request: PathRequest, from: Vec3, to: Vec3): void {
    this.submits++;
    if (this.active === request) {
      this.cancelledActive++;
      this.wastedNodes += this.nodesThisSearch;
    }
    request.reset(from, to);
    if (this.active === request) this.active = null;
    const at = this.pending.indexOf(request);
    if (at >= 0) this.pending.splice(at, 1);
    this.pending.push(request);
  }

  cancel(request: PathRequest): void {
    const at = this.pending.indexOf(request);
    if (at >= 0) this.pending.splice(at, 1);
    if (this.active === request) this.active = null;
  }

  clear(): void {
    this.pending.length = 0;
    this.active = null;
  }

  get queued(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  /**
   * Advance the queue. `nodeBudget` is the TOTAL A* expansions allowed this
   * tick across every request, and `maxStarts` caps how many fresh searches may
   * begin — starting is the expensive part when a whole squad re-paths at once.
   */
  step(nodeBudget: number, maxStarts: number, maxCorners: number): void {
    const g = this.graph;
    this.nodesLastTick = 0;
    if (!g) {
      for (const r of this.pending) r.status = 'failed';
      this.droppedNoGraph += this.pending.length;
      this.pending.length = 0;
      return;
    }
    this.stepCalls++;
    if (!this.active && this.pending.length === 0) this.ticksIdle++;
    let budget = nodeBudget;
    let starts = 0;
    while (budget > 0) {
      if (!this.active) {
        if (starts >= maxStarts && this.pending.length > 0) this.ticksStarved++;
        if (this.pending.length === 0 || starts >= maxStarts) return;
        const next = this.pending.shift() as PathRequest;
        const startPoly = nearestPoly(g, next.from);
        const goalPoly = nearestPoly(g, next.to);
        if (startPoly < 0 || goalPoly < 0) {
          next.status = 'failed';
          this.startFails++;
          continue;
        }
        this.search.begin(g, startPoly, goalPoly, next.to);
        this.nodesThisSearch = 0;
        next.status = 'running';
        this.active = next;
        starts++;
      }
      const slice = Math.min(budget, 512);
      const done = this.search.step(slice);
      budget -= slice;
      this.nodesLastTick += slice;
      this.nodesThisSearch += slice;
      this.nodesTotal += slice;
      if (done) {
        const request = this.active;
        request.cornerCount = this.search.extract(request.from, request.to, request.corners, maxCorners);
        request.partial = !this.search.reachedGoal;
        request.status = request.cornerCount > 0 ? 'ready' : 'failed';
        if (request.status === 'ready') this.readyResults++;
        else this.failedResults++;
        if (request.partial) this.partialResults++;
        if (this.searchNodes.length < 400) {
          this.searchNodes.push(this.nodesThisSearch);
          this.searchReached.push(this.search.reachedGoal ? 1 : 0);
          this.searchLen.push(Math.round(request.from.distanceTo(request.to)));
        }
        this.searchesCompleted++;
        this.active = null;
      }
    }
  }

  /**
   * Synchronous, node-capped search for the short queries on `NavService`.
   * Bots do NOT use this — they submit and wait — but a one-off "can I get
   * there" question from another lane must still answer this frame.
   */
  solveNow(from: Vec3, to: Vec3, out: PathCorner[], maxCorners: number, nodeCap = 3000): number {
    const g = this.graph;
    if (!g) return 0;
    const startPoly = nearestPoly(g, from);
    const goalPoly = nearestPoly(g, to);
    if (startPoly < 0 || goalPoly < 0) return 0;
    const search = new NavSearch();
    search.begin(g, startPoly, goalPoly, to);
    let spent = 0;
    while (spent < nodeCap && !search.step(256)) spent += 256;
    return search.extract(from, to, out, maxCorners);
  }
}

const NEAREST_TMP = new THREE.Vector3();

export function nearestPoly(g: NavGraph, point: Vec3): number {
  const direct = g.polyAt(point.x, point.z);
  if (direct >= 0) return direct;
  if (!g.sample(point, 6, NEAREST_TMP)) return -1;
  return g.polyAt(NEAREST_TMP.x, NEAREST_TMP.z);
}

