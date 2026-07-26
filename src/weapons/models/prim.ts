/**
 * Procedural mesh primitives for the weapon models. WEAPONS owns this file.
 *
 * Everything in `src/weapons/models/` is built in code — the brief allows zero
 * imported meshes — so this is the small vocabulary the weapon builder speaks:
 * bevelled extrusions, lathes, tapered cylinders and a merge.
 *
 * Two rules shape the vocabulary:
 *
 *  1. NOTHING HAS A PERFECT 90° EDGE. Every straight edge on a real receiver is
 *     broken by a machining chamfer 0.3–0.8 mm wide, and at a viewmodel's
 *     15–30 cm from the eye that chamfer is 2–4 pixels of specular highlight.
 *     A box with sharp edges reads as a box; the same box with a 0.6 mm bevel
 *     reads as milled aluminium. Hence `bevelBox` rather than `THREE.BoxGeometry`.
 *  2. Every geometry carries exactly `position`/`normal`/`uv` so `mergeParts`
 *     can concatenate any two of them without inspecting attribute layouts.
 */
import * as THREE from 'three';

/** The three attributes every primitive here emits, in this order. */
const ATTRS = ['position', 'normal', 'uv'] as const;

/**
 * Strip a geometry down to position/normal/uv and give it an index. Anything
 * that reaches `mergeParts` has been through here, so the merge never has to
 * reason about which primitive generated which attribute set.
 */
export function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (!geometry.getAttribute('uv')) {
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(geometry.attributes)) {
    if (!(ATTRS as readonly string[]).includes(name)) geometry.deleteAttribute(name);
  }
  if (!geometry.getIndex()) {
    const count = geometry.getAttribute('position').count;
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }
  return geometry;
}

/** Apply a transform in place and return the geometry, for chaining. */
export function place(
  geometry: THREE.BufferGeometry,
  position: readonly [number, number, number],
  euler?: readonly [number, number, number],
  scale?: readonly [number, number, number],
): THREE.BufferGeometry {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (euler) q.setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2], 'YXZ'));
  m.compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    q,
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1),
  );
  geometry.applyMatrix4(m);
  return geometry;
}

/**
 * Concatenate normalised geometries into one indexed BufferGeometry.
 *
 * We do this by hand rather than pulling in three's `BufferGeometryUtils`
 * example module: the example modules are outside the package's typed public
 * surface and this is thirty lines that cannot drift.
 */
export function mergeParts(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    normalise(p);
    vertexCount += p.getAttribute('position').count;
    indexCount += p.getIndex()!.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint32Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position');
    const pn = p.getAttribute('normal');
    const pu = p.getAttribute('uv');
    const pi = p.getIndex()!;
    position.set(pp.array as Float32Array, vOffset * 3);
    normal.set(pn.array as Float32Array, vOffset * 3);
    uv.set(pu.array as Float32Array, vOffset * 2);
    for (let i = 0; i < pi.count; i++) index[iOffset + i] = pi.getX(i) + vOffset;
    vOffset += pp.count;
    iOffset += pi.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * A rounded rectangle in the XY plane, centred on the origin. `radius` is
 * clamped so a caller cannot ask for a corner larger than the rectangle.
 */
export function roundedRect(width: number, height: number, radius: number): THREE.Shape {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const r = Math.min(radius, hw * 0.999, hh * 0.999);
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

/** An arbitrary closed polygon in XY, given as flat [x0,y0, x1,y1, …]. */
export function polyShape(points: readonly number[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(points[0]!, points[1]!);
  for (let i = 2; i < points.length; i += 2) s.lineTo(points[i]!, points[i + 1]!);
  s.closePath();
  return s;
}

/**
 * Extrude a 2D profile along Z and centre the result on the origin, with a real
 * machining chamfer on both end faces. `bevel` is in metres; 0.0006 is a
 * plausible 0.6 mm break on a milled aluminium edge.
 */
export function extrude(shape: THREE.Shape, depth: number, bevel = 0.0006, curveSegments = 6): THREE.BufferGeometry {
  const b = Math.min(bevel, depth * 0.24);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2,
    bevelEnabled: b > 1e-5,
    bevelSize: b,
    bevelThickness: b,
    bevelSegments: 2,
    curveSegments,
    steps: 1,
  });
  g.translate(0, 0, -(depth - b * 2) * 0.5 - b);
  return normalise(g);
}

/** A bevelled box centred on the origin, extruded along Z. */
export function bevelBox(width: number, height: number, depth: number, bevel = 0.0008): THREE.BufferGeometry {
  return extrude(roundedRect(width, height, bevel * 2.2), depth, bevel, 3);
}

/**
 * Lathe a profile about the Z axis (so it points down the bore like everything
 * else in weapon space). `profile` is [radius, z] pairs, muzzle-ward last.
 */
export function lathe(profile: readonly (readonly [number, number])[], segments = 20): THREE.BufferGeometry {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-5), z));
  const g = new THREE.LatheGeometry(pts, segments);
  // LatheGeometry revolves about +Y; the bore is -Z, so stand it up down the bore.
  g.rotateX(-Math.PI * 0.5);
  return normalise(g);
}

/** A tube down Z: constant radius, capped, cheap. */
export function tube(radius: number, length: number, segments = 18): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
  g.rotateX(Math.PI * 0.5);
  return normalise(g);
}

/** A capsule down Z — fingers, forearms, anything organic. */
export function capsuleZ(radius: number, length: number, radialSegments = 10): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 1e-4), 3, radialSegments);
  g.rotateX(Math.PI * 0.5);
  return normalise(g);
}

/**
 * A picatinny rail: `teeth` recoil slots cut as a comb of raised blocks. This is
 * the single highest-value detail on a viewmodel — it is the feature the eye
 * uses to judge scale, and a rail rendered as one smooth bar is the classic
 * "the gun is a grey box" tell.
 */
export function picatinny(length: number, width: number, teeth: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // The rail base: a truncated wedge, wider at the bottom, so the 45° clamping
  // faces catch a specular line the way a real rail does.
  parts.push(
    place(
      extrude(polyShape([-width * 0.5, 0, width * 0.5, 0, width * 0.38, 0.0042, -width * 0.38, 0.0042]), length, 0.0004),
      [0, 0, 0],
    ),
  );
  const pitch = length / teeth;
  for (let i = 0; i < teeth; i++) {
    const z = -length * 0.5 + pitch * (i + 0.5);
    parts.push(place(bevelBox(width * 0.76, 0.0026, pitch * 0.62, 0.0004), [0, 0.0055, z]));
  }
  return mergeParts(parts);
}

/**
 * A ring of `count` slats around the Z axis — the M-LOK/vented handguard
 * silhouette. Real handguards are mostly holes; modelling the holes as absent
 * slats instead of a smooth tube is what makes the silhouette read.
 */
export function slattedShell(
  radiusInner: number,
  thickness: number,
  length: number,
  count: number,
  gapFraction: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const arc = (Math.PI * 2) / count;
  const width = 2 * radiusInner * Math.tan(arc * 0.5) * (1 - gapFraction);
  for (let i = 0; i < count; i++) {
    const a = arc * i;
    const g = bevelBox(width, thickness, length, 0.0005);
    place(g, [Math.sin(a) * (radiusInner + thickness * 0.5), Math.cos(a) * (radiusInner + thickness * 0.5), 0], [0, 0, -a]);
    parts.push(g);
  }
  return mergeParts(parts);
}

/**
 * A shallow spherical combiner window, facing +Z (the eye).
 *
 * A flat pane is why the optic read as an opaque plate: one constant normal
 * means one constant Fresnel term, so there is no rim brightening, no eye-box
 * gradient and nothing anywhere on it that says "glass" rather than "quad".
 * A real reflex combiner is a section of a sphere — that is how it collimates
 * the reticle to infinity — and the curvature is what makes the reflectance
 * climb toward the edge of the aperture.
 *
 * `sagitta` is the bulge at the centre in metres; for a 40 mm aperture on a
 * 75 mm radius it is r²/2R ≈ 2.7 mm, which is the real number for this class of
 * sight and is also, conveniently, the amount that reads.
 */
export function domePane(width: number, height: number, sagitta: number, segments = 12): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, segments, segments);
  const position = g.getAttribute('position');
  const hw = width * 0.5;
  const hh = height * 0.5;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) / hw;
    const y = position.getY(i) / hh;
    position.setZ(i, sagitta * (1 - Math.min(1, x * x + y * y)));
  }
  g.computeVertexNormals();
  return normalise(g);
}

/**
 * REPROJECT UVs AS A BOX MAP IN WEAPON SPACE, IN METRES.
 *
 * This is not a nicety — it is the single thing standing between the viewmodel
 * and the "flat wedge covered in lichen" read. Every primitive above inherits
 * three's own UV generator, and those generators disagree violently about what
 * a UV unit means: `ExtrudeGeometry` emits the SHAPE's coordinates (metres,
 * so a 44 mm receiver spans 0.044 of a repeat), while `CylinderGeometry` and
 * `LatheGeometry` emit 0..1 over the whole surface (so one texture repeat is
 * stretched down 255 mm of barrel and wrapped around 60 mm of circumference —
 * a 4:1 anisotropic smear). The uber material reads `uv` as WORLD METRES
 * (`iron-material.ts`: `ironUv = vIronUv / metresPerRepeat`), so the barrel got
 * one blown-up blotch of the 2.6 m rusted-metal bake dragged along its axis.
 *
 * A box map fixes both at once: texel density is uniform across every part of
 * every weapon, and it is the SAME density on the magazine as on the rail.
 *
 * The axis convention is deliberate and load-bearing. On the four faces whose
 * dominant normal is ±X or ±Y — which is nearly the whole visible surface of a
 * rifle — `u` runs down the BORE (weapon-space z). That is what lets the
 * surface shader draw machining and brushing streaks ALONG the receiver rather
 * than across it, and lets it fade carbon fouling in toward the muzzle from a
 * single coordinate. Only the muzzle-facing and breech-facing caps use (x, y).
 *
 * Call it LAST, after every `place()`, so the projection is in weapon space and
 * two parts that touch agree about where the pattern is.
 */
export function boxProjectUv(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  normalise(geometry);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    if (az >= ax && az >= ay) uv.setXY(i, x, y);
    else if (ax >= ay) uv.setXY(i, z, y);
    else uv.setXY(i, z, x);
  }
  uv.needsUpdate = true;
  return geometry;
}

/** Small raised cylinder — screw heads, pins, sling points, gas block detail. */
export function stud(radius: number, height: number, segments = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius * 1.04, height, segments, 1, false);
  g.rotateX(Math.PI * 0.5);
  return normalise(g);
}
