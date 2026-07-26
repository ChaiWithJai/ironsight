/**
 * COVER SLOT EXTRACTION.
 *
 * OWNER: LEVEL. Half of bake step 12.
 *
 * A cover slot is a place a soldier can STAND, KNEEL or LIE and be shielded from
 * one direction. Bots ask for them constantly, so the representation is a flat
 * array plus a uniform grid, and a query is a few dozen distance tests.
 *
 * The extraction rule is deliberately simple and deliberately conservative:
 *
 *   for every candidate box, for each of its four vertical faces, the space
 *   immediately BEHIND that face is cover against threats coming from IN FRONT
 *   of it, at a stance decided by how much of the box stands proud of the
 *   ground it sits on.
 *
 * The stance bands come from the character controller's eye heights, not from
 * taste:
 *
 *   0.55–0.95 m  PRONE      — you must lie down; nothing else fits
 *   0.95–1.45 m  CROUCH     — kneel behind it, stand up to shoot over
 *   1.45–2.40 m  STAND      — full standing cover, lean or step out to shoot
 *
 * Above 2.4 m it is a wall, not cover: you cannot shoot over it, so it is
 * concealment and the bots should be pathing around it rather than hugging it.
 * Those boxes never become slots.
 *
 * QUALITY is the number the bots actually sort on, and it is the product of four
 * independent factors rather than a hand-tuned score:
 *
 *   width    — a 0.4 m post is worse cover than a 4 m barrier
 *   fit      — how well the height sits in the middle of its stance band
 *   flanking — a slot with open ground on both sides is easy to flank
 *   solidity — sandbags and concrete beat crates and market stalls
 *
 * The single most common way this bake goes wrong is emitting slots INSIDE
 * geometry — behind the face of a box that is itself buried in a building. The
 * guard is `occupied()`: a slot whose standing position is inside any OTHER
 * candidate box is dropped, which costs one grid lookup per slot and removes
 * essentially all of them.
 */
import * as THREE from 'three';
import { NULL_ENTITY, type CoverSlot, type Rng, type Vec3 } from '@/engine/types';

/** What `LevelBuild` hands over: an oriented box and the ground under it. */
export interface CoverCandidate {
  readonly matrix: THREE.Matrix4;
  readonly half: THREE.Vector3;
  readonly groundY: number;
}

export interface CoverBakeOpts {
  /** Slots per metre along a face. 0.5 = one every 2 m. */
  readonly density?: number;
  /** Hard ceiling; the densest faces are thinned first. */
  readonly maxSlots?: number;
}

const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _axisX = new THREE.Vector3();
const _axisZ = new THREE.Vector3();
const _p = new THREE.Vector3();
const _local = new THREE.Vector3();

interface Box {
  readonly centre: THREE.Vector3;
  readonly axisX: THREE.Vector3;
  readonly axisZ: THREE.Vector3;
  readonly half: THREE.Vector3;
  readonly groundY: number;
  readonly exposed: number;
}

/**
 * Solidity by exposed height and footprint. There is no surface tag on a cover
 * candidate — `LevelBuild` does not carry one through — so this is a proxy, and
 * it is a good one: the thin, light, shootable-through things in this level
 * (crates, stalls, tyres) are all small, and the things that stop a round
 * (sandbag walls, jersey barriers, masonry) are all long or deep.
 */
function solidity(half: THREE.Vector3): number {
  const span = Math.max(half.x, half.z) * 2;
  const depth = Math.min(half.x, half.z) * 2;
  return Math.min(1, 0.28 + span * 0.11 + depth * 0.26);
}

function stanceFor(exposed: number): CoverSlot['stance'] | null {
  if (exposed < 0.55) return null;
  if (exposed < 0.95) return 'prone';
  if (exposed < 1.45) return 'crouch';
  if (exposed <= 2.4) return 'stand';
  return null;
}

/** 1 at the centre of the stance band, falling to ~0.45 at its edges. */
function fitScore(exposed: number, stance: CoverSlot['stance']): number {
  const [lo, hi] = stance === 'prone' ? [0.55, 0.95] : stance === 'crouch' ? [0.95, 1.45] : [1.45, 2.4];
  const t = (exposed - lo) / (hi - lo);
  return 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
}

/**
 * Bake `candidates` into cover slots.
 *
 * `rng` is used only to break ties when thinning to `maxSlots`, and it is drawn
 * from the level's own fixed stream — cover has to be identical across a reset
 * or the bots pick different positions in a captured frame.
 */
export function bakeCoverSlots(
  candidates: readonly CoverCandidate[],
  rng: Rng,
  opts: CoverBakeOpts = {},
): CoverSlot[] {
  const density = opts.density ?? 0.5;
  const maxSlots = opts.maxSlots ?? 3200;

  // ---- 1. normalise the candidates into oriented boxes -------------------
  const boxes: Box[] = [];
  for (const c of candidates) {
    c.matrix.decompose(_pos, _quat, _scale);
    const centre = _pos.clone();
    const axisX = _axisX.set(1, 0, 0).applyQuaternion(_quat).setY(0);
    const axisZ = _axisZ.set(0, 0, 1).applyQuaternion(_quat).setY(0);
    if (axisX.lengthSq() < 1e-6 || axisZ.lengthSq() < 1e-6) continue;
    axisX.normalize();
    axisZ.normalize();
    const half = new THREE.Vector3(
      Math.abs(c.half.x * _scale.x),
      Math.abs(c.half.y * _scale.y),
      Math.abs(c.half.z * _scale.z),
    );
    const exposed = centre.y + half.y - c.groundY;
    boxes.push({
      centre,
      axisX: axisX.clone(),
      axisZ: axisZ.clone(),
      half,
      groundY: c.groundY,
      exposed,
    });
  }

  // ---- 2. a coarse grid over the boxes, for the occupancy test -----------
  const CELL = 8;
  const buckets = new Map<number, number[]>();
  const keyOf = (x: number, z: number): number =>
    (Math.floor(x / CELL) & 0xffff) * 65536 + (Math.floor(z / CELL) & 0xffff);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const r = Math.hypot(b.half.x, b.half.z);
    for (let x = b.centre.x - r; x <= b.centre.x + r + CELL; x += CELL) {
      for (let z = b.centre.z - r; z <= b.centre.z + r + CELL; z += CELL) {
        const k = keyOf(x, z);
        let list = buckets.get(k);
        if (!list) buckets.set(k, (list = []));
        if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }

  /**
   * Is `p` inside any candidate box other than `skip`?
   *
   * Done by projecting onto the box's own horizontal axes rather than by
   * inverting its matrix: the axes are already unit-length and the half-extents
   * are already in world metres, so there is no scale to undo and no chance of
   * the classic bug where a scaled frame is tested against unscaled extents.
   */
  const occupied = (p: THREE.Vector3, skip: number): boolean => {
    const list = buckets.get(keyOf(p.x, p.z));
    if (!list) return false;
    for (const i of list) {
      const b = boxes[i];
      if (i === skip) continue;
      if (p.y < b.centre.y - b.half.y - 0.1 || p.y > b.centre.y + b.half.y) continue;
      _local.subVectors(p, b.centre);
      if (Math.abs(_local.dot(b.axisX)) > b.half.x) continue;
      if (Math.abs(_local.dot(b.axisZ)) > b.half.z) continue;
      return true;
    }
    return false;
  };

  // ---- 3. emit slots along each face -------------------------------------
  const out: { slot: CoverSlot; score: number }[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const stance = stanceFor(b.exposed);
    if (!stance) continue;
    const solid = solidity(b.half);
    const fit = fitScore(b.exposed, stance);
    // Standing offset from the face: far enough back that the soldier's own
    // capsule is not intersecting the cover, close enough to be behind it.
    const standOff = 0.62;
    // Feet-to-eye offset used for the slot's Y. Bots place a capsule centre
    // here, so it is hip height for the stance rather than eye height.
    const bodyY = stance === 'prone' ? 0.35 : stance === 'crouch' ? 0.72 : 0.95;

    for (let face = 0; face < 4; face++) {
      // face 0 = +Z, 1 = +X, 2 = −Z, 3 = −X, in the box's own frame.
      const along = face % 2 === 0 ? b.axisX : b.axisZ;
      const alongHalf = face % 2 === 0 ? b.half.x : b.half.z;
      const outHalf = face % 2 === 0 ? b.half.z : b.half.x;
      const sign = face < 2 ? 1 : -1;
      const normal = (face % 2 === 0 ? b.axisZ : b.axisX).clone().multiplyScalar(sign);

      const span = alongHalf * 2;
      // A face narrower than a body is not a face you can hide behind.
      if (span < 0.5) continue;
      const n = Math.max(1, Math.round(span * density));
      const widthScore = Math.min(1, 0.35 + span * 0.16);

      for (let k = 0; k < n; k++) {
        const t = n === 1 ? 0 : ((k + 0.5) / n - 0.5) * span;
        _p.copy(b.centre)
          .addScaledVector(along, t)
          .addScaledVector(normal, -(outHalf + standOff));
        _p.y = b.groundY + bodyY;
        if (occupied(_p, i)) continue;

        // Flanking penalty: a slot near the end of a short face is trivially
        // rounded, so it scores lower than one in the middle of a long one.
        const edgeDist = alongHalf - Math.abs(t);
        const flank = Math.min(1, 0.4 + edgeDist * 0.55);
        const quality = Math.min(1, widthScore * fit * flank * solid * 1.35);
        if (quality < 0.16) continue;

        out.push({
          score: quality,
          slot: {
            position: _p.clone() as unknown as Vec3,
            // `facing` is the direction the cover protects AGAINST — i.e. out
            // through the face, toward where the shooter must be.
            facing: normal.clone() as unknown as Vec3,
            stance,
            quality,
            owner: NULL_ENTITY,
          },
        });
      }
    }
  }

  // ---- 4. thin to budget, best first, with a deterministic tiebreak ------
  if (out.length > maxSlots) {
    for (const o of out) o.score += rng.range(-1e-4, 1e-4);
    out.sort((a, c) => c.score - a.score);
    out.length = maxSlots;
  }
  return out.map((o) => o.slot);
}

/**
 * Uniform-grid index over the baked slots. `LevelService.findCover` is called
 * once per bot per second or so with up to `maxBots` bots, and a linear scan of
 * 3 000 slots at that rate is a measurable slice of the AI budget for no reason.
 */
export class CoverIndex {
  private readonly cell = 12;
  private readonly buckets = new Map<number, number[]>();

  constructor(private readonly slots: readonly CoverSlot[]) {
    for (let i = 0; i < slots.length; i++) {
      const p = slots[i].position;
      const k = this.key(p.x, p.z);
      let list = this.buckets.get(k);
      if (!list) this.buckets.set(k, (list = []));
      list.push(i);
    }
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / this.cell) & 0xffff) * 65536 + (Math.floor(z / this.cell) & 0xffff);
  }

  /**
   * Best slot within `maxRange` of `position` that faces `threat`.
   *
   * The dot product is the whole selection: a slot only counts if the threat is
   * on the side the cover protects against. A slot that scores well but faces
   * the wrong way is the classic bug that makes bots stand in the open next to
   * a perfectly good wall.
   */
  find(position: Vec3, threat: Vec3, maxRange: number): CoverSlot | null {
    const tx = threat.x - position.x;
    const tz = threat.z - position.z;
    const tLen = Math.hypot(tx, tz);
    if (tLen < 1e-4) return null;
    const dirX = tx / tLen;
    const dirZ = tz / tLen;

    let best: CoverSlot | null = null;
    let bestScore = -Infinity;
    const r = Math.ceil(maxRange / this.cell);
    const cx = Math.floor(position.x / this.cell);
    const cz = Math.floor(position.z / this.cell);
    const max2 = maxRange * maxRange;
    for (let gx = cx - r; gx <= cx + r; gx++) {
      for (let gz = cz - r; gz <= cz + r; gz++) {
        const list = this.buckets.get((gx & 0xffff) * 65536 + (gz & 0xffff));
        if (!list) continue;
        for (const i of list) {
          const s = this.slots[i];
          const dx = s.position.x - position.x;
          const dy = s.position.y - position.y;
          const dz = s.position.z - position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > max2) continue;
          // Reject cover on another storey: a rampart slot is not cover for
          // somebody in the courtyard beneath it.
          if (Math.abs(dy) > 3.0) continue;
          const align = s.facing.x * dirX + s.facing.z * dirZ;
          if (align < 0.34) continue;
          // Prefer close, well-aligned, high-quality cover, in that order of
          // magnitude — distance dominates because a perfect slot 40 m away is
          // worse than a mediocre one at 6 m when somebody is shooting at you.
          const score = s.quality * (0.55 + 0.45 * align) - Math.sqrt(d2) * 0.045;
          if (score > bestScore) {
            bestScore = score;
            best = s;
          }
        }
      }
    }
    return best;
  }
}
