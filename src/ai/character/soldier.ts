/**
 * The procedural soldier: geometry, three LODs, and the bone list the poser
 * drives.
 *
 * OWNER: AI.
 *
 * "Procedural humans are the highest-variance deliverable in the brief" — so
 * this model is deliberately a GEAR model, not an anatomy model. Every large
 * silhouette element is equipment: helmet with a brim and a nape flap, plate
 * carrier with shoulder pads and mag pouches, day pack with a roll on top,
 * knee pads, boots, gloves, a scarf at the collar. Skin appears only as a
 * narrow band around the eyes. That is how you get a soldier that reads at
 * 30 m without ever having to solve a face.
 *
 * Everything is built from three.js primitives merged per BONE, so the whole
 * squad draws as one `InstancedMesh` per bone per LOD per team — 24 bots at
 * about 20 draws rather than 350.
 *
 * Dimensions come from `CharacterConfig` (GAME's capsule), never from constants
 * of our own: if the mesh and the capsule disagree by 5 cm the bots float and
 * the hitboxes sit off the body, and it reads as a physics bug.
 */
import * as THREE from 'three';
import { MaterialFeature, SurfaceId, Team, type MaterialFactory } from '@/engine/types';

/** Bone ids. The poser writes one world matrix per bone; parts index into them. */
export enum Bone {
  Root = 0,
  Hips = 1,
  Spine = 2,
  Head = 3,
  ArmUpperL = 4,
  ArmLowerL = 5,
  ArmUpperR = 6,
  ArmLowerR = 7,
  LegUpperL = 8,
  LegLowerL = 9,
  LegUpperR = 10,
  LegLowerR = 11,
  Weapon = 12,
  Count = 13,
}

export enum SoldierMaterial {
  Uniform = 0,
  Gear = 1,
  Skin = 2,
  Weapon = 3,
  Count = 4,
}

export interface SoldierPart {
  readonly bone: Bone;
  readonly material: SoldierMaterial;
  readonly geometry: THREE.BufferGeometry;
}

export interface SoldierLod {
  readonly parts: readonly SoldierPart[];
  /** Distance in metres beyond which the next, coarser LOD takes over. */
  readonly maxDistance: number;
}

export interface SoldierModel {
  readonly lods: readonly SoldierLod[];
  readonly materials: readonly THREE.Material[][];
  readonly scale: number;
  /** Local-space bone rest offsets, in the parent bone's frame. */
  readonly rest: Readonly<Record<Bone, THREE.Vector3>>;
}

interface Piece {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const V = new THREE.Vector3();
const S = new THREE.Vector3();
const EULER = new THREE.Euler();

function place(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): Piece {
  EULER.set(rx, ry, rz);
  Q.setFromEuler(EULER);
  V.set(x, y, z);
  S.set(sx, sy, sz);
  return { geometry, matrix: new THREE.Matrix4().compose(V, Q, S) };
}

/**
 * Merge pieces into one indexed geometry with position/normal/uv. Written here
 * rather than pulled from three's example utils so the lane has no dependency
 * outside `three` itself.
 */
function merge(pieces: readonly Piece[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of pieces) {
    vertexCount += p.geometry.getAttribute('position').count;
    const index = p.geometry.getIndex();
    indexCount += index ? index.count : p.geometry.getAttribute('position').count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint16Array(indexCount);

  let vo = 0;
  let io = 0;
  const normalMatrix = new THREE.Matrix3();
  for (const p of pieces) {
    const src = p.geometry;
    const pos = src.getAttribute('position');
    const nrm = src.getAttribute('normal');
    const tex = src.getAttribute('uv');
    normalMatrix.getNormalMatrix(p.matrix);
    for (let i = 0; i < pos.count; i++) {
      V.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(p.matrix);
      position[(vo + i) * 3] = V.x;
      position[(vo + i) * 3 + 1] = V.y;
      position[(vo + i) * 3 + 2] = V.z;
      if (nrm) {
        V.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(normalMatrix).normalize();
        normal[(vo + i) * 3] = V.x;
        normal[(vo + i) * 3 + 1] = V.y;
        normal[(vo + i) * 3 + 2] = V.z;
      }
      if (tex) {
        uv[(vo + i) * 2] = tex.getX(i);
        uv[(vo + i) * 2 + 1] = tex.getY(i);
      }
    }
    const srcIndex = src.getIndex();
    if (srcIndex) {
      for (let i = 0; i < srcIndex.count; i++) index[io + i] = vo + srcIndex.getX(i);
      io += srcIndex.count;
    } else {
      for (let i = 0; i < pos.count; i++) index[io + i] = vo + i;
      io += pos.count;
    }
    vo += pos.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/** Rounded box via a low-segment sphere squashed to the box's proportions. */
function pill(rx: number, ry: number, rz: number, segments = 8): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, segments, Math.max(4, segments >> 1));
  geometry.scale(rx, ry, rz);
  return geometry;
}

function limb(radius: number, length: number, segments = 7): THREE.BufferGeometry {
  const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 2, segments);
  // Capsules are built centred on the origin along Y; limbs hang from a joint.
  geometry.translate(0, -length * 0.5, 0);
  return geometry;
}

function slab(w: number, h: number, d: number, bevel = 0.82): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  // Chamfer by pulling the top face in: a plain cube reads as a crate, and a
  // 4-vertex taper is enough to kill that at no vertex cost.
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      pos.setX(i, pos.getX(i) * bevel);
      pos.setZ(i, pos.getZ(i) * bevel);
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build the model, or return null when the shared material budget is already
 * spent. Null is a legitimate answer, not an error path: the soldier is
 * PRESENTATION, and a lane that cannot draw its characters must still let the
 * simulation — and every other lane's shot — boot.
 */
export function buildSoldierModel(
  materials: MaterialFactory,
  standHeight: number,
  radius: number,
): SoldierModel | null {
  // Everything below is authored for a 1.8 m soldier and scaled to the capsule.
  const scale = standHeight / 1.8;
  const shoulder = Math.max(0.17, radius * 0.56);

  /* ---------------------------------------------------------------- LOD 0 */
  const hips = merge([
    place(pill(0.16, 0.12, 0.13), 0, -0.02, 0),
    // Belt kit: canteen left, dump pouch right.
    place(slab(0.09, 0.11, 0.08), -0.16, -0.03, 0.02),
    place(slab(0.11, 0.09, 0.07), 0.15, -0.05, -0.02),
  ]);

  const torso = merge([
    // Chest and back, tapering to the shoulders.
    place(pill(0.2, 0.27, 0.13), 0, 0.24, 0),
    // Plate carrier front and back plates, standing proud of the chest.
    place(slab(0.31, 0.34, 0.05), 0, 0.26, 0.115),
    place(slab(0.3, 0.32, 0.045), 0, 0.25, -0.115),
    // Magazine pouches across the front — the strongest read at distance.
    place(slab(0.075, 0.115, 0.055), -0.085, 0.12, 0.15),
    place(slab(0.075, 0.115, 0.055), 0, 0.12, 0.155),
    place(slab(0.075, 0.115, 0.055), 0.085, 0.12, 0.15),
    // Shoulder pads.
    place(pill(0.075, 0.06, 0.09), -shoulder, 0.4, 0),
    place(pill(0.075, 0.06, 0.09), shoulder, 0.4, 0),
    // Radio on the left shoulder with a stub antenna.
    place(slab(0.06, 0.09, 0.05), -0.14, 0.36, -0.1),
    place(limb(0.008, 0.22, 5), -0.14, 0.5, -0.1, 0.22, 0, 0.16),
  ]);

  const pack = merge([
    place(pill(0.16, 0.19, 0.09), 0, 0.24, -0.18),
    // Roll strapped across the top: the classic infantry silhouette break.
    place(limb(0.055, 0.34, 6), 0, 0.42, -0.2, 0, 0, Math.PI / 2),
    place(slab(0.05, 0.06, 0.04), -0.1, 0.12, -0.24),
  ]);

  const head = merge([
    // Neck and balaclava.
    place(limb(0.045, 0.09, 6), 0, 0.03, 0),
    place(pill(0.082, 0.095, 0.088), 0, 0.09, 0.004),
    // Helmet shell, brim and nape flap.
    place(pill(0.104, 0.088, 0.108, 10), 0, 0.135, -0.004),
    place(slab(0.19, 0.018, 0.06), 0, 0.126, 0.085),
    place(slab(0.16, 0.06, 0.02), 0, 0.098, -0.1),
    // Goggles on the brim, and the scarf at the collar.
    place(slab(0.17, 0.035, 0.035), 0, 0.152, 0.058),
    place(pill(0.085, 0.03, 0.08), 0, 0.012, 0.01),
  ]);
  const face = merge([place(pill(0.058, 0.028, 0.03), 0, 0.093, 0.07)]);

  const armUpper = merge([place(limb(0.052, 0.28), 0, 0, 0)]);
  const armLowerL = merge([
    place(limb(0.045, 0.25), 0, 0, 0),
    // Glove.
    place(pill(0.05, 0.045, 0.055), 0, -0.26, 0.01),
  ]);
  const armLowerR = armLowerL.clone();

  const legUpper = merge([
    place(limb(0.072, 0.45), 0, 0, 0),
    // Knee pad.
    place(slab(0.1, 0.09, 0.05), 0, -0.4, 0.055),
  ]);
  const legLower = merge([
    place(limb(0.058, 0.43), 0, 0, 0),
    // Boot: a wedge, toe forward.
    place(slab(0.095, 0.075, 0.135, 0.7), 0, -0.42, 0.035),
  ]);

  const weapon = buildRifle();

  const lod0: SoldierPart[] = [
    { bone: Bone.Hips, material: SoldierMaterial.Uniform, geometry: hips },
    { bone: Bone.Spine, material: SoldierMaterial.Uniform, geometry: torso },
    { bone: Bone.Spine, material: SoldierMaterial.Gear, geometry: pack },
    { bone: Bone.Head, material: SoldierMaterial.Gear, geometry: head },
    { bone: Bone.Head, material: SoldierMaterial.Skin, geometry: face },
    { bone: Bone.ArmUpperL, material: SoldierMaterial.Uniform, geometry: armUpper },
    { bone: Bone.ArmLowerL, material: SoldierMaterial.Uniform, geometry: armLowerL },
    { bone: Bone.ArmUpperR, material: SoldierMaterial.Uniform, geometry: armUpper.clone() },
    { bone: Bone.ArmLowerR, material: SoldierMaterial.Uniform, geometry: armLowerR },
    { bone: Bone.LegUpperL, material: SoldierMaterial.Uniform, geometry: legUpper },
    { bone: Bone.LegLowerL, material: SoldierMaterial.Uniform, geometry: legLower },
    { bone: Bone.LegUpperR, material: SoldierMaterial.Uniform, geometry: legUpper.clone() },
    { bone: Bone.LegLowerR, material: SoldierMaterial.Uniform, geometry: legLower.clone() },
    { bone: Bone.Weapon, material: SoldierMaterial.Weapon, geometry: weapon },
  ];

  /* ---------------------------------------------------------------- LOD 1 */
  // Same silhouette, half the parts: pack and torso merged, head simplified,
  // arms gone (they are inside the torso volume at this range), legs single.
  const torso1 = merge([
    place(pill(0.2, 0.28, 0.14), 0, 0.24, 0),
    place(slab(0.32, 0.34, 0.06), 0, 0.26, 0.11),
    place(pill(0.16, 0.19, 0.09), 0, 0.24, -0.18),
    place(pill(0.075, 0.06, 0.09), -shoulder, 0.4, 0),
    place(pill(0.075, 0.06, 0.09), shoulder, 0.4, 0),
    place(limb(0.05, 0.5, 6), -shoulder, 0.4, 0.02, 0.35, 0, 0.1),
    place(limb(0.05, 0.5, 6), shoulder, 0.4, 0.02, 0.35, 0, -0.1),
  ]);
  const head1 = merge([
    place(pill(0.085, 0.1, 0.09, 8), 0, 0.09, 0),
    place(pill(0.105, 0.09, 0.11, 8), 0, 0.135, 0),
    place(slab(0.19, 0.02, 0.06), 0, 0.126, 0.085),
  ]);
  const leg1 = merge([place(limb(0.075, 0.88, 6), 0, 0, 0), place(slab(0.1, 0.07, 0.13, 0.7), 0, -0.86, 0.03)]);
  const lod1: SoldierPart[] = [
    { bone: Bone.Hips, material: SoldierMaterial.Uniform, geometry: hips.clone() },
    { bone: Bone.Spine, material: SoldierMaterial.Uniform, geometry: torso1 },
    { bone: Bone.Head, material: SoldierMaterial.Gear, geometry: head1 },
    { bone: Bone.LegUpperL, material: SoldierMaterial.Uniform, geometry: leg1 },
    { bone: Bone.LegUpperR, material: SoldierMaterial.Uniform, geometry: leg1.clone() },
    { bone: Bone.Weapon, material: SoldierMaterial.Weapon, geometry: buildRifle(true) },
  ];

  /* ---------------------------------------------------------------- LOD 2 */
  // One body, one weapon. At 60 m+ this is four pixels wide and all that
  // survives is the standing silhouette and the dark helmet on top.
  const body2 = merge([
    place(limb(0.1, 0.9, 6), 0, 0.02, 0),
    place(pill(0.19, 0.26, 0.15, 6), 0, 0.24, 0),
    place(pill(0.1, 0.1, 0.1, 6), 0, 0.52, 0),
  ]);
  const lod2: SoldierPart[] = [
    { bone: Bone.Hips, material: SoldierMaterial.Uniform, geometry: body2 },
    { bone: Bone.Weapon, material: SoldierMaterial.Weapon, geometry: buildRifle(true) },
  ];

  /* ------------------------------------------------------------ materials */
  /**
   * FIVE MATERIALS FOR TWENTY-FOUR SOLDIERS, and the count is the design.
   *
   * `MaterialFactory` enforces a hard per-tier permutation cap shared by every
   * lane in the repo, and a character rig is the single greediest thing that
   * could ask for slots — four zones × two teams is eight before anyone has
   * drawn a building. Only the UNIFORM is team-coded, because that is the one
   * surface a player reads friend-or-foe from at 40 m. Helmets, plate carriers
   * and packs are dark on both sides of a real fight, hands are hands, and the
   * rifle is the same rifle, so those three are shared outright.
   *
   * `create` dedupes by `id`, so handing both teams the same id costs one slot,
   * not two.
   */
  const shared = (spec: Parameters<MaterialFactory['create']>[0]): THREE.Material | null => {
    try {
      return materials.create(spec);
    } catch {
      // The cap is a whole-repo budget and another lane may have spent it. A
      // cosmetic character material is not worth failing everyone's boot for —
      // the caller collapses the missing slot onto one that did allocate, and
      // if none did, drops the soldier renderer entirely.
      return null;
    }
  };

  const uniforms: (THREE.Material | null)[] = [];
  for (const team of [Team.Coalition, Team.Insurgent]) {
    uniforms.push(
      shared({
        id: `ai.soldier.uniform.${team}`,
        surface: SurfaceId.Fabric,
        layer: 0,
        features: MaterialFeature.None,
        // Coalition: dusty coyote. Insurgent: darker olive-grey. Both sit inside
        // the map's sandstone/teal language rather than fighting it — but a full
        // stop DARKER than the sandstone they stand on. Matching the ground
        // value is how a soldier at 40 m disappears into it, and the frame this
        // model has to survive is one where the whole town is that colour.
        baseColor: team === Team.Coalition ? 0x6f6044 : 0x424a3a,
        roughness: 0.94,
        metalness: 0,
        instanced: true,
      }),
    );
  }
  const gear = shared({
    id: 'ai.soldier.gear',
    surface: SurfaceId.Kevlar,
    layer: 0,
    features: MaterialFeature.None,
    baseColor: 0x33301f,
    roughness: 0.78,
    metalness: 0,
    instanced: true,
  });
  const skin = shared({
    id: 'ai.soldier.skin',
    surface: SurfaceId.Flesh,
    layer: 0,
    features: MaterialFeature.None,
    baseColor: 0x85604b,
    roughness: 0.62,
    metalness: 0,
    instanced: true,
  });
  const rifleMaterial = shared({
    id: 'ai.soldier.weapon',
    surface: SurfaceId.PaintedMetal,
    layer: 0,
    features: MaterialFeature.None,
    baseColor: 0x26272a,
    roughness: 0.44,
    metalness: 0.72,
    instanced: true,
  });

  // Collapse whatever failed onto whatever succeeded, in preference order. A
  // soldier in one flat colour is still a soldier; a soldier with a null
  // material is a crash inside three's render loop.
  const anyMaterial = uniforms[0] ?? uniforms[1] ?? gear ?? rifleMaterial ?? skin;
  if (!anyMaterial) return null;
  const teamMaterials: THREE.Material[][] = [];
  for (let team = 0; team < 2; team++) {
    const set: THREE.Material[] = [];
    set[SoldierMaterial.Uniform] = uniforms[team] ?? anyMaterial;
    set[SoldierMaterial.Gear] = gear ?? set[SoldierMaterial.Uniform];
    set[SoldierMaterial.Skin] = skin ?? set[SoldierMaterial.Uniform];
    set[SoldierMaterial.Weapon] = rifleMaterial ?? set[SoldierMaterial.Gear];
    teamMaterials.push(set);
  }

  const rest: Record<Bone, THREE.Vector3> = {
    [Bone.Root]: new THREE.Vector3(0, 0, 0),
    [Bone.Hips]: new THREE.Vector3(0, 0.94, 0),
    [Bone.Spine]: new THREE.Vector3(0, 0.06, 0),
    [Bone.Head]: new THREE.Vector3(0, 0.48, 0),
    [Bone.ArmUpperL]: new THREE.Vector3(-shoulder - 0.03, 0.4, 0),
    [Bone.ArmLowerL]: new THREE.Vector3(0, -0.28, 0),
    [Bone.ArmUpperR]: new THREE.Vector3(shoulder + 0.03, 0.4, 0),
    [Bone.ArmLowerR]: new THREE.Vector3(0, -0.28, 0),
    [Bone.LegUpperL]: new THREE.Vector3(-0.1, -0.04, 0),
    [Bone.LegLowerL]: new THREE.Vector3(0, -0.45, 0),
    [Bone.LegUpperR]: new THREE.Vector3(0.1, -0.04, 0),
    [Bone.LegLowerR]: new THREE.Vector3(0, -0.45, 0),
    [Bone.Weapon]: new THREE.Vector3(0.1, 0.3, 0.02),
    [Bone.Count]: new THREE.Vector3(),
  };

  return {
    lods: [
      { parts: lod0, maxDistance: 22 },
      { parts: lod1, maxDistance: 55 },
      { parts: lod2, maxDistance: Infinity },
    ],
    materials: teamMaterials,
    scale,
    rest,
  };
}

/**
 * A carbine, in the weapon bone's frame: barrel along −Z, so the bone's forward
 * is the bore. Coarse on purpose — WEAPONS owns the hero first-person model and
 * this one is never seen closer than a couple of metres.
 */
function buildRifle(simplified = false): THREE.BufferGeometry {
  const pieces: Piece[] = [
    // Receiver.
    place(slab(0.055, 0.085, 0.34), 0, 0, -0.02),
    // Barrel and handguard.
    place(limb(0.016, 0.3, 6), 0, 0.015, -0.33, Math.PI / 2, 0, 0),
    place(slab(0.05, 0.06, 0.22), 0, 0.012, -0.26),
    // Magazine, raked forward like a STANAG.
    place(slab(0.035, 0.19, 0.06), 0, -0.11, 0.01, 0.18, 0, 0),
    // Stock.
    place(slab(0.045, 0.07, 0.2), 0, -0.01, 0.2),
    place(slab(0.04, 0.09, 0.06), 0, -0.06, 0.09),
  ];
  if (!simplified) {
    // Optic and its rail.
    pieces.push(place(slab(0.03, 0.02, 0.2), 0, 0.05, -0.06));
    pieces.push(place(limb(0.022, 0.11, 6), 0, 0.075, -0.06, Math.PI / 2, 0, 0));
    // Foregrip.
    pieces.push(place(slab(0.03, 0.09, 0.035), 0, -0.055, -0.28));
  }
  return merge(pieces);
}

export { M as SOLDIER_SCRATCH_MATRIX };
