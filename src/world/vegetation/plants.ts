/**
 * Procedural plants for a Mediterranean / Levantine coast: date palm, olive,
 * dry scrub and agave. OWNER: VEG.
 *
 * Each species returns two LOD ladders — one for the woody parts (bark
 * material) and one for the foliage (translucent leaf material) — because the
 * two shade completely differently and merging them would force one material to
 * lie about the other. Both ladders are built with the SAME per-species RNG
 * draw order, so LOD1 is recognisably the same tree as LOD0 rather than a
 * different tree of the same species, which is what makes a LOD switch
 * invisible even before the dither fade.
 *
 * SHADING NORMALS ARE NOT FACE NORMALS. Every leaf is given a normal blended
 * toward the canopy's outward direction (`spherify` below). A leaf lit by its
 * true face normal flips between full-lit and full-dark as it rotates, and a
 * canopy of those reads as glitter. Blending toward the canopy sphere makes the
 * crown light as ONE rounded mass with leaves modulating it — which is what a
 * real canopy does, because every leaf is lit mostly by light that already
 * bounced through its neighbours.
 */
import * as THREE from 'three';
import type { Rng } from '@/engine/types';
import { MeshBuilder, type Mutable, type StripSample, stripe, tube } from '@/world/vegetation/geometry';

/** One species, as the runtime consumes it. */
export interface PlantAsset {
  readonly id: string;
  /** Foliage LOD ladder, coarsest last. Index = LOD level. */
  readonly foliage: readonly THREE.BufferGeometry[];
  /** Woody LOD ladder. Same length as `foliage`; a level may be an empty geometry. */
  readonly wood: readonly THREE.BufferGeometry[];
  /** Nominal height in metres at unit scale. Drives the wind bend profile. */
  readonly height: number;
  /** Nominal crown radius, metres. Used for exclusion tests and LOD screen error. */
  readonly radius: number;
  /** 0..1; low = floppy. Feeds the wind deform and the CPU trunk sway. */
  readonly stiffness: number;
}

const TAU = Math.PI * 2;

/**
 * Blend a face normal toward the direction from the canopy centre. `k` = 1 is a
 * pure sphere normal (a soft ball), `k` = 0 is the raw face normal (glitter).
 * 0.55–0.75 is where a canopy reads as a mass that still has leaves in it.
 */
function spherify(
  out: Mutable<StripSample>,
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  fx: number, fy: number, fz: number,
  k: number,
): void {
  let sx = px - cx;
  let sy = py - cy;
  let sz = pz - cz;
  const len = Math.hypot(sx, sy, sz) || 1;
  sx /= len; sy /= len; sz /= len;
  out.nx = fx * (1 - k) + sx * k;
  out.ny = fy * (1 - k) + sy * k;
  out.nz = fz * (1 - k) + sz * k;
}

/* ========================================================================== */
/* DATE PALM                                                                   */
/* ========================================================================== */

/**
 * One frond: a drooping rachis carrying paired leaflets.
 *
 * The droop is the whole character of a palm. A frond leaves the crown at
 * `pitch` and is pulled down by its own weight along its length — modelled as a
 * quadratic in arc length, not a circular arc, because gravity loading on a
 * cantilever is quadratic and the difference is visible in silhouette.
 */
function frond(
  b: MeshBuilder,
  length: number,
  pitch: number,
  droop: number,
  pairs: number,
  leafSegments: number,
  rng: Rng,
  solid = false,
): void {
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  // Rachis centreline in the frond's own X (outward) / Y (up) plane.
  const rachis = (t: number, out: THREE.Vector3): void => {
    const s = t * length;
    out.set(s * cosP, s * sinP - droop * s * s, 0);
  };
  const p = new THREE.Vector3();
  const pNext = new THREE.Vector3();

  // The rachis itself: a thin keeled strip so the frond has a spine in
  // silhouette rather than leaflets floating off nothing.
  stripe(b, 7, true, (t, s) => {
    rachis(t, p);
    s.px = p.x; s.py = p.y; s.pz = p.z;
    s.halfWidth = 0.032 * (1 - t * 0.85);
    s.wx = 0; s.wy = 0; s.wz = 1;
    s.nx = -sinP; s.ny = cosP; s.nz = 0;
  });

  // Crown centre for the spherified normals: roughly where the fronds converge.
  const cx = 0;
  const cy = -length * 0.18;
  const cz = 0;

  if (solid) {
    // THE IMPOSTOR FROND. Past ~110 m a leaflet is a fifth of a pixel and all
    // the individual geometry buys is aliasing, but DROPPING it turns the palm
    // into a bare pole — which is exactly what distant procedural trees usually
    // look like. So the far LOD keeps the frond's SILHOUETTE as one solid
    // tapered blade whose width follows the same pinnate profile the leaflets
    // describe. Three triangles instead of a hundred and forty, same shape.
    stripe(b, 3, true, (t, s) => {
      rachis(t, p);
      s.px = p.x; s.py = p.y; s.pz = p.z;
      s.halfWidth = Math.min(0.30, length * 0.085) * Math.sin(Math.pow(Math.max(t, 0.03), 0.62) * Math.PI);
      s.wx = 0; s.wy = 0.18; s.wz = 1;
      spherify(s, s.px, s.py, s.pz, cx, cy, cz, 0, 1, 0, 0.7);
    });
    return;
  }

  for (let i = 0; i < pairs; i++) {
    const t = (i + 0.6) / (pairs + 0.4);
    rachis(t, p);
    rachis(Math.min(1, t + 0.01), pNext);
    const tanX = pNext.x - p.x;
    const tanY = pNext.y - p.y;
    const tanLen = Math.hypot(tanX, tanY) || 1;
    // Leaflet length peaks near 45% of the rachis — the classic pinnate profile.
    const profile = Math.sin(Math.pow(t, 0.62) * Math.PI);
    const leafLen = length * (0.16 + 0.10 * rng.next()) * profile;
    if (leafLen < 0.02) continue;
    const width = leafLen * (leafSegments > 1 ? 0.075 : 0.155);

    for (const side of [-1, 1]) {
      // Leaflets sweep back toward the tip and rise out of the rachis plane;
      // the rise is what stops a frond reading as a flat feather cut-out.
      const sweep = 0.62 + 0.22 * rng.next();
      const rise = (0.42 + 0.3 * rng.next()) * (1 - t * 0.5);
      const dirX = (tanX / tanLen) * sweep;
      const dirY = (tanY / tanLen) * sweep + rise * 0.35;
      const dirZ = side * Math.sqrt(Math.max(0.02, 1 - sweep * sweep));
      const dl = Math.hypot(dirX, dirY, dirZ) || 1;
      // Leaflets droop along their own length too.
      const sagPerM = 0.55 + 0.5 * rng.next();

      stripe(b, leafSegments, true, (u, s) => {
        const d = u * leafLen;
        const sag = sagPerM * d * d;
        s.px = p.x + (dirX / dl) * d;
        s.py = p.y + (dirY / dl) * d - sag;
        s.pz = p.z + (dirZ / dl) * d;
        s.halfWidth = width * (1 - u * u * 0.9);
        // Width runs across the leaflet, roughly in the rachis plane.
        s.wx = -(tanY / tanLen);
        s.wy = tanX / tanLen;
        s.wz = 0;
        spherify(s, s.px, s.py, s.pz, cx, cy, cz, 0, 1, 0, 0.62);
      });
    }
  }
}

function palmTrunk(b: MeshBuilder, height: number, leanX: number, leanZ: number, radial: number, segments: number): void {
  tube(
    b,
    radial,
    segments,
    (t, out) => {
      // Palms lean; the curve is quadratic so the base stays planted.
      out.set(leanX * t * t, t * height, leanZ * t * t);
    },
    (t, a) => {
      const base = 0.255 - 0.105 * t;
      // Flare at the ground — every palm has one, and it is also what kills the
      // hard geometry/ground seam without a decal.
      const flare = 1 + 0.38 * Math.exp(-t * 24);
      // Diamond leaf-base scars: two counter-rotating helices of relief.
      const scar = 0.055 * Math.sin(t * height * 4.4 + a * 4) * Math.sin(t * height * 4.4 - a * 4);
      return base * flare * (1 + scar) * (1 - t * 0.06);
    },
    height * 0.45,
  );
}

function buildPalm(rng: Rng): PlantAsset {
  const height = 8.4;
  const leanX = rng.range(-0.5, 0.5);
  const leanZ = rng.range(-0.5, 0.5);
  const crownY = height;

  const make = (fronds: number, pairs: number, leafSeg: number, radial: number, seg: number, solid: boolean, rngLod: Rng) => {
    const wood = new MeshBuilder();
    palmTrunk(wood, height, leanX, leanZ, radial, seg);
    const fol = new MeshBuilder();
    const m = new THREE.Matrix4();
    const e = new THREE.Euler();
    for (let i = 0; i < fronds; i++) {
      const f = new MeshBuilder();
      // Outer fronds are older: longer, flatter, drooping harder.
      const age = i / Math.max(1, fronds - 1);
      const pitch = 0.95 - age * 1.45 + rngLod.range(-0.12, 0.12);
      const length = 3.1 + age * 0.9 + rngLod.range(-0.25, 0.25);
      frond(f, length, pitch, 0.055 + age * 0.045, pairs, leafSeg, rngLod, solid);
      // Golden-angle phyllotaxis, jittered — a real crown is neither uniform
      // nor random, and a uniform fan is instantly readable as procedural.
      const yaw = i * 2.39996 + rngLod.range(-0.16, 0.16);
      e.set(0, yaw, 0);
      m.makeRotationFromEuler(e);
      m.setPosition(leanX + Math.cos(yaw) * 0.1, crownY - 0.25, leanZ + Math.sin(yaw) * 0.1);
      fol.append(f, m);
    }

    // THE SKIRT. An unpruned date palm keeps a collar of dead fronds hanging
    // straight down under the living crown, and it is the single most
    // recognisable thing about the species after the trunk scars. They go into
    // the WOOD builder rather than the foliage one — not a trick: a dead frond
    // IS dry lignified material, so the bark material's colour, roughness and
    // near-zero wind response are all the right answers for it, and it costs no
    // extra draw call.
    const skirt = Math.max(3, Math.round(fronds * 0.4));
    for (let i = 0; i < skirt; i++) {
      const f = new MeshBuilder();
      const yaw = i * 2.39996 + 1.1 + rngLod.range(-0.2, 0.2);
      frond(f, 2.1 + rngLod.range(-0.35, 0.35), -0.95 + rngLod.range(-0.15, 0.15), 0.11, Math.max(4, pairs >> 1), 1, rngLod, solid);
      e.set(0, yaw, 0);
      m.makeRotationFromEuler(e);
      m.setPosition(leanX + Math.cos(yaw) * 0.16, crownY - 0.45, leanZ + Math.sin(yaw) * 0.16);
      wood.append(f, m);
    }
    return { wood, fol };
  };

  const lod0 = make(17, 19, 2, 9, 13, false, rng.fork('palm.lod0'));
  const lod1 = make(13, 10, 1, 6, 7, false, rng.fork('palm.lod1'));
  const lod2 = make(11, 0, 1, 5, 3, true, rng.fork('palm.lod2'));

  return {
    id: 'palm',
    foliage: [lod0.fol.toGeometry('palm.f0'), lod1.fol.toGeometry('palm.f1'), lod2.fol.toGeometry('palm.f2')],
    wood: [lod0.wood.toGeometry('palm.w0'), lod1.wood.toGeometry('palm.w1'), lod2.wood.toGeometry('palm.w2')],
    height,
    radius: 4.2,
    // A palm trunk barely bends; the crown does all the moving. The runtime
    // splits that: `stiffness` here drives the CPU trunk sway, and the frond
    // deform chunk carries its own much lower value.
    stiffness: 0.82,
  };
}

/* ========================================================================== */
/* OLIVE                                                                       */
/* ========================================================================== */

interface BranchState {
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  length: number;
  radius: number;
  depth: number;
}

/** A puff of lanceolate leaves at a twig tip. Olive leaves are narrow and pale. */
function leafPuff(
  b: MeshBuilder,
  cx: number, cy: number, cz: number,
  radius: number,
  count: number,
  segments: number,
  rng: Rng,
  fatten = 1,
): void {
  for (let i = 0; i < count; i++) {
    // Fibonacci sphere so the puff has no pole and no seam.
    const k = (i + 0.5) / count;
    const phi = Math.acos(1 - 2 * k);
    const theta = TAU * k * 1.61803399;
    const ux = Math.sin(phi) * Math.cos(theta);
    const uy = Math.cos(phi) * 0.75 + 0.18;
    const uz = Math.sin(phi) * Math.sin(theta);
    // Coarse LODs get FEWER but BIGGER leaves. Dropping the count without
    // growing the leaves is what turns every distant tree in a procedural scene
    // into a bare stick, and it is far more visible than the polygon saving.
    const len = radius * (0.75 + 0.5 * rng.next()) * fatten;
    const half = len * 0.13 * fatten;
    // A perpendicular for the leaf width.
    let wx = -uz, wy = 0, wz = ux;
    const wl = Math.hypot(wx, wy, wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    const sag = 0.35 + 0.5 * rng.next();
    stripe(b, segments, true, (t, s) => {
      const d = t * len;
      s.px = cx + ux * d;
      s.py = cy + uy * d - sag * d * d;
      s.pz = cz + uz * d;
      // Lanceolate: widest at 40%, pointed at both ends.
      s.halfWidth = half * Math.sin(Math.pow(Math.max(t, 0.02), 0.55) * Math.PI);
      s.wx = wx; s.wy = wy; s.wz = wz;
      spherify(s, s.px, s.py, s.pz, cx, cy - radius * 0.5, cz, 0, 1, 0, 0.7);
    });
  }
}

function buildOlive(rng: Rng): PlantAsset {
  const height = 4.6;

  const make = (
    branchDepth: number,
    puffLeaves: number,
    leafSeg: number,
    radial: number,
    fatten: number,
    rngLod: Rng,
  ) => {
    const wood = new MeshBuilder();
    const fol = new MeshBuilder();
    const stack: BranchState[] = [
      { x: 0, y: 0, z: 0, dx: 0.06, dy: 1, dz: -0.04, length: 1.45, radius: 0.21, depth: 0 },
    ];

    while (stack.length > 0) {
      const s = stack.pop() as BranchState;
      const dl = Math.hypot(s.dx, s.dy, s.dz) || 1;
      const ux = s.dx / dl, uy = s.dy / dl, uz = s.dz / dl;
      // Olive trunks are gnarled: the centreline wanders and the section is
      // fluted rather than round. Both are what stops it reading as a pipe.
      const wanderX = rngLod.range(-0.22, 0.22) * s.length;
      const wanderZ = rngLod.range(-0.22, 0.22) * s.length;
      const flutePhase = rngLod.range(0, TAU);
      const fluteAmp = s.depth === 0 ? 0.20 : 0.10;

      tube(
        wood,
        radial,
        s.depth === 0 ? 6 : 3,
        (t, out) => {
          out.set(
            s.x + ux * s.length * t + wanderX * t * t,
            s.y + uy * s.length * t,
            s.z + uz * s.length * t + wanderZ * t * t,
          );
        },
        (t, a) => {
          const taper = s.radius * (1 - t * 0.42);
          const flare = s.depth === 0 ? 1 + 0.7 * Math.exp(-t * 9) : 1;
          return taper * flare * (1 + fluteAmp * Math.sin(a * 5 + flutePhase) + 0.06 * Math.sin(a * 11 - flutePhase));
        },
        2,
      );

      const tipX = s.x + ux * s.length + wanderX;
      const tipY = s.y + uy * s.length;
      const tipZ = s.z + uz * s.length + wanderZ;

      if (s.depth >= branchDepth) {
        // TWO puffs per terminal branch, and a puff radius of 0.30 m rather than
        // 0.62. An olive leaf is 4–8 cm; at 0.62 m the "leaves" were 70 cm
        // blades and the tree read as a dragon palm. Small leaves need MORE of
        // them and more clusters of them, which is the correct trade: leaf SIZE
        // is what identifies a species at 10 m, leaf COUNT is only cost.
        leafPuff(fol, tipX, tipY, tipZ, 0.30, puffLeaves, leafSeg, rngLod, fatten);
        leafPuff(
          fol,
          s.x + ux * s.length * 0.55 + wanderX * 0.3,
          s.y + uy * s.length * 0.55,
          s.z + uz * s.length * 0.55 + wanderZ * 0.3,
          0.26,
          Math.round(puffLeaves * 0.7),
          leafSeg,
          rngLod,
          fatten,
        );
        continue;
      }
      const children = s.depth === 0 ? 4 : rngLod.int(2) + 2;
      for (let i = 0; i < children; i++) {
        const yaw = (i / children) * TAU + rngLod.range(-0.4, 0.4);
        // Branch angle opens only SLIGHTLY with depth. Opening it hard makes the
        // sub-branches splay into a horizontal ring and the canopy reads as a
        // parasol — the failure mode of every naive L-system tree. An olive is a
        // rounded, slightly flat-topped mass, so the children keep a persistent
        // upward bias all the way to the twigs.
        const spread = 0.48 + s.depth * 0.13 + rngLod.range(-0.14, 0.14);
        stack.push({
          x: tipX, y: tipY, z: tipZ,
          dx: ux * Math.cos(spread) + Math.cos(yaw) * Math.sin(spread),
          dy: uy * Math.cos(spread) + 0.24,
          dz: uz * Math.cos(spread) + Math.sin(yaw) * Math.sin(spread),
          length: s.length * (0.70 + rngLod.range(-0.07, 0.07)),
          radius: s.radius * 0.46,
          depth: s.depth + 1,
        });
      }
    }
    return { wood, fol };
  };

  // Coarse LODs drop the leaf SEGMENT count and grow the leaf only slightly.
  // Keeping the branch depth is what preserves the canopy's VOLUME; growing the
  // leaves instead turns an olive into a parasol, which is worse than the sticks
  // it was meant to fix.
  const lod0 = make(3, 30, 2, 7, 1.0, rng.fork('olive.lod0'));
  const lod1 = make(3, 20, 1, 5, 1.35, rng.fork('olive.lod1'));
  const lod2 = make(2, 16, 1, 4, 2.2, rng.fork('olive.lod2'));

  return {
    id: 'olive',
    foliage: [lod0.fol.toGeometry('olive.f0'), lod1.fol.toGeometry('olive.f1'), lod2.fol.toGeometry('olive.f2')],
    wood: [lod0.wood.toGeometry('olive.w0'), lod1.wood.toGeometry('olive.w1'), lod2.wood.toGeometry('olive.w2')],
    height,
    radius: 2.9,
    stiffness: 0.66,
  };
}

/* ========================================================================== */
/* DRY SCRUB                                                                   */
/* ========================================================================== */

function buildScrub(rng: Rng): PlantAsset {
  const height = 0.95;

  const make = (twigs: number, leafEvery: number, fatten: number, rngLod: Rng) => {
    const wood = new MeshBuilder();
    const fol = new MeshBuilder();
    for (let i = 0; i < twigs; i++) {
      const yaw = (i / twigs) * TAU + rngLod.range(-0.3, 0.3);
      const out = 0.30 + 0.34 * rngLod.next();
      const top = height * (0.55 + 0.6 * rngLod.next());
      const dx = Math.cos(yaw) * out;
      const dz = Math.sin(yaw) * out;
      const droop = 0.35 + 0.5 * rngLod.next();

      stripe(wood, 4, true, (t, s) => {
        // Arc up and out, then fall away — the shape of every dead-dry
        // Mediterranean shrub, and it silhouettes far better than a bush blob.
        s.px = dx * t;
        s.py = top * Math.sin(t * 1.35) - droop * t * t * top * 0.45;
        s.pz = dz * t;
        s.halfWidth = 0.011 * (1 - t * 0.8);
        s.wx = -Math.sin(yaw); s.wy = 0; s.wz = Math.cos(yaw);
        s.nx = Math.cos(yaw) * 0.4; s.ny = 1; s.nz = Math.sin(yaw) * 0.4;
      });

      if (i % leafEvery !== 0) continue;
      for (let j = 0; j < 5; j++) {
        const t = 0.35 + 0.6 * (j / 5) + rngLod.range(-0.05, 0.05);
        const px = dx * t;
        const py = top * Math.sin(t * 1.35) - droop * t * t * top * 0.45;
        const pz = dz * t;
        leafPuff(fol, px, py, pz, 0.10, 4, 1, rngLod, fatten);
      }
    }
    return { wood, fol };
  };

  const lod0 = make(15, 2, 1.0, rng.fork('scrub.lod0'));
  const lod1 = make(10, 2, 1.2, rng.fork('scrub.lod1'));
  const lod2 = make(6, 2, 1.5, rng.fork('scrub.lod2'));

  return {
    id: 'scrub',
    foliage: [lod0.fol.toGeometry('scrub.f0'), lod1.fol.toGeometry('scrub.f1'), lod2.fol.toGeometry('scrub.f2')],
    wood: [lod0.wood.toGeometry('scrub.w0'), lod1.wood.toGeometry('scrub.w1'), lod2.wood.toGeometry('scrub.w2')],
    height,
    radius: 0.72,
    stiffness: 0.30,
  };
}

/* ========================================================================== */
/* AGAVE                                                                       */
/* ========================================================================== */

function buildAgave(rng: Rng): PlantAsset {
  const height = 0.85;

  const make = (blades: number, rngLod: Rng) => {
    const fol = new MeshBuilder();
    for (let i = 0; i < blades; i++) {
      const yaw = (i / blades) * TAU + rngLod.range(-0.15, 0.15);
      // Outer blades lie back; inner ones stand up. That rosette gradient is
      // the entire read of a succulent.
      const openness = 0.25 + 0.75 * (i % 3) / 2;
      const pitch = 1.25 - openness * 0.95;
      const len = height * (0.8 + 0.45 * rngLod.next()) / Math.max(0.35, Math.sin(pitch) + 0.35);
      const dx = Math.cos(yaw) * Math.cos(pitch);
      const dz = Math.sin(yaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const sag = 0.5 + 0.7 * rngLod.next();
      // Keel: two half-strips meeting along the blade's spine, so the blade is
      // a V in section and catches a hard highlight down one face.
      for (const side of [-1, 1]) {
        stripe(fol, 3, true, (t, s) => {
          const d = t * len;
          s.px = dx * d;
          s.py = dy * d - sag * d * d * 0.55;
          s.pz = dz * d;
          s.halfWidth = 0.5 * height * 0.20 * (1 - Math.pow(t, 1.7));
          s.wx = -Math.sin(yaw) * side;
          s.wy = 0.30 * side;
          s.wz = Math.cos(yaw) * side;
          s.nx = -Math.sin(yaw) * side * 0.3 + dx * 0.15;
          s.ny = 0.9;
          s.nz = Math.cos(yaw) * side * 0.3 + dz * 0.15;
        });
      }
    }
    return fol;
  };

  const empty = new MeshBuilder().toGeometry('agave.w');
  const l0 = make(13, rng.fork('agave.lod0'));
  const l1 = make(9, rng.fork('agave.lod1'));
  const l2 = make(6, rng.fork('agave.lod2'));

  return {
    id: 'agave',
    foliage: [l0.toGeometry('agave.f0'), l1.toGeometry('agave.f1'), l2.toGeometry('agave.f2')],
    wood: [empty, empty, empty],
    height,
    radius: 0.65,
    stiffness: 0.9,
  };
}

export function buildPlantLibrary(rng: Rng): Record<string, PlantAsset> {
  return {
    palm: buildPalm(rng.fork('palm')),
    olive: buildOlive(rng.fork('olive')),
    scrub: buildScrub(rng.fork('scrub')),
    agave: buildAgave(rng.fork('agave')),
  };
}
