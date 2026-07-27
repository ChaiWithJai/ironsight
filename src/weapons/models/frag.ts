/**
 * The thrown frag grenade's mesh. WEAPONS owns this file.
 *
 * Built in code like everything else in `src/weapons/models/`, and deliberately
 * cheap: this is a 62 mm object that spends its whole life either tumbling past
 * at 20 m/s or lying in a gutter, so it gets ~500 triangles and no chamfers.
 *
 * IT REUSES THE VIEWMODEL'S MATERIALS AND CREATES NONE OF ITS OWN. The material
 * factory's permutation cap is the tightest budget in the repo — 48 of 160 are
 * already allocated at boot and a lane that quietly adds two more is how the cap
 * gets raised for everyone. `MaterialFactory.create` dedupes on
 * `id|features|layer`, so the grenade body drawing with `weapon.receiver` and
 * its fuze with `weapon.steel` costs exactly zero new programs — and it is also
 * correct, because a grenade body IS painted steel and a fuze assembly IS bare
 * steel, which is what those two chunks already describe.
 *
 * ORIENTATION: +Y is the fuze end, and the body is authored about the origin so
 * the physics sphere and the mesh share a centre. A grenade tumbles, so nothing
 * downstream may assume an up axis.
 */
import * as THREE from 'three';
import { boxProjectUv, mergeParts, normalise, place, tube } from '@/weapons/models/prim';
import type { RoleMaterials } from '@/weapons/viewmodel/materials';

/**
 * Body radius the geometry is authored at. The physics sphere uses
 * `ThrowableDef.radius`; this is the visual, and it is slightly larger so the
 * shell is never seen half-sunk into the ground it is resting on.
 */
const BODY_R = 0.033;
/** Ovoid: an M67 is 63 mm tall and 63 mm across, a Mk 2 is taller. Split it. */
const BODY_STRETCH = 1.14;

/**
 * A grenade is two draws, not one, because the two halves are different
 * materials and merging them would force one of them to be wrong. Two draws for
 * at most a handful of live grenades is not a budget anybody can measure.
 */
export interface FragMesh {
  readonly root: THREE.Object3D;
}

export function buildFragMesh(materials: RoleMaterials): FragMesh {
  const root = new THREE.Object3D();
  root.name = 'weapon.frag';

  /* ---- shell: an ovoid of painted steel --------------------------------- */
  const shell = new THREE.SphereGeometry(BODY_R, 16, 11);
  shell.scale(1, BODY_STRETCH, 1);
  // Box projection rather than the sphere's own UVs: the surface chunk reads a
  // world-scale grain and a spherical unwrap pinches it to nothing at the poles,
  // which reads as two shiny dots on an otherwise matte body.
  boxProjectUv(normalise(shell));
  root.add(new THREE.Mesh(shell, materials.receiver));

  /* ---- fuze assembly: cap, striker collar, spoon ------------------------ */
  const cap = BODY_R * BODY_STRETCH;
  const parts: THREE.BufferGeometry[] = [
    // `tube` lies down Z; stand each piece up onto Y.
    place(tube(BODY_R * 0.40, 0.013, 12), [0, cap * 0.86, 0], [Math.PI * 0.5, 0, 0]),
    place(tube(BODY_R * 0.52, 0.004, 12), [0, cap * 0.70, 0], [Math.PI * 0.5, 0, 0]),
    // The spoon: a 46 mm strap down one flank. It is the single feature that
    // makes a small dark ovoid read as a grenade rather than as a rock.
    place(
      new THREE.BoxGeometry(0.010, 0.046, 0.0022),
      [0, cap * 0.34, BODY_R * 0.92],
      [0.16, 0, 0],
    ),
    // Safety-ring pull, edge-on. Two triangles' worth of silhouette that the eye
    // uses to place the object's scale.
    place(new THREE.TorusGeometry(0.0075, 0.0011, 4, 10), [0.012, cap * 0.92, 0], [0, 0, Math.PI * 0.5]),
  ];
  const fuze = mergeParts(parts.map((g) => boxProjectUv(normalise(g))));
  root.add(new THREE.Mesh(fuze, materials.steel));

  return { root };
}
