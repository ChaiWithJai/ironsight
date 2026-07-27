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
  /**
   * `'failed'`, not `'queued'` — a request nobody has submitted is not waiting
   * for anything, and a caller that reads the initial value as "a route is
   * coming" will sit forever waiting for a search that was never started.
   */
  status: PathStatus = 'failed';
  /**
   * Owned by `PathQueue`: true between `submit` and the moment the queue
   * finishes, fails or cancels this request. Callers ask THIS rather than
   * inferring it from `status`, because the status a request happens to be
   * holding is not the same question as whether the queue has it.
   */
  enqueued = false;
  readonly from = new THREE.Vector3();
  readonly to = new THREE.Vector3();
  readonly corners: PathCorner[] = [];
  cornerCount = 0;
  /** Bumped every time the request is reused, so a stale reader can tell. */
  generation = 0;
  /** Set when the goal polygon was unreachable and the path is a best effort. */
  partial = false;

  /**
   * Re-aim this request at a new destination.
   *
   * `cornerCount` is DELIBERATELY LEFT ALONE. The corners belong to the last
   * solve and stay valid until `extract` overwrites them, and this class's
   * whole reason to exist is that "the bot keeps following its previous
   * corridor until the new one lands" (see the file header). Zeroing it here
   * made that sentence false: every re-path blanked the corridor and left the
   * bot with nothing to walk along for the entire time the queue took to reach
   * it. `generation` is what tells a reader the corridor is from the previous
   * destination.
   */
  reset(from: Vec3, to: Vec3): void {
    this.from.copy(from);
    this.to.copy(to);
    this.status = 'queued';
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

/**
 * One reusable A* workspace. `stamp` is a generation counter so a search never
 * has to clear a 6 000-entry array it will touch forty cells of.
 */
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
        if (this.closed[next] === this.generation) continue;
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
        this.heap.push(next, tentative + h * HEURISTIC_WEIGHT);
      }
    }
    return false;
  }

  /** Node expansions spent so far by the search in progress. */
  get expansions(): number {
    return this.expanded;
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
/**
 * How far a goal must move before a re-submit is worth restarting the search
 * for. Below this the corridor already being computed lands within a stride of
 * the new goal and the local steer covers the rest.
 */
const RESUBMIT_EPSILON = 6;

export class PathQueue {
  private readonly search = new NavSearch();
  private readonly pending: PathRequest[] = [];
  private active: PathRequest | null = null;
  private graph: NavGraph | null = null;
  /** Diagnostics for the debug overlay. */
  searchesCompleted = 0;
  nodesLastTick = 0;
  /** Routes asked for, routes that landed on a search already in flight. */
  submits = 0;
  coalesced = 0;
  /** Requests whose start or goal had no polygon under it at all. */
  startFails = 0;
  /** Solves that ran out of graph or of budget and returned a best effort. */
  partialResults = 0;

  setGraph(graph: NavGraph | null): void {
    this.graph = graph;
    this.clear();
    if (graph) this.search.attach(graph);
  }

  /**
   * Queue a route request.
   *
   * RESUBMITTING A REQUEST THAT IS ALREADY BEING SERVED THROWS AWAY THE SEARCH.
   * That is not a theoretical cost. Measured over 30 s with 18 bots before this
   * guard existed: 305 submits, 115 of them landed on the request that was
   * mid-search, and **74.5% of the lane's entire A* budget** — 3.03 M of 4.07 M
   * node expansions — went into work that was discarded and restarted from the
   * back of the queue. Only 92 routes ever completed, so 89% of all bot-ticks
   * held a `queued` path, no corridor, and nothing to walk along. That is the
   * whole of "my teammates aren't moving".
   *
   * So a re-submit for materially the same destination is now a NO-OP: the
   * search already running is the answer to it. Only a goal that has genuinely
   * moved is worth paying for again.
   */
  submit(request: PathRequest, from: Vec3, to: Vec3): void {
    this.submits++;
    if (request.enqueued && request.to.distanceToSquared(to) < RESUBMIT_EPSILON * RESUBMIT_EPSILON) {
      this.coalesced++;
      return;
    }
    request.reset(from, to);
    request.enqueued = true;
    if (this.active === request) this.active = null;
    const at = this.pending.indexOf(request);
    if (at >= 0) this.pending.splice(at, 1);
    this.pending.push(request);
  }

  cancel(request: PathRequest): void {
    const at = this.pending.indexOf(request);
    if (at >= 0) this.pending.splice(at, 1);
    if (this.active === request) this.active = null;
    request.enqueued = false;
  }

  clear(): void {
    for (const r of this.pending) r.enqueued = false;
    if (this.active) this.active.enqueued = false;
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
      for (const r of this.pending) {
        r.status = 'failed';
        r.enqueued = false;
      }
      this.pending.length = 0;
      return;
    }
    let budget = nodeBudget;
    let starts = 0;
    while (budget > 0) {
      if (!this.active) {
        if (this.pending.length === 0 || starts >= maxStarts) return;
        const next = this.pending.shift() as PathRequest;
        const startPoly = nearestPoly(g, next.from);
        const goalPoly = nearestPoly(g, next.to);
        if (startPoly < 0 || goalPoly < 0) {
          next.status = 'failed';
          next.enqueued = false;
          this.startFails++;
          continue;
        }
        this.search.begin(g, startPoly, goalPoly, next.to);
        next.status = 'running';
        this.active = next;
        starts++;
      }
      const slice = Math.min(budget, 512);
      const before = this.search.expansions;
      const done = this.search.step(slice);
      // Charge what was actually EXPANDED, not what was offered. A search that
      // finishes three nodes into a 512-node slice used to be billed the whole
      // slice, which silently threw away most of a tick's budget whenever the
      // queue was short — the opposite of the behaviour the budget exists for.
      const spent = Math.max(1, this.search.expansions - before);
      budget -= spent;
      this.nodesLastTick += spent;
      if (done) {
        const request = this.active;
        request.cornerCount = this.search.extract(request.from, request.to, request.corners, maxCorners);
        request.partial = !this.search.reachedGoal;
        request.status = request.cornerCount > 0 ? 'ready' : 'failed';
        request.enqueued = false;
        if (request.partial) this.partialResults++;
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

