/**
 * Posing and drawing the squad.
 *
 * OWNER: AI.
 *
 * One `InstancedMesh` per (team, LOD, part): 24 bots cost about twenty draws
 * instead of three hundred and fifty, and every bot still gets a full rigid
 * skeleton — hips, spine, head, four limb bones and a weapon — animated per
 * frame. Rigid-part animation rather than skinning is a deliberate trade: it is
 * exact, allocation-free, deterministic, and at the ranges bots are actually
 * seen the missing shoulder deformation is invisible next to the silhouette.
 *
 * All motion is derived from SIMULATION state (position, yaw, pitch, stance,
 * gait phase advanced in the tick, exposure, recoil, time of death), so two
 * captures of the same shot pose identically.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  Stance,
  Team,
  type FrameCtx,
  type PlayerState,
  type SceneGraph,
} from '@/engine/types';
import { Bone, type SoldierModel, type SoldierPart } from '@/ai/character/soldier';
import type { Bot } from '@/ai/bot';

interface Slot {
  mesh: THREE.InstancedMesh;
  bone: Bone;
  count: number;
}

const MATRIX = new THREE.Matrix4();

export class SoldierRenderer {
  private readonly root = new THREE.Group();
  /** `slots[team][lod]` — one entry per part of that LOD. */
  private readonly slots: Slot[][][] = [];
  private readonly bones: THREE.Object3D[] = [];
  private readonly boneRoot = new THREE.Object3D();
  private readonly maxPerSlot: number;

  constructor(
    private readonly model: SoldierModel,
    scene: SceneGraph,
    maxBots: number,
  ) {
    this.maxPerSlot = Math.max(1, maxBots);
    this.root.name = 'ai.soldiers';
    scene.group(SceneGroup.Characters).add(this.root);

    for (let team = 0; team < 2; team++) {
      const perLod: Slot[][] = [];
      for (let lod = 0; lod < model.lods.length; lod++) {
        const parts: Slot[] = [];
        for (const part of model.lods[lod].parts) {
          const mesh = new THREE.InstancedMesh(part.geometry, model.materials[team][part.material], this.maxPerSlot);
          mesh.name = `ai.soldier.t${team}.l${lod}.b${part.bone}`;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          mesh.count = 0;
          mesh.visible = false;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.root.add(mesh);
          parts.push({ mesh, bone: part.bone, count: 0 });
        }
        perLod.push(parts);
      }
      this.slots.push(perLod);
    }

    this.root.updateMatrixWorld(true);
    // No bounds: bots span the whole map and are re-posed every frame, so a
    // stale AABB would cull a squad that had walked out of it.
    scene.addDynamic(this.root, RenderLayer.WorldOpaque);
    this.buildSkeleton();
  }

  /** The scratch hierarchy every bot is posed through, one bone per node. */
  private buildSkeleton(): void {
    const parentOf: Record<number, number> = {
      [Bone.Hips]: Bone.Root,
      [Bone.Spine]: Bone.Hips,
      [Bone.Head]: Bone.Spine,
      [Bone.ArmUpperL]: Bone.Spine,
      [Bone.ArmLowerL]: Bone.ArmUpperL,
      [Bone.ArmUpperR]: Bone.Spine,
      [Bone.ArmLowerR]: Bone.ArmUpperR,
      [Bone.LegUpperL]: Bone.Hips,
      [Bone.LegLowerL]: Bone.LegUpperL,
      [Bone.LegUpperR]: Bone.Hips,
      [Bone.LegLowerR]: Bone.LegUpperR,
      [Bone.Weapon]: Bone.Spine,
    };
    this.bones[Bone.Root] = this.boneRoot;
    for (let b = Bone.Hips; b < Bone.Count; b++) {
      const node = new THREE.Object3D();
      node.matrixAutoUpdate = false;
      this.bones[b] = node;
    }
    for (let b = Bone.Hips; b < Bone.Count; b++) {
      this.bones[parentOf[b]].add(this.bones[b]);
    }
    this.boneRoot.matrixAutoUpdate = false;
  }

  /** Reset the per-frame instance counters. */
  private begin(): void {
    for (const perLod of this.slots) {
      for (const parts of perLod) {
        for (const slot of parts) slot.count = 0;
      }
    }
  }

  private end(): void {
    for (const perLod of this.slots) {
      for (const parts of perLod) {
        for (const slot of parts) {
          slot.mesh.count = slot.count;
          slot.mesh.visible = slot.count > 0;
          slot.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
  }

  update(ctx: FrameCtx, bots: readonly Bot[], stateOf: (bot: Bot) => Readonly<PlayerState> | null): void {
    this.begin();
    const camera = ctx.camera.position;
    for (const bot of bots) {
      const state = stateOf(bot);
      if (!state) continue;
      const dead = !state.alive || !bot.alive;
      if (dead && bot.deathTime >= 0 && ctx.time - bot.deathTime > 25) continue;

      const distance = Math.hypot(
        state.position.x - camera.x,
        state.position.y - camera.y,
        state.position.z - camera.z,
      );
      let lod = 0;
      while (lod < this.model.lods.length - 1 && distance > this.model.lods[lod].maxDistance) lod++;

      this.pose(bot, state, ctx.time, dead);
      const teamIndex = bot.team === Team.Insurgent ? 1 : 0;
      const parts = this.slots[teamIndex][lod];
      const defs = this.model.lods[lod].parts;
      for (let i = 0; i < parts.length; i++) {
        const slot = parts[i];
        if (slot.count >= this.maxPerSlot) continue;
        slot.mesh.setMatrixAt(slot.count, this.bones[defs[i].bone].matrixWorld);
        slot.count++;
      }
    }
    this.end();
  }

  /** World matrix of a bone from the LAST posed bot. Used for the hitbox stack. */
  boneMatrix(bone: Bone): THREE.Matrix4 {
    return this.bones[bone].matrixWorld;
  }

  /**
   * Pose the scratch skeleton for one bot. Everything here is a closed-form
   * function of simulation state — no springs, no per-frame integration — so
   * frame 32 of a capture is identical however many frames preceded it.
   */
  pose(bot: Bot, state: Readonly<PlayerState>, time: number, dead: boolean): void {
    const s = this.model.scale;
    const rest = this.model.rest;
    const bones = this.bones;

    const stanceDrop =
      state.stance === Stance.Crouch ? 0.3 * s : state.stance === Stance.Prone ? 0.62 * s : 0;
    const gait = bot.gaitSpeed;
    const phase = bot.gaitPhase;
    const bob = Math.sin(phase * 2) * 0.028 * gait;
    const deathT = dead && bot.deathTime >= 0 ? Math.min(1, (time - bot.deathTime) / 0.85) : 0;
    // Ease-out on the fall so the body decelerates into the ground instead of
    // snapping flat, which is the difference between "collapsed" and "deleted".
    const fall = deathT * deathT * (3 - 2 * deathT);

    this.boneRoot.position.set(state.position.x, state.position.y, state.position.z);
    this.boneRoot.rotation.set(fall * 1.35, state.yaw, fall * 0.35);
    this.boneRoot.scale.setScalar(1);
    this.boneRoot.updateMatrix();

    const hips = bones[Bone.Hips];
    hips.position.set(rest[Bone.Hips].x * s, rest[Bone.Hips].y * s - stanceDrop + bob - fall * 0.45 * s, rest[Bone.Hips].z * s);
    hips.rotation.set(
      state.stance === Stance.Prone ? -1.2 : 0,
      Math.sin(phase) * 0.09 * gait,
      Math.sin(phase) * 0.05 * gait,
    );

    // Torso: leans into the run, twists slightly against the hips, and rolls
    // out of cover when the bot peeks.
    const lean = 0.1 + gait * 0.16 + (state.sprinting ? 0.18 : 0);
    const peekRoll = bot.cover ? (bot.exposure - 0.5) * 0.5 * (bot.slot % 2 === 0 ? 1 : -1) : 0;
    const spine = bones[Bone.Spine];
    spine.position.set(0, rest[Bone.Spine].y * s + stanceDrop * 0.22, 0);
    spine.rotation.set(lean - state.pitch * 0.22, -Math.sin(phase) * 0.12 * gait, peekRoll);

    const head = bones[Bone.Head];
    head.position.set(0, rest[Bone.Head].y * s, 0);
    // The head takes the rest of the pitch the spine did not, so the bot looks
    // where he is aiming rather than aiming with his chest.
    head.rotation.set(-(state.pitch * 0.65) - lean * 0.5 + fall * 0.3, Math.sin(phase * 0.5) * 0.04, -peekRoll * 0.4);

    // Arms hold the rifle: a fixed carry pose that tightens when engaged.
    const ready = bot.trigger || bot.exposure > 0.5 || bot.settle > 0.5 ? 1 : 0.55;
    const recoilKick = Math.min(1, bot.recoil * 0.5);
    const armUpperL = bones[Bone.ArmUpperL];
    armUpperL.position.set(rest[Bone.ArmUpperL].x * s, rest[Bone.ArmUpperL].y * s, rest[Bone.ArmUpperL].z * s);
    armUpperL.rotation.set(-1.15 * ready - state.pitch * 0.35, 0.42 * ready, 0.5 * ready);
    const armLowerL = bones[Bone.ArmLowerL];
    armLowerL.position.set(0, rest[Bone.ArmLowerL].y * s, 0);
    armLowerL.rotation.set(-0.95 * ready + recoilKick * 0.1, 0.25 * ready, 0);

    const armUpperR = bones[Bone.ArmUpperR];
    armUpperR.position.set(rest[Bone.ArmUpperR].x * s, rest[Bone.ArmUpperR].y * s, rest[Bone.ArmUpperR].z * s);
    armUpperR.rotation.set(-1.05 * ready - state.pitch * 0.3 + recoilKick * 0.12, -0.28 * ready, -0.62 * ready);
    const armLowerR = bones[Bone.ArmLowerR];
    armLowerR.position.set(0, rest[Bone.ArmLowerR].y * s, 0);
    armLowerR.rotation.set(-1.35 * ready, -0.3 * ready, 0);

    // Legs: a two-bone walk cycle. Thigh swings, shin trails and folds.
    const swing = Math.sin(phase) * 0.62 * gait;
    const counter = Math.sin(phase + Math.PI) * 0.62 * gait;
    const kneeL = Math.max(0, -Math.sin(phase - 0.55)) * 1.25 * gait;
    const kneeR = Math.max(0, -Math.sin(phase + Math.PI - 0.55)) * 1.25 * gait;
    const crouchFold = state.stance === Stance.Crouch ? 0.55 : state.stance === Stance.Prone ? 1.1 : 0;

    const legUpperL = bones[Bone.LegUpperL];
    legUpperL.position.set(rest[Bone.LegUpperL].x * s, rest[Bone.LegUpperL].y * s, rest[Bone.LegUpperL].z * s);
    legUpperL.rotation.set(swing - crouchFold - fall * 0.5, 0, 0.03);
    const legLowerL = bones[Bone.LegLowerL];
    legLowerL.position.set(0, rest[Bone.LegLowerL].y * s, 0);
    legLowerL.rotation.set(kneeL + crouchFold * 1.5, 0, 0);

    const legUpperR = bones[Bone.LegUpperR];
    legUpperR.position.set(rest[Bone.LegUpperR].x * s, rest[Bone.LegUpperR].y * s, rest[Bone.LegUpperR].z * s);
    legUpperR.rotation.set(counter - crouchFold - fall * 0.5, 0, -0.03);
    const legLowerR = bones[Bone.LegLowerR];
    legLowerR.position.set(0, rest[Bone.LegLowerR].y * s, 0);
    legLowerR.rotation.set(kneeR + crouchFold * 1.5, 0, 0);

    // The weapon rides the chest at the shoulder pocket and takes the recoil.
    const weapon = bones[Bone.Weapon];
    weapon.position.set(
      rest[Bone.Weapon].x * s,
      rest[Bone.Weapon].y * s - recoilKick * 0.01,
      rest[Bone.Weapon].z * s + recoilKick * 0.045,
    );
    weapon.rotation.set(-state.pitch * 0.85 + recoilKick * 0.16 - (1 - ready) * 0.55, 0.06, 0);

    for (let b = Bone.Hips; b < Bone.Count; b++) {
      const node = bones[b];
      node.quaternion.setFromEuler(node.rotation);
      node.updateMatrix();
    }
    this.boneRoot.updateMatrixWorld(true);
    void MATRIX;
  }

  clear(): void {
    this.begin();
    this.end();
  }
}
