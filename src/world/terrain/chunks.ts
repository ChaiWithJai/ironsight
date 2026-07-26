/**
 * CHUNKED LOD, CRACK-FREE. Owned by TERRAIN.
 *
 * A restricted (2:1 balanced) quadtree over a 6 144 m root, 32×32 cells per
 * node, nine levels — 192 m cells at the horizon down to 0.75 m under the
 * player's feet.
 *
 * THE SEAM PROBLEM, and why it is solved this way.
 * Two neighbouring nodes at different depths share an edge on which the finer
 * side has twice as many vertices. The odd ones out sit at a T-junction; if
 * their height is the terrain's height they are off the coarse edge's straight
 * line and the mesh opens a hairline of background between them. Three fixes
 * exist: skirts (hide it), fan tessellation (remove the vertex), and snapping
 * (put the vertex exactly ON the coarse edge). We snap — the odd boundary
 * vertex takes the mean of its two even neighbours, which is exactly the point
 * the coarse triangle interpolates there — and we snap NORMALS the same way, so
 * shading is continuous across the seam as well as geometry. Fan tessellation
 * is rejected because its four corner cases (two adjacent coarse edges) are
 * where the bugs live.
 *
 * THERE ARE NO SKIRTS, and their removal was a round-2 bug fix, not a cleanup.
 * They were carried as belt-and-braces insurance on flagged edges "where they
 * can never be seen", and that was simply wrong: a skirt is a vertical strip
 * hanging 0.4 m below a node edge, carrying the SURFACE's upward normal, and it
 * sits inside the terrain — so the shadow map has it fully occluded by the
 * ground above it. Wherever the ground fell away behind an edge, the strip
 * poked into view as a hard-silhouetted, ambient-only polygon with no shading
 * gradient across it, sunk partway into the sand, repeating on the cadence of
 * the LOD rings. That is the "twenty flat, unlit, near-black triangles
 * scattered across the sand" the round-1 critique opened with. The snap is
 * EXACT — the fine node's even vertices coincide with the coarse node's
 * vertices and its odd vertices are placed on the straight segment between
 * them — so nothing is being insured against.
 *
 * Because every node's vertices are a subset of the same global lattice and
 * every height comes from `TerrainField.height`, two nodes at the SAME depth
 * share bit-identical vertices with no special case at all.
 *
 * Draws: one merged mesh per depth (≤ 9), not one per node — 300 nodes would be
 * most of the tier's whole draw budget. The split by depth is also what lets the
 * coarse levels opt out of shadow casting, which the look spec asks for: distant
 * terrain carries no resolvable shadow detail, it dissolves into aerial
 * perspective.
 */
import * as THREE from 'three';
import { RenderLayer, SceneGroup, type DynamicHandle, type SceneGraph } from '@/engine/types';
import type { TerrainField } from '@/world/terrain/field';

const ROOT_SIZE = 6144;
const CELLS = 32;
/**
 * Nine subdivisions → 0.375 m cells under the player's feet.
 *
 * Raised from eight in round 2. At 0.75 m the quad grid was directly countable
 * in the foreground of every eye-height frame: an 11° sun rakes the ground at
 * near-grazing incidence, where the ~1 cm of height a flat triangle misses
 * across its span is enough to band the shading and to seed shadow-map acne
 * along every diagonal. Halving the cell puts the residual under the projected
 * pixel at the distances the near field actually occupies. It costs nothing:
 * the triangle count is `MAX_NODES × CELLS² × 2` regardless of depth, so this
 * only changes where the budget is spent.
 */
const MAX_DEPTH = 9;
/** Split when the camera is closer than this many node-widths. ≥2 keeps the
 *  tree nearly balanced on its own; the explicit balance pass catches the rest. */
const SPLIT_K = 1.85;
const MAX_NODES = 260;
/** Depths whose cells are coarser than this cast no shadow. */
const SHADOW_CELL_LIMIT = 7;
/** Rebuild the cut only after the camera has moved this far. */
const RECUT_DISTANCE = 7;

const EDGE_MINUS_X = 1;
const EDGE_PLUS_X = 2;
const EDGE_MINUS_Z = 4;
const EDGE_PLUS_Z = 8;

interface Node {
  depth: number;
  ix: number;
  iz: number;
  x0: number;
  z0: number;
  side: number;
  edges: number;
}

interface NodeMesh {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly color: Uint8Array;
  readonly index: Uint32Array;
  readonly minY: number;
  readonly maxY: number;
}

function keyOf(depth: number, ix: number, iz: number): number {
  // Depths ≤ 9 → indices < 512, so ten bits per axis and a 24-bit key. Ten and
  // not eight: at depth 9 an index reaches 511 and an eight-bit field would
  // alias node (9, 256, 0) onto (10, 0, 0), silently merging two distinct
  // leaves in the balance pass.
  return (depth << 20) | (ix << 10) | iz;
}

export class TerrainChunks {
  private readonly meshes: THREE.Mesh[] = [];
  private readonly handles: DynamicHandle[] = [];
  private readonly cache = new Map<string, NodeMesh>();
  private cut: Node[] = [];
  private lastCutX = Number.POSITIVE_INFINITY;
  private lastCutZ = Number.POSITIVE_INFINITY;
  private triangles = 0;

  constructor(
    private readonly field: TerrainField,
    private readonly scene: SceneGraph,
    private readonly material: THREE.Material,
  ) {
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const geometry = new THREE.BufferGeometry();
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `terrain.lod${depth}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.receiveShadow = true;
      mesh.castShadow = ROOT_SIZE / (1 << depth) / CELLS <= SHADOW_CELL_LIMIT;
      mesh.visible = false;
      this.scene.group(SceneGroup.Terrain).add(mesh);
      // No bounds: the terrain is never culled as a whole, and a per-frame
      // frustum test against a 6 km AABB would only ever answer "visible".
      this.handles.push(this.scene.addDynamic(mesh, RenderLayer.WorldOpaque));
      this.meshes.push(mesh);
    }
  }

  get stats(): Readonly<{ nodes: number; triangles: number; draws: number }> {
    return { nodes: this.cut.length, triangles: this.triangles, draws: this.meshes.filter((m) => m.visible).length };
  }

  /** Called from `RenderStage.Scene`. Cheap unless the camera crossed a chunk. */
  update(camX: number, camZ: number, force = false): void {
    if (!force && Math.hypot(camX - this.lastCutX, camZ - this.lastCutZ) < RECUT_DISTANCE) return;
    this.lastCutX = camX;
    this.lastCutZ = camZ;
    this.cut = this.buildCut(camX, camZ);
    this.rebuildGeometry();
  }

  dispose(): void {
    for (let i = 0; i < this.meshes.length; i++) {
      this.scene.removeDynamic(this.handles[i]);
      this.meshes[i].removeFromParent();
      this.meshes[i].geometry.dispose();
    }
    this.cache.clear();
  }

  /* ------------------------------------------------------------------ cut -- */

  private buildCut(camX: number, camZ: number): Node[] {
    const half = ROOT_SIZE * 0.5;
    let leaves: Node[] = [
      { depth: 0, ix: 0, iz: 0, x0: -half, z0: -half, side: ROOT_SIZE, edges: 0 },
    ];

    // GREEDY, BY NEED — not level by level.
    //
    // Splitting a whole level before descending spends the entire node budget
    // on the horizon and leaves the ground under the player at the resolution of
    // a car park: nine levels of uniform refinement is 4^8 nodes, so the budget
    // runs out at level four every time. Ranking candidates by node width over
    // distance instead means the cell the camera is standing in refines to
    // 0.75 m first and the tree grows outward from there, which is the whole
    // point of a quadtree.
    while (leaves.length + 3 <= MAX_NODES) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < leaves.length; i++) {
        const node = leaves[i];
        if (!this.wantsSplit(node, camX, camZ)) continue;
        const score = node.side / Math.max(1, this.distanceTo(node, camX, camZ));
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best < 0) break;
      const parent = leaves[best];
      leaves[best] = leaves[leaves.length - 1];
      leaves.pop();
      leaves.push(...this.children(parent));
    }

    return this.balance(leaves);
  }

  private children(node: Node): Node[] {
    const s = node.side * 0.5;
    const d = node.depth + 1;
    const out: Node[] = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        out.push({
          depth: d,
          ix: node.ix * 2 + i,
          iz: node.iz * 2 + j,
          x0: node.x0 + i * s,
          z0: node.z0 + j * s,
          side: s,
          edges: 0,
        });
      }
    }
    return out;
  }

  private distanceTo(node: Node, camX: number, camZ: number): number {
    const dx = Math.max(0, Math.abs(camX - (node.x0 + node.side * 0.5)) - node.side * 0.5);
    const dz = Math.max(0, Math.abs(camZ - (node.z0 + node.side * 0.5)) - node.side * 0.5);
    return Math.hypot(dx, dz);
  }

  private wantsSplit(node: Node, camX: number, camZ: number): boolean {
    if (node.depth >= MAX_DEPTH) return false;
    const dist = this.distanceTo(node, camX, camZ);
    if (dist < node.side * SPLIT_K) return true;

    // SHORELINE REFINEMENT. Distance alone leaves the waterline tessellated at
    // whatever the camera range dictates, and a 6 m triangle crossing the sea
    // level is what produces the sawtooth coast. The waterline gets its own
    // budget, out to a range where the residual step is under a pixel.
    if (dist > 620) return false;
    const cell = node.side / CELLS;
    if (cell <= Math.max(0.75, dist / 340)) return false;
    return this.straddlesShore(node);
  }

  /** Does the node's footprint contain the waterline? Five taps, not a scan. */
  private straddlesShore(node: Node): boolean {
    const sea = this.field.seaLevel;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let j = 0; j <= 2; j++) {
      for (let i = 0; i <= 2; i++) {
        const h = this.field.height(node.x0 + (i * node.side) / 2, node.z0 + (j * node.side) / 2);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return min < sea + 2.5 && max > sea - 2.5;
  }

  /**
   * Enforce the 2:1 restriction, then record which edges face a coarser
   * neighbour. Without the restriction a node could face a neighbour two levels
   * up and the single midpoint snap would not reach the coarse edge.
   */
  private balance(leaves: Node[]): Node[] {
    let current = leaves;
    for (let pass = 0; pass < 12; pass++) {
      const map = new Map<number, Node>();
      for (const n of current) map.set(keyOf(n.depth, n.ix, n.iz), n);
      const toSplit = new Set<Node>();
      for (const n of current) {
        for (const dir of DIRECTIONS) {
          const nb = this.neighbourOf(map, n, dir);
          if (nb && nb.depth < n.depth - 1) toSplit.add(nb);
        }
      }
      if (toSplit.size === 0) {
        // Stable: tag the edges and stop.
        for (const n of current) {
          n.edges = 0;
          for (const dir of DIRECTIONS) {
            const nb = this.neighbourOf(map, n, dir);
            if (nb && nb.depth < n.depth) n.edges |= dir.flag;
          }
        }
        return current;
      }
      const next: Node[] = [];
      for (const n of current) {
        if (toSplit.has(n)) next.push(...this.children(n));
        else next.push(n);
      }
      current = next;
    }
    return current;
  }

  /** The leaf containing the point just outside `node`'s edge midpoint. */
  private neighbourOf(map: Map<number, Node>, node: Node, dir: Direction): Node | undefined {
    const px = node.x0 + node.side * (0.5 + dir.x * 0.5) + dir.x * 0.01;
    const pz = node.z0 + node.side * (0.5 + dir.z * 0.5) + dir.z * 0.01;
    const half = ROOT_SIZE * 0.5;
    if (px < -half || pz < -half || px > half || pz > half) return undefined;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const side = ROOT_SIZE / (1 << depth);
      const ix = Math.floor((px + half) / side);
      const iz = Math.floor((pz + half) / side);
      const found = map.get(keyOf(depth, ix, iz));
      if (found) return found;
    }
    return undefined;
  }

  /* ------------------------------------------------------------- geometry -- */

  private rebuildGeometry(): void {
    const byDepth: NodeMesh[][] = [];
    for (let d = 0; d <= MAX_DEPTH; d++) byDepth.push([]);
    for (const node of this.cut) {
      const key = `${node.depth}:${node.ix}:${node.iz}:${node.edges}`;
      let mesh = this.cache.get(key);
      if (!mesh) {
        mesh = this.buildNode(node);
        this.cache.set(key, mesh);
      }
      byDepth[node.depth].push(mesh);
    }
    // Bounded cache: re-entering a region a moment later must be free, but a
    // long traverse must not retain the whole map at LOD0.
    if (this.cache.size > 900) {
      let drop = this.cache.size - 700;
      for (const k of this.cache.keys()) {
        if (drop-- <= 0) break;
        this.cache.delete(k);
      }
    }

    this.triangles = 0;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const parts = byDepth[depth];
      const mesh = this.meshes[depth];
      if (parts.length === 0) {
        mesh.visible = false;
        continue;
      }
      let verts = 0;
      let indices = 0;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const p of parts) {
        verts += p.position.length / 3;
        indices += p.index.length;
        if (p.minY < minY) minY = p.minY;
        if (p.maxY > maxY) maxY = p.maxY;
      }
      const position = new Float32Array(verts * 3);
      const normal = new Float32Array(verts * 3);
      const uv = new Float32Array(verts * 2);
      const color = new Uint8Array(verts * 4);
      const index = new Uint32Array(indices);
      let vo = 0;
      let io = 0;
      for (const p of parts) {
        position.set(p.position, vo * 3);
        normal.set(p.normal, vo * 3);
        uv.set(p.uv, vo * 2);
        color.set(p.color, vo * 4);
        for (let i = 0; i < p.index.length; i++) index[io + i] = p.index[i] + vo;
        vo += p.position.length / 3;
        io += p.index.length;
      }
      this.triangles += indices / 3;

      const geometry = mesh.geometry;
      // Frees the previous upload. Replacing attributes without this leaks a
      // GL buffer per rebuild, and the cut is rebuilt every few metres walked.
      geometry.dispose();
      geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geometry.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
      geometry.setIndex(new THREE.BufferAttribute(index, 1));
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(-ROOT_SIZE / 2, minY - 1, -ROOT_SIZE / 2),
        new THREE.Vector3(ROOT_SIZE / 2, maxY, ROOT_SIZE / 2),
      );
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (minY + maxY) * 0.5, 0), ROOT_SIZE);
      mesh.visible = true;
    }
  }

  private buildNode(node: Node): NodeMesh {
    const n = CELLS + 1;
    const step = node.side / CELLS;
    const vertCount = n * n;
    const heights = new Float32Array(vertCount);
    const nx = new Float32Array(vertCount);
    const ny = new Float32Array(vertCount);
    const nz = new Float32Array(vertCount);
    const grad = { gx: 0, gz: 0 };

    for (let j = 0; j < n; j++) {
      const z = node.z0 + j * step;
      for (let i = 0; i < n; i++) {
        const t = j * n + i;
        const x = node.x0 + i * step;
        heights[t] = this.field.height(x, z);
        // Analytic normals at a FIXED epsilon (the field's own cell), so two
        // nodes at different depths compute the same normal at a shared vertex
        // and the seam carries no lighting discontinuity either.
        this.field.gradient(x, z, grad);
        const len = Math.hypot(grad.gx, 1, grad.gz);
        nx[t] = -grad.gx / len;
        ny[t] = 1 / len;
        nz[t] = -grad.gz / len;
      }
    }

    // THE SNAP. Odd vertices on an edge that faces a coarser neighbour take the
    // mean of their two even neighbours — exactly the point the coarse triangle
    // interpolates there — so the T-junction closes. Corners are even indices,
    // so two adjacent flagged edges never disagree about one vertex.
    const snapEdge = (indexAt: (k: number) => number): void => {
      for (let k = 1; k < CELLS; k += 2) {
        const a = indexAt(k - 1);
        const b = indexAt(k + 1);
        const m = indexAt(k);
        heights[m] = (heights[a] + heights[b]) * 0.5;
        const sx = (nx[a] + nx[b]) * 0.5;
        const sy = (ny[a] + ny[b]) * 0.5;
        const sz = (nz[a] + nz[b]) * 0.5;
        const l = Math.hypot(sx, sy, sz) || 1;
        nx[m] = sx / l;
        ny[m] = sy / l;
        nz[m] = sz / l;
      }
    };
    if (node.edges & EDGE_MINUS_X) snapEdge((k) => k * n);
    if (node.edges & EDGE_PLUS_X) snapEdge((k) => k * n + (n - 1));
    if (node.edges & EDGE_MINUS_Z) snapEdge((k) => k);
    if (node.edges & EDGE_PLUS_Z) snapEdge((k) => (n - 1) * n + k);

    const position = new Float32Array(vertCount * 3);
    const normal = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const color = new Uint8Array(vertCount * 4);

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const t = j * n + i;
        const x = node.x0 + i * step;
        const z = node.z0 + j * step;
        const y = heights[t];
        position[t * 3] = x;
        position[t * 3 + 1] = y;
        position[t * 3 + 2] = z;
        normal[t * 3] = nx[t];
        normal[t * 3 + 1] = ny[t];
        normal[t * 3 + 2] = nz[t];
        uv[t * 2] = x / 8;
        uv[t * 2 + 1] = z / 8;
        // The canonical vertex-colour convention: r wear, g dirt, b baked AO,
        // a variant. Wear rises with slope (scoured rock), dirt with dampness,
        // AO falls in concavities.
        const slope = Math.sqrt(Math.max(0, 1 - ny[t] * ny[t])) / Math.max(ny[t], 0.05);
        color[t * 4] = Math.round(255 * Math.min(1, slope * 0.9));
        color[t * 4 + 1] = Math.round(255 * Math.max(0, 1 - Math.abs(y - this.field.seaLevel) / 6));
        color[t * 4 + 2] = 255;
        color[t * 4 + 3] = 0;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const index = new Uint32Array(CELLS * CELLS * 6);
    let io = 0;
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        // ALTERNATING DIAGONAL, checkerboarded on (i + j).
        //
        // Splitting every quad the same way gives the whole sheet one coherent
        // fold direction, and under an 11° sun that fold is a shading feature:
        // it is the "regular X-lattice of faint dark lines running across the
        // plaza" the round-1 critique measured. Flipping the diagonal on
        // alternate cells turns a comb into a herringbone whose folds cancel
        // over any two adjacent quads, so no direction accumulates. Both
        // windings below are counter-clockwise seen from above, so the flip
        // costs nothing and changes no vertex.
        if (((i + j) & 1) === 0) {
          index[io++] = a;
          index[io++] = c;
          index[io++] = b;
          index[io++] = b;
          index[io++] = c;
          index[io++] = d;
        } else {
          index[io++] = a;
          index[io++] = c;
          index[io++] = d;
          index[io++] = a;
          index[io++] = d;
          index[io++] = b;
        }
      }
    }

    return { position, normal, uv, color, index, minY, maxY };
  }
}

interface Direction {
  readonly x: number;
  readonly z: number;
  readonly flag: number;
}

const DIRECTIONS: readonly Direction[] = [
  { x: -1, z: 0, flag: EDGE_MINUS_X },
  { x: 1, z: 0, flag: EDGE_PLUS_X },
  { x: 0, z: -1, flag: EDGE_MINUS_Z },
  { x: 0, z: 1, flag: EDGE_PLUS_Z },
];
