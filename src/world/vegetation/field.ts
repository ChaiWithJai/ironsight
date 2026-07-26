/**
 * The vegetation runtime: instance management, LOD ladders, camera-relative
 * grass tiles and the CPU whole-plant sway. OWNER: VEG.
 *
 * HOW WIND IS SPLIT BETWEEN CPU AND GPU, ONCE, HERE
 * -------------------------------------------------
 * Wind is hierarchical in nature and it is hierarchical in this implementation,
 * which is what stops the two halves double-counting:
 *
 *   whole-plant lean   → the INSTANCE MATRIX
 *   per-leaf flutter   → the vertex DEFORM CHUNK (materials.ts)
 *
 * For a tree the instance matrix is re-composed every frame from the wind
 * field, so the trunk genuinely sways; a few hundred trees is nothing. For
 * grass — tens of thousands of instances — the instance matrix carries only the
 * plant's permanent wind-shaped growth pose, sampled at `WIND_POSE_TIME`, and
 * the deform carries the entire travelling gust as `offset(t) − offset(0)`. The
 * two compose to exactly `offset(t)`.
 *
 * WHY THE GRASS BUFFER IS NOT REBUILT EVERY FRAME
 * -----------------------------------------------
 * 15 000 instance matrices is 960 kB of upload. Rebuilding that at 60 Hz is
 * 58 MB/s of bus traffic for a field that has not changed. The buffer is
 * therefore rebuilt only when the camera has moved far enough to change which
 * tiles and which LODs are in play (2.5 m, or 3.5° of yaw), or when an
 * exclusion, disturbance or scorch changed the field. Under the capture harness
 * the camera is frozen, so it is built exactly once.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type FrameCtx,
  type QualitySettings,
  type Rng,
  type SceneGraph,
} from '@/engine/types';
import type { PlantAsset } from '@/world/vegetation/plants';
import type { GrassAssets } from '@/world/vegetation/grass';
import type { VegMaterials } from '@/world/vegetation/materials';
import { ExclusionField, VegMasks, hash2, type Ground, type SpeciesId } from '@/world/vegetation/scatter';
import { WIND_POSE_TIME, WindField, type WindSample } from '@/world/vegetation/wind';

const UP = new THREE.Vector3(0, 1, 0);
const GRASS_TILE = 8;
const MAT_TILE = 16;
/** Clusters per m² at densityScale 1. Dry coastal ground, not a lawn. */
const CLUSTERS_PER_M2 = 6.0;
const MATS_PER_TILE = 14;
/** Candidate ground samples per grass tile edge. 5×5 over 8 m = 2 m resolution. */
const GROUND_GRID = 5;

interface Placed {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Stable per-instance random, 0..1. Drives the distance fade and the tint. */
  rand: number;
  tint: number;
}

interface Tile {
  readonly grass: Placed[];
  readonly mats: Placed[];
}

/** One instanced draw plus the scratch it needs to be refilled. */
class InstanceSet {
  readonly mesh: THREE.InstancedMesh;
  count = 0;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    name: string,
    castShadow = true,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, capacity));
    this.mesh.name = name;
    this.mesh.count = 0;
    // Shadow casting is the single most expensive thing vegetation does: every
    // caster is re-rasterised into the cascades. Only the LODs whose shadow is
    // individually READABLE cast one — past ~40 m a tuft's shadow is smaller
    // than a shadow-map texel and all it contributes is aliasing and cost. The
    // ground-hugging layers never cast at all: at an 11° sun a flat mat casts a
    // 20 m smear across the terrain it is lying on.
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    // The instance list is already distance- and frustum-limited on the CPU;
    // three's own test would use a bounding sphere over every instance, which
    // for a camera-relative field is the whole field and never culls anything.
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  begin(): void {
    this.count = 0;
  }

  push(m: THREE.Matrix4, colour: THREE.Color): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.count, m);
    this.mesh.setColorAt(this.count, colour);
    this.count++;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }
}

interface TreeInstance {
  readonly species: SpeciesId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly tiltX: number;
  readonly tiltZ: number;
  readonly rand: number;
  readonly tint: number;
}

export interface VegStats {
  grass: number;
  trees: number;
  impostors: number;
  drawCalls: number;
}

export class VegetationField {
  readonly stats: VegStats = { grass: 0, trees: 0, impostors: 0, drawCalls: 0 };

  private readonly group: THREE.Group;
  private readonly grassSets: InstanceSet[] = [];
  private thatchSet!: InstanceSet;
  private matSet!: InstanceSet;
  /** [species][lod] → foliage / wood draws. */
  private readonly treeFoliage = new Map<SpeciesId, InstanceSet[]>();
  private readonly treeWood = new Map<SpeciesId, InstanceSet[]>();

  private readonly tiles = new Map<number, Tile>();
  private readonly tileOrder: number[] = [];
  private trees: TreeInstance[] = [];
  private treesBuilt = false;

  private readonly lastBuildPos = new THREE.Vector3(1e9, 1e9, 1e9);
  private readonly lastBuildFwd = new THREE.Vector3(0, 0, 1);
  private lastExclusionRevision = -1;
  private dirty = true;

  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly colour = new THREE.Color();
  private readonly camFwd = new THREE.Vector3();
  private readonly wind: WindSample = { x: 0, z: 0, speed: 0 };
  private readonly ground: Ground = { height: 0, slope: 0, shore: 0, moisture: 0 };
  private readonly groundGrid: Ground[] = [];

  constructor(
    scene: SceneGraph,
    private readonly plants: Record<string, PlantAsset>,
    private readonly grass: GrassAssets,
    private readonly materials: VegMaterials,
    private readonly masks: VegMasks,
    private readonly exclusions: ExclusionField,
    private readonly windField: WindField,
    private readonly settings: QualitySettings,
  ) {
    this.group = scene.group(SceneGroup.Vegetation);
    for (let i = 0; i < GROUND_GRID * GROUND_GRID; i++) {
      this.groundGrid.push({ height: 0, slope: 0, shore: 0, moisture: 0 });
    }

    const budget = Math.round(
      Math.min(18_000, Math.max(2_400, this.settings.vegetation.grassInstances / 5)) *
        this.settings.vegetation.densityScale,
    );
    // 12 / 30 / 58 %. That split falls out of area: the near ring is a small
    // disc of the field and the far ring is most of it, so the expensive LOD is
    // only ever paid for a few hundred tufts.
    const split = [0.12, 0.30, 0.58];
    for (let lod = 0; lod < 3; lod++) {
      const set = new InstanceSet(
        this.grass.cluster[lod],
        this.materials.material.grass,
        Math.ceil(budget * split[lod] * 1.25),
        `veg.grass.lod${lod}`,
        lod < 2,
      );
      this.grassSets.push(set);
      this.attach(scene, set.mesh, RenderLayer.Vegetation);
    }
    this.thatchSet = new InstanceSet(
      this.grass.thatch,
      this.materials.material.grass,
      Math.ceil(budget * 0.85),
      'veg.thatch',
      false,
    );
    this.attach(scene, this.thatchSet.mesh, RenderLayer.Vegetation);

    this.matSet = new InstanceSet(this.grass.mat, this.materials.material.mat, 5_000, 'veg.mat', false);
    this.attach(scene, this.matSet.mesh, RenderLayer.Vegetation);

    for (const id of ['palm', 'olive', 'scrub', 'agave'] as SpeciesId[]) {
      const plant = this.plants[id];
      const caps = id === 'scrub' ? [280, 650, 1200] : id === 'agave' ? [200, 450, 850] : [70, 150, 320];
      const fol: InstanceSet[] = [];
      const wood: InstanceSet[] = [];
      for (let lod = 0; lod < 3; lod++) {
        const material = id === 'palm' ? this.materials.material.frond : this.materials.material.leaf;
        const f = new InstanceSet(plant.foliage[lod], material, caps[lod], `veg.${id}.f${lod}`, lod < 2);
        fol.push(f);
        this.attach(scene, f.mesh, lod === 2 ? RenderLayer.Impostor : RenderLayer.Vegetation);
        const woodGeo = plant.wood[lod];
        const hasWood = (woodGeo.getIndex()?.count ?? 0) > 0;
        const w = new InstanceSet(
          hasWood ? woodGeo : plant.foliage[lod],
          this.materials.material.bark,
          hasWood ? caps[lod] : 1,
          `veg.${id}.w${lod}`,
          lod < 2,
        );
        if (!hasWood) w.mesh.visible = false;
        wood.push(w);
        this.attach(scene, w.mesh, lod === 2 ? RenderLayer.Impostor : RenderLayer.Vegetation);
      }
      this.treeFoliage.set(id, fol);
      this.treeWood.set(id, wood);
    }
  }

  private attach(scene: SceneGraph, mesh: THREE.InstancedMesh, layer: RenderLayer): void {
    this.group.add(mesh);
    scene.addDynamic(mesh, layer);
  }

  /**
   * DAY-0 SHADOW COMPATIBILITY, and it removes itself.
   *
   * `addDynamic` puts us on `RenderLayer.Vegetation`, which is correct and is
   * what RCORE's forward and shadow passes will select. Until those passes
   * exist the graph falls back to one straight `renderer.render()`, and three's
   * own shadow-map pass tests objects against the SHADOW camera's layer mask —
   * which is layer 0. On that path vegetation would cast no shadow at all, and
   * a grass field with no shadows is the single most obvious thing wrong with a
   * frame. Enabling layer 0 as well costs nothing there (it is one render call
   * either way) and is dropped the moment the real graph is registered.
   */
  reconcileWithGraph(passCount: number): void {
    const dayZero = passCount === 0;
    this.group.traverse((o) => {
      if (dayZero) o.layers.enable(RenderLayer.WorldOpaque as number);
      else o.layers.disable(RenderLayer.WorldOpaque as number);
    });
  }

  markDirty(): void {
    this.dirty = true;
  }

  /* ------------------------------------------------------------- tile source */

  private tileKey(tx: number, tz: number, salt: number): number {
    return (((tx & 0x7ff) << 12) | (tz & 0x7ff)) * 4 + salt;
  }

  private tile(tx: number, tz: number): Tile {
    const key = this.tileKey(tx, tz, 0);
    const hit = this.tiles.get(key);
    if (hit) return hit;

    const grass: Placed[] = [];
    const mats: Placed[] = [];
    const ox = tx * GRASS_TILE;
    const oz = tz * GRASS_TILE;

    // Ground properties on a 2 m grid, shared by every candidate in the cell.
    // The mask varies on a 100 m scale; sampling it per blade would cost eleven
    // analytic terrain evaluations per tuft for an answer that does not change.
    for (let j = 0; j < GROUND_GRID; j++) {
      for (let i = 0; i < GROUND_GRID; i++) {
        this.masks.sample(
          ox + (i / (GROUND_GRID - 1)) * GRASS_TILE,
          oz + (j / (GROUND_GRID - 1)) * GRASS_TILE,
          this.groundGrid[j * GROUND_GRID + i],
        );
      }
    }

    const density = this.settings.vegetation.densityScale;
    const candidates = Math.round(GRASS_TILE * GRASS_TILE * CLUSTERS_PER_M2 * density);
    for (let k = 0; k < candidates; k++) {
      const rx = hash2(tx * 977 + k, tz * 397, 0x9151);
      const rz = hash2(tx * 331, tz * 811 + k, 0x2f19);
      const x = ox + rx * GRASS_TILE;
      const z = oz + rz * GRASS_TILE;
      const gi =
        Math.min(GROUND_GRID - 1, Math.floor(rz * GROUND_GRID)) * GROUND_GRID +
        Math.min(GROUND_GRID - 1, Math.floor(rx * GROUND_GRID));
      const g = this.groundGrid[gi];
      const p = this.masks.grassDensity(g);
      if (p <= 0.02) continue;
      const accept = hash2(tx * 61 + k, tz * 7919 + k, 0x77d1);
      if (accept > p) continue;

      const y = this.masks.heightAt(x, z);
      grass.push({
        x,
        y,
        z,
        yaw: hash2(k, tx * 13 + tz * 29, 0x1234) * Math.PI * 2,
        // Scale variation is the cheapest anti-repetition there is and the
        // absence of it is the classic "stamped" foliage look.
        scale: 0.68 + hash2(k * 3, tx + tz * 5, 0xa731) * 0.72,
        rand: hash2(k * 7 + 3, tx * 3 - tz, 0x51ab),
        // Greener where it is damp, straw where it is not — the tint carries the
        // moisture mask that the density mask also carries, so the two agree.
        tint: g.moisture,
      });
    }

    this.tiles.set(key, { grass, mats });
    this.tileOrder.push(key);
    // Bounded cache. 900 grass tiles is a 240 m square of retained field, well
    // past any draw distance, and evicting in insertion order is stable.
    while (this.tileOrder.length > 900) {
      const dead = this.tileOrder.shift();
      if (dead !== undefined) this.tiles.delete(dead);
    }
    return this.tiles.get(key) as Tile;
  }

  private matTile(tx: number, tz: number): Placed[] {
    const key = this.tileKey(tx, tz, 1);
    const hit = this.tiles.get(key);
    if (hit) return hit.mats;

    const mats: Placed[] = [];
    const ox = tx * MAT_TILE;
    const oz = tz * MAT_TILE;
    for (let k = 0; k < MATS_PER_TILE; k++) {
      const rx = hash2(tx * 149 + k, tz * 619, 0xb105);
      const rz = hash2(tx * 733, tz * 271 + k, 0x3e77);
      const x = ox + rx * MAT_TILE;
      const z = oz + rz * MAT_TILE;
      const g = this.masks.sample(x, z, this.ground);
      const p = this.masks.grassDensity(g);
      if (p <= 0.05) continue;
      if (hash2(tx + k * 31, tz - k * 17, 0xd00d) > p * 1.15) continue;
      mats.push({
        x,
        y: this.masks.heightAt(x, z),
        z,
        yaw: hash2(k, tx * 5 - tz, 0x8f2b) * Math.PI * 2,
        scale: 1.3 + hash2(k * 11, tx * 2 + tz, 0x44c1) * 2.0,
        rand: hash2(k * 5, tx - tz * 3, 0x9ab2),
        tint: g.moisture,
      });
    }
    this.tiles.set(key, { grass: [], mats });
    this.tileOrder.push(key);
    return mats;
  }

  /* ------------------------------------------------------------ tree scatter */

  /**
   * Built once, after boot, so LEVEL's exclusion volumes are all in — LEVEL is
   * constructed AFTER us and registers them from its own `afterBoot`, which runs
   * after ours. Doing this in the factory body would plant a palm inside every
   * building in the town.
   */
  buildTrees(rng: Rng): void {
    if (this.treesBuilt) return;
    this.treesBuilt = true;
    const out: TreeInstance[] = [];
    const bounds = { minX: -400, minZ: -400, maxX: 400, maxZ: 400 };
    const density = this.settings.vegetation.densityScale;

    const passes: { id: SpeciesId; spacing: number; cap: number }[] = [
      { id: 'palm', spacing: 21, cap: 130 },
      { id: 'olive', spacing: 24, cap: 220 },
      { id: 'scrub', spacing: 13, cap: 900 },
      { id: 'agave', spacing: 19, cap: 460 },
    ];

    for (const pass of passes) {
      const r = rng.fork(`scatter.${pass.id}`);
      const cells: TreeInstance[] = [];
      for (let z = bounds.minZ; z < bounds.maxZ; z += pass.spacing) {
        for (let x = bounds.minX; x < bounds.maxX; x += pass.spacing) {
          // Jittered grid rather than pure random: a Poisson-ish distribution
          // with no clumps and no holes, for one hash instead of a dart throw.
          const px = x + r.range(0.05, 0.95) * pass.spacing;
          const pz = z + r.range(0.05, 0.95) * pass.spacing;
          const g = this.masks.sample(px, pz, this.ground);
          const p = this.masks.speciesDensity(pass.id, g) * density;
          if (p <= 0.01 || r.next() > p) continue;
          if (this.exclusions.factor(px, pz) < 0.55) continue;

          const plant = this.plants[pass.id];
          // Slope-lying species lie back into the hill; palms and olives grow
          // vertical no matter what they are standing on, which is a real and
          // very readable difference.
          const layback = pass.id === 'scrub' ? 0.55 : pass.id === 'agave' ? 0.7 : 0.12;
          const hx = this.masks.heightAt(px + 1.5, pz) - this.masks.heightAt(px - 1.5, pz);
          const hz = this.masks.heightAt(px, pz + 1.5) - this.masks.heightAt(px, pz - 1.5);
          cells.push({
            species: pass.id,
            x: px,
            y: this.masks.heightAt(px, pz) - plant.height * 0.012,
            z: pz,
            yaw: r.range(0, Math.PI * 2),
            scale: 0.74 + r.next() * 0.62,
            tiltX: (-hx / 3) * layback,
            tiltZ: (-hz / 3) * layback,
            rand: r.next(),
            tint: g.moisture,
          });
          if (cells.length >= pass.cap) break;
        }
        if (cells.length >= pass.cap) break;
      }
      for (const c of cells) out.push(c);
    }
    this.trees = out;
    this.stats.trees = out.length;
    this.dirty = true;
  }

  /* -------------------------------------------------------------- per frame */

  update(ctx: FrameCtx): void {
    const cam = ctx.camera.position;
    this.camFwd.set(0, 0, -1).applyQuaternion(ctx.camera.rotation);

    if (this.exclusions.revision !== this.lastExclusionRevision) {
      this.lastExclusionRevision = this.exclusions.revision;
      this.dirty = true;
    }
    if (this.exclusions.expire(ctx.time)) this.dirty = true;

    const moved = this.lastBuildPos.distanceToSquared(cam) > 2.5 * 2.5;
    const turned = this.lastBuildFwd.dot(this.camFwd) < 0.998;
    if (moved || turned) this.dirty = true;

    // Trees re-pose EVERY frame: this is the CPU half of the wind split and it
    // is what makes a still frame contain evidence of motion. A few hundred
    // matrices is far below the noise floor of the frame.
    this.updateTrees(ctx);

    if (this.dirty) {
      this.rebuildGrass(ctx);
      this.lastBuildPos.copy(cam);
      this.lastBuildFwd.copy(this.camFwd);
      this.dirty = false;
    }

    let draws = 0;
    for (const s of this.grassSets) if (s.count > 0) draws++;
    if (this.thatchSet.count > 0) draws++;
    if (this.matSet.count > 0) draws++;
    let impostors = 0;
    for (const sets of [this.treeFoliage, this.treeWood]) {
      for (const list of sets.values()) {
        for (let lod = 0; lod < list.length; lod++) {
          if (list[lod].count === 0) continue;
          draws++;
          if (lod === 2) impostors += list[lod].count;
        }
      }
    }
    this.stats.drawCalls = draws;
    this.stats.impostors = impostors;
  }

  /**
   * Whether a point survives the view test. Kept generous (a 22° margin, and
   * everything inside 9 m regardless) because the buffer is only rebuilt every
   * few metres of camera motion and a tight cone would pop grass in at the edge
   * of frame between rebuilds.
   */
  private inView(x: number, y: number, z: number, cam: THREE.Vector3, cosLimit: number): boolean {
    const dx = x - cam.x;
    const dy = y - cam.y;
    const dz = z - cam.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 9) return true;
    return (dx * this.camFwd.x + dy * this.camFwd.y + dz * this.camFwd.z) / d > cosLimit;
  }

  /**
   * Cosine of the half-angle the CPU view test uses. Deliberately the real
   * horizontal half-FOV plus a 22° margin: the instance buffers are only rebuilt
   * every few metres of camera motion, and a tight cone would pop vegetation in
   * at the edge of frame between rebuilds.
   */
  private viewCone(ctx: FrameCtx): number {
    const halfFov = (ctx.camera.fovDeg * Math.PI) / 180 / 2;
    return Math.cos(Math.min(1.45, Math.atan(Math.tan(halfFov) * ctx.camera.aspect) + 0.38));
  }

  private rebuildGrass(ctx: FrameCtx): void {
    const cam = ctx.camera.position;
    const radius = this.settings.vegetation.grassRadius;
    const matRadius = Math.min(this.settings.vegetation.drawDistance, radius * 2.6);
    const cosLimit = this.viewCone(ctx);

    for (const s of this.grassSets) s.begin();
    this.thatchSet.begin();
    this.matSet.begin();

    // ---- blade clusters + thatch
    const t0 = Math.floor((cam.x - radius) / GRASS_TILE);
    const t1 = Math.floor((cam.x + radius) / GRASS_TILE);
    const u0 = Math.floor((cam.z - radius) / GRASS_TILE);
    const u1 = Math.floor((cam.z + radius) / GRASS_TILE);
    const lod0End = radius * 0.30;
    const lod1End = radius * 0.62;
    const fadeStart = radius * 0.80;
    let placed = 0;

    for (let tz = u0; tz <= u1; tz++) {
      for (let tx = t0; tx <= t1; tx++) {
        // Cheap tile reject before we pay for generation.
        const cx = (tx + 0.5) * GRASS_TILE - cam.x;
        const cz = (tz + 0.5) * GRASS_TILE - cam.z;
        if (Math.hypot(cx, cz) > radius + GRASS_TILE) continue;
        const tile = this.tile(tx, tz);
        for (let i = 0; i < tile.grass.length; i++) {
          const p = tile.grass[i];
          const d = Math.hypot(p.x - cam.x, p.z - cam.z);
          if (d > radius) continue;
          // Probabilistic distance fade against a STABLE per-instance random:
          // the field thins out over the last 20 % of its radius instead of
          // ending at a circle, and an instance never flickers because its
          // threshold does not change with the camera.
          if (d > fadeStart && p.rand < (d - fadeStart) / (radius - fadeStart)) continue;
          if (this.exclusions.factor(p.x, p.z) < 0.5) continue;
          if (!this.inView(p.x, p.y, p.z, cam, cosLimit)) continue;

          // RADIAL THINNING. The tile source is authored at the density the
          // NEAR field needs; carrying that density to the full radius would
          // spend three quarters of the instance budget on tufts under two
          // pixels tall. Thinning by a stable per-instance random costs nothing
          // and is invisible, because the mat layer is ramping in over exactly
          // the same interval.
          const keep = d < lod0End ? 1 : d < lod1End ? 0.68 : 0.32;
          if (keep < 1 && hash2(Math.round(p.x * 32), Math.round(p.z * 32), 0x3311) > keep) continue;

          const set = d < lod0End ? this.grassSets[0] : d < lod1End ? this.grassSets[1] : this.grassSets[2];
          this.composeGrass(p);
          this.tintGrass(p);
          set.push(this.m, this.colour);
          placed++;

          // Thatch fills the bare ground between tufts, close in only — past
          // 25 m the mat layer takes the job over for a fifth of the triangles.
          // THE CARPET. Bare soil between tufts is the difference between our
          // field and the reference's; the near field gets two thatch mats per
          // tuft, crossed, so the ground under the blades is itself vegetation.
          if (d < radius * 0.55 && this.thatchSet.count < this.thatchSet.capacity) {
            this.scl.setScalar(p.scale * 2.1);
            this.qYaw.setFromAxisAngle(UP, p.yaw + 1.1);
            this.m.compose(this.pos.set(p.x, p.y - 0.02, p.z), this.qYaw, this.scl);
            this.thatchSet.push(this.m, this.colour);
            if (d < radius * 0.3 && this.thatchSet.count < this.thatchSet.capacity) {
              this.scl.setScalar(p.scale * 1.7);
              this.qYaw.setFromAxisAngle(UP, p.yaw + 2.7);
              this.m.compose(this.pos.set(p.x + 0.18, p.y - 0.025, p.z - 0.14), this.qYaw, this.scl);
              this.thatchSet.push(this.m, this.colour);
            }
          }
        }
      }
    }

    // ---- distance mat
    const mt0 = Math.floor((cam.x - matRadius) / MAT_TILE);
    const mt1 = Math.floor((cam.x + matRadius) / MAT_TILE);
    const mu0 = Math.floor((cam.z - matRadius) / MAT_TILE);
    const mu1 = Math.floor((cam.z + matRadius) / MAT_TILE);
    for (let tz = mu0; tz <= mu1; tz++) {
      for (let tx = mt0; tx <= mt1; tx++) {
        const cx = (tx + 0.5) * MAT_TILE - cam.x;
        const cz = (tz + 0.5) * MAT_TILE - cam.z;
        if (Math.hypot(cx, cz) > matRadius + MAT_TILE) continue;
        for (const p of this.matTile(tx, tz)) {
          const d = Math.hypot(p.x - cam.x, p.z - cam.z);
          if (d > matRadius) continue;
          if (this.exclusions.factor(p.x, p.z) < 0.5) continue;
          if (!this.inView(p.x, p.y, p.z, cam, cosLimit)) continue;
          // THE HAND-OVER. Mats ramp in exactly where the blades ramp out, so
          // there is no radius at which the ground changes character — the one
          // artefact that makes every grass LOD scheme visible.
          const ramp = Math.min(1, Math.max(0, (d - radius * 0.22) / (radius * 0.5)));
          if (p.rand > 0.10 + ramp * 0.90) continue;
          this.scl.set(p.scale, 1, p.scale);
          this.qYaw.setFromAxisAngle(UP, p.yaw);
          this.m.compose(this.pos.set(p.x, p.y + 0.015, p.z), this.qYaw, this.scl);
          this.tintGrass(p);
          this.colour.multiplyScalar(0.92);
          this.matSet.push(this.m, this.colour);
        }
      }
    }

    for (const s of this.grassSets) s.end();
    this.thatchSet.end();
    this.matSet.end();
    this.stats.grass = placed;
  }

  /**
   * Grass instance transform: yaw, scale, and the PERMANENT wind-shaped growth
   * lean sampled at `WIND_POSE_TIME`. The travelling gust rides on top of this
   * in the deform chunk as a delta from the same reference time, so the two are
   * one continuous displacement rather than two competing ones.
   */
  private composeGrass(p: Placed): void {
    this.windField.evaluate(p.x, p.z, WIND_POSE_TIME, this.wind);
    const bend = this.windField.bend(this.wind.speed, 0.30) * 0.42;
    const inv = 1 / Math.max(1e-4, this.wind.speed);
    this.axis.set(this.wind.z * inv, 0, -this.wind.x * inv);
    // Individual plants disagree about how much they have been shaped: a field
    // where every blade leans by the same angle is a comb, not a meadow.
    this.q.setFromAxisAngle(this.axis, bend * (0.55 + p.rand * 0.9));
    this.qYaw.setFromAxisAngle(UP, p.yaw);
    this.q.multiply(this.qYaw);
    this.scl.set(p.scale, p.scale * (0.82 + p.rand * 0.42), p.scale);
    this.m.compose(this.pos.set(p.x, p.y - 0.03, p.z), this.q, this.scl);
  }

  private tintGrass(p: Placed): void {
    // Damp ground grows greener grass; dry ground bleaches to straw. ±12 % of
    // value on top, so no two tufts are the same colour.
    const green = 0.55 + p.tint * 0.55;
    const value = 0.86 + p.rand * 0.28;
    this.colour.setRGB(
      value * (1.18 - green * 0.30),
      value * (0.94 + green * 0.14),
      value * (0.62 + green * 0.30),
    );
  }

  private updateTrees(ctx: FrameCtx): void {
    const cam = ctx.camera.position;
    const draw = this.settings.vegetation.drawDistance;
    const bias = this.settings.vegetation.lodBias;
    const cosLimit = this.viewCone(ctx);
    for (const list of this.treeFoliage.values()) for (const s of list) s.begin();
    for (const list of this.treeWood.values()) for (const s of list) s.begin();

    for (const t of this.trees) {
      const d = Math.hypot(t.x - cam.x, t.z - cam.z);
      if (d > draw) continue;
      const plant = this.plants[t.species];
      // Test the crown, not the base: a palm whose trunk is behind the camera
      // still has fronds in the top of the frame, and popping those is far more
      // visible than the draw they cost.
      if (!this.inView(t.x, t.y + plant.height * t.scale * 0.6, t.z, cam, cosLimit)) continue;
      // Screen-space error, not raw distance: a palm and a scrub bush at 40 m
      // are not the same size and must not switch LOD at the same range. The
      // ranges are DELIBERATELY long — an 8 m palm holds full geometry to 40 m
      // and its branch LOD to 120 m. Switching earlier is the single fastest way
      // to fill the midground with the bare sticks that give procedural
      // vegetation away, and foliage tris are cheap next to that.
      const size = Math.min(2.4, Math.max(0.55, (plant.height * t.scale) / 4));
      const lod = d < (19 * size) / bias ? 0 : d < (58 * size) / bias ? 1 : 2;

      this.windField.evaluate(t.x, t.z, ctx.time, this.wind);
      const bend = this.windField.bend(this.wind.speed, plant.stiffness) * 0.30;
      const inv = 1 / Math.max(1e-4, this.wind.speed);
      // Whole-plant lean, blended with the static ground tilt.
      this.axis.set(this.wind.z * inv + t.tiltZ, 0, -this.wind.x * inv - t.tiltX);
      if (this.axis.lengthSq() < 1e-8) this.axis.set(1, 0, 0);
      this.axis.normalize();
      const tilt = Math.hypot(t.tiltX, t.tiltZ);
      this.q.setFromAxisAngle(this.axis, bend * (0.6 + t.rand * 0.8) + tilt);
      this.qYaw.setFromAxisAngle(UP, t.yaw);
      this.q.multiply(this.qYaw);
      this.scl.setScalar(t.scale);
      this.m.compose(this.pos.set(t.x, t.y, t.z), this.q, this.scl);

      // Species tint: olive foliage silvers on dry ground, scrub browns off.
      const v = 0.84 + t.rand * 0.32;
      const dry = 1 - t.tint;
      this.colour.setRGB(v * (1 + dry * 0.16), v * (1 - dry * 0.02), v * (1 - dry * 0.22));

      const fol = this.treeFoliage.get(t.species);
      const wood = this.treeWood.get(t.species);
      if (fol) fol[lod].push(this.m, this.colour);
      if (wood && wood[lod].mesh.visible) wood[lod].push(this.m, this.colour);
    }

    for (const list of this.treeFoliage.values()) for (const s of list) s.end();
    for (const list of this.treeWood.values()) for (const s of list) s.end();
  }

  /** 0..1 foliage density for AI vision and audio occlusion. */
  densityAt(x: number, z: number): number {
    const g = this.masks.sample(x, z, this.ground);
    const cover = this.masks.grassDensity(g) * 0.45 + this.masks.speciesDensity('scrub', g) * 0.55;
    return Math.min(1, cover * this.exclusions.factor(x, z));
  }

  dispose(): void {
    this.tiles.clear();
    this.tileOrder.length = 0;
  }
}
