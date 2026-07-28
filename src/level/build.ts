/**
 * `LevelBuild` — the one object every piece of HARBOUR REACH is authored into.
 *
 * OWNER: LEVEL.
 *
 * It carries the four outputs the rest of the game consumes, and it exists so a
 * landmark author writes ONE call and all four stay in sync:
 *
 *   geometry   → per-material `MeshBuilder`s, merged into ~15 draws
 *   colliders  → `StaticColliderDef[]` for PHYS. A DELIBERATE second
 *                representation: boxes and convex hulls, never `mesh.geometry`.
 *                A trimesh of a whole town is the classic rapier performance
 *                cliff (architecture §11.5).
 *   nav decks  → walkable rectangles at a height, which `navmesh-bake.ts`
 *                voxelises. Terrain is implicit; a deck is anything ELSE you can
 *                stand on — a quay, a roof, a rampart, a stair landing.
 *   cover      → derived from the colliders' silhouettes in `cover-bake.ts`.
 *
 * `solid()` is the workhorse: one call emits the box, its collider, its nav
 * blocker and — if it is the right height — its cover. The reason to route
 * everything through it is that "I added a wall and the bots walk through it" is
 * a silent failure that surfaces three lanes away.
 */
import * as THREE from 'three';
import {
  CollisionGroup,
  SurfaceId,
  type Rng,
  type StaticColliderDef,
} from '@/engine/types';
import { MeshBuilder, Xform } from '@/level/kit/builder';
import { MAT_KEYS, surfaceOf, type MatKey } from '@/level/materials';

/** A walkable horizontal surface that is NOT the terrain. */
export interface NavDeck {
  /** World-space centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw: number;
  /** Slope decks (stairs, ramps) rise from `y` at the −local-Z edge to `y + rise`. */
  readonly rise: number;
}

/** A 2D footprint that blocks walking between `yMin` and `yMax`. */
export interface NavBlocker {
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw: number;
  readonly yMin: number;
  readonly yMax: number;
}

/**
 * A half-open index range in ONE material's stream. A piece of cover spans
 * several of these when it is drawn in several materials.
 */
export interface PieceRange {
  readonly key: MatKey;
  readonly start: number;
  readonly count: number;
}

/**
 * The triangles that draw one collider.
 *
 * `exact` says how much to trust the ranges. `solid()` knows precisely which
 * triangles it just emitted, so its claim is exact and is taken whole. A
 * hand-built emitter — a sandbag emplacement, a jersey barrier, a parapet —
 * pours geometry straight into the shared streams and bolts a collider on at
 * the end, so all that can be said is "somewhere in everything appended since
 * the last collider"; that claim is INEXACT and must be intersected with the
 * collider's own volume before anything is hidden by it.
 */
export interface ColliderPiece {
  readonly exact: boolean;
  readonly ranges: readonly PieceRange[];
}

/** Options for `solid()`. */
export interface SolidOpts {
  /** Skip the collider — pure dressing that the player can walk through. */
  readonly noCollide?: boolean;
  /** Skip the nav blocker (a low kerb, a roof slab you stand ON not against). */
  readonly noBlock?: boolean;
  /** Tag as a software-occlusion occluder. Budget is 48 for the whole frame. */
  readonly occluder?: boolean;
  /** Force the cover classification off (thin trim, cornices, signage). */
  readonly noCover?: boolean;
  /** Which box faces to emit — see `MeshBuilder.box`. */
  readonly faces?: number;
  readonly uvScale?: number;
  /** The ground level this box stands on, for the cover-height test. */
  readonly groundY?: number;
}

export class LevelBuild {
  readonly xf = new Xform();
  readonly builders: Record<MatKey, MeshBuilder>;
  readonly colliders: StaticColliderDef[] = [];
  readonly navDecks: NavDeck[] = [];
  readonly navBlockers: NavBlocker[] = [];
  /** Colliders that are candidate cover, paired with the ground they stand on. */
  readonly coverBoxes: { matrix: THREE.Matrix4; half: THREE.Vector3; groundY: number }[] = [];
  /** Circles VEG must not grow inside. */
  readonly vegExclusions: { x: number; z: number; radius: number }[] = [];
  /**
   * Which builder emitted `colliders[i]`, as a parallel array. Set through
   * `tag` by `harbour-reach.ts` around each landmark call and read by
   * `audit.ts`, whose whole value is naming the lane that owns a defect —
   * "5 floating props" is a shrug, "[freighter] 5 floating props" is a fix.
   */
  readonly colliderTags: string[] = [];
  /**
   * WHICH TRIANGLES ARE `colliders[i]`, as a parallel array. Null for a collider
   * with no geometry of its own (an invisible floor, a ship hull) and for one
   * whose emitter never bracketed itself.
   *
   * This is the missing half of destruction. `colliders[i].destructible` says a
   * wall can be broken; this says WHICH DRAWN TRIANGLES ARE THAT WALL, and
   * without it the collider disappears and the geometry stays standing — which
   * is precisely what every piece of cover in HARBOUR REACH used to do.
   */
  readonly colliderPieces: (ColliderPiece | null)[] = [];
  tag = 'root';

  /** Open pieces, innermost last. Emitters nest (a stall inside a street). */
  private readonly pieceStack: { marks: number[]; firstCollider: number }[] = [];
  /**
   * Index lengths as of the last collider. Everything appended since is the
   * candidate window for the NEXT one — the automatic, inexact attribution that
   * catches every emitter nobody bracketed by hand.
   */
  private readonly sinceCollider: number[];

  constructor(readonly rng: Rng) {
    const b = {} as Record<MatKey, MeshBuilder>;
    for (const k of MAT_KEYS) b[k] = new MeshBuilder(this.xf);
    this.builders = b;
    this.sinceCollider = MAT_KEYS.map(() => 0);
  }

  /** Ranges appended since the previous collider, and re-arm the window. */
  private takeWindow(): PieceRange[] {
    const ranges: PieceRange[] = [];
    for (let i = 0; i < MAT_KEYS.length; i++) {
      const key = MAT_KEYS[i];
      const end = this.builders[key].indexLength;
      if (end > this.sinceCollider[i]) {
        ranges.push({ key, start: this.sinceCollider[i], count: end - this.sinceCollider[i] });
      }
      this.sinceCollider[i] = end;
    }
    return ranges;
  }

  /**
   * Bracket an emitter whose output is ONE PIECE OF COVER, so the triangles it
   * appends can be found again later.
   *
   * Cover in this level is not one box. A sandbag emplacement is forty
   * individually-jittered chamfered bags across three materials, emitted
   * straight into the shared streams, with a single box collider bolted on at
   * the end — so there is no other way to recover "these triangles are that
   * wall" after the fact. Wrap the emitter body and the collider it registers
   * inherits the range.
   *
   * Only the FIRST collider emitted inside the bracket claims it: a piece with
   * two colliders is two halves of one drawing, and letting both claim the whole
   * thing would lift the same triangles into the batch twice.
   *
   * Nesting is safe, and the INNERMOST claim wins — `solid()` brackets itself,
   * so a box emitted inside a hand-bracketed emitter gets its own exact range
   * rather than the whole emitter's.
   */
  beginPiece(): void {
    const marks: number[] = [];
    for (const k of MAT_KEYS) marks.push(this.builders[k].indexLength);
    this.pieceStack.push({ marks, firstCollider: this.colliders.length });
  }

  endPiece(): void {
    const piece = this.pieceStack.pop();
    if (!piece) return;
    if (piece.firstCollider >= this.colliders.length) return;
    // An inner bracket does not steal a range the outer one already claimed.
    if (this.colliderPieces[piece.firstCollider]) return;
    const ranges: PieceRange[] = [];
    for (let i = 0; i < MAT_KEYS.length; i++) {
      const key = MAT_KEYS[i];
      const count = this.builders[key].indexLength - piece.marks[i];
      if (count > 0) ranges.push({ key, start: piece.marks[i], count });
    }
    this.colliderPieces[piece.firstCollider] = ranges.length > 0 ? { exact: true, ranges } : null;
  }

  m(key: MatKey): MeshBuilder {
    return this.builders[key];
  }

  /**
   * The one call that keeps render, physics, nav and cover in agreement.
   * `cx/cy/cz` and the half-extents are in the CURRENT `xf` frame; the collider
   * is baked to world space through the same matrix, so a leaning building's
   * collider leans with it.
   */
  solid(
    key: MatKey,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    opts: SolidOpts = {},
  ): void {
    // Brackets itself: one box is exactly one piece, and this is where the vast
    // majority of the level's destructible cover comes from.
    this.beginPiece();
    this.m(key).boxAt(cx, cy, cz, hx, hy, hz, opts.uvScale ?? 1, opts.faces ?? 0x3f);
    if (opts.noCollide) {
      this.endPiece();
      return;
    }

    const local = _mat.makeTranslation(cx, cy, cz);
    const world = new THREE.Matrix4().multiplyMatrices(this.xf.matrix, local);
    // Half-extents must follow the frame's scale; nothing in this level scales
    // non-uniformly, so extracting the scale magnitude is exact.
    const scale = _scale.setFromMatrixScale(this.xf.matrix);
    const half = new THREE.Vector3(hx * scale.x, hy * scale.y, hz * scale.z);
    this.colliders.push({
      matrix: world,
      shape: { kind: 'box', half },
      surface: surfaceOf(key),
      group: CollisionGroup.StaticGeo,
      occluder: opts.occluder,
    });
    this.colliderTags.push(this.tag);
    this.colliderPieces.push(null);
    // Re-arm the automatic window: this box is accounted for exactly, so the
    // next hand-built collider must not inherit it.
    this.takeWindow();

    const pos = _pos.setFromMatrixPosition(world);
    const yaw = yawOf(world);
    if (!opts.noBlock) {
      this.navBlockers.push({
        x: pos.x,
        z: pos.z,
        halfX: half.x,
        halfZ: half.z,
        yaw,
        yMin: pos.y - half.y,
        yMax: pos.y + half.y,
      });
    }
    if (!opts.noCover) {
      const groundY = opts.groundY ?? pos.y - half.y;
      const top = pos.y + half.y;
      const h = top - groundY;
      // 0.55–2.1 m of exposed height is what a soldier can actually use. Below
      // that it is a kerb; above it is a wall you cannot shoot over, which is
      // concealment and gets scored by the cover baker separately.
      if (h > 0.55 && h < 2.4 && Math.min(half.x, half.z) > 0.14) {
        this.coverBoxes.push({ matrix: world.clone(), half: half.clone(), groundY });
      }
    }
    this.endPiece();
  }

  /** A collider with no geometry — invisible floors under stairs, ship hulls. */
  collider(def: StaticColliderDef): void {
    this.colliders.push(def);
    this.colliderTags.push(this.tag);
    // Inexact by construction: this call has no idea what drew it. The window
    // is intersected with `def.shape` later, so a hull that really has no
    // geometry simply claims nothing.
    this.colliderPieces.push({ exact: false, ranges: this.takeWindow() });
  }

  /** A walkable deck for the navmesh. Purely data; emit its geometry yourself. */
  deck(x: number, y: number, z: number, halfX: number, halfZ: number, yaw = 0, rise = 0): void {
    this.navDecks.push({ x, y, z, halfX, halfZ, yaw, rise });
  }

  blocker(x: number, z: number, halfX: number, halfZ: number, yaw: number, yMin: number, yMax: number): void {
    this.navBlockers.push({ x, z, halfX, halfZ, yaw, yMin, yMax });
  }

  exclude(x: number, z: number, radius: number): void {
    this.vegExclusions.push({ x, z, radius });
  }

  /** World-space point of a local coordinate in the current frame. */
  worldPoint(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, y, z).applyMatrix4(this.xf.matrix);
  }

  get stats(): { triangles: number; vertices: number } {
    let t = 0;
    let v = 0;
    for (const k of MAT_KEYS) {
      t += this.builders[k].triangleCount;
      v += this.builders[k].vertexCount;
    }
    return { triangles: t, vertices: v };
  }
}

const _mat = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** Yaw of a world matrix, for the axis-aligned-ish nav rasteriser. */
export function yawOf(m: THREE.Matrix4): number {
  _q.setFromRotationMatrix(m);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.y;
}

/** Convenience for callers that want a trimesh/convex collider surface tag. */
export function colliderSurface(key: MatKey): SurfaceId {
  return surfaceOf(key);
}
