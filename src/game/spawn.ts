/**
 * GAME — spawn selection and the safety test.
 *
 * OWNER: GAME.
 *
 * A Conquest spawn is three questions, in this order:
 *
 *   1. Is the CHOICE legal?   You cannot spawn on a flag you do not hold, or on
 *                             a squadmate who is dead, downed or in a firefight.
 *   2. Where would that PUT you?  A flag is a disc, not a point; a squadmate is
 *                             a person you must not appear inside.
 *   3. Is that spot SAFE?     No living enemy inside `SPAWN_ENEMY_RADIUS`, and
 *                             nobody with a sightline inside
 *                             `SPAWN_SIGHTLINE_RADIUS`.
 *
 * Getting (3) wrong is the single most rage-inducing failure in the genre, so it
 * is a hard reject rather than a score penalty — except at your own base, which
 * must ALWAYS produce an answer or the player is stuck on the deploy screen with
 * every option greyed out.
 */
import * as THREE from 'three';
import {
  Team,
  type CapturePointDef,
  type CapturePointRuntime,
  type EntityId,
  type PlayerState,
  type Rng,
  type Services,
  type SpawnChoice,
  type SpawnPointDef,
  type Vec3,
} from '@/engine/types';
import { MACRO_TERRAIN } from '@/engine/macro';
import {
  SPAWN_ENEMY_RADIUS,
  SPAWN_SCATTER,
  SPAWN_SIGHTLINE_RADIUS,
  SPAWN_SQUAD_OFFSET,
} from '@/game/tuning';
import type { WorldProbe } from '@/game/probe';

interface Candidate {
  readonly position: Vec3;
  readonly yaw: number;
  readonly linked: CapturePointDef['id'] | null;
  /** Metres to the nearest living enemy. `Infinity` when the map is empty. */
  threat: number;
  /** True when an enemy can see the spot. A hard reject on its own. */
  seen: boolean;
}

export class SpawnDirector {
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly candidates: Candidate[] = [];

  constructor(
    private readonly services: Services,
    private readonly probe: WorldProbe,
    private readonly rng: Rng,
  ) {}

  /**
   * Resolve a spawn choice into a validated point, or null if the choice is
   * illegal or unsafe. `points` is the mode's live capture state — passed in
   * rather than read back through the service so this stays a pure function of
   * its inputs and can be reasoned about in isolation.
   */
  choose(
    entity: EntityId,
    team: Team,
    choice: SpawnChoice,
    points: readonly Readonly<CapturePointRuntime>[],
  ): SpawnPointDef | null {
    this.candidates.length = 0;
    switch (choice.kind) {
      case 'squad':
        if (!this.gatherSquad(entity, team, choice.on)) return null;
        break;
      case 'point': {
        const runtime = points.find((p) => p.id === choice.point);
        // Held, or being held: you may not deploy onto a flag you do not own.
        if (!runtime || runtime.owner !== team || runtime.contested) return null;
        if (!this.gatherPoint(team, choice.point)) return null;
        break;
      }
      default:
        this.gatherBase(team, points);
        break;
    }
    if (this.candidates.length === 0) return null;

    this.scoreCandidates(entity, team);

    let best: Candidate | null = null;
    for (const c of this.candidates) {
      if (c.seen || c.threat < SPAWN_ENEMY_RADIUS) continue;
      if (!best || c.threat > best.threat) best = c;
    }

    if (!best) {
      // Base deployment must always succeed: pick the least bad rather than
      // leaving the player with nothing to click.
      if (choice.kind !== 'base') return null;
      for (const c of this.candidates) {
        if (!best || c.threat > best.threat) best = c;
      }
    }
    if (!best) return null;

    return {
      team,
      position: best.position.clone(),
      yaw: best.yaw,
      linkedPoint: best.linked,
    };
  }

  /* ------------------------------------------------------------ candidates */

  private push(position: Vec3, yaw: number, linked: CapturePointDef['id'] | null): void {
    // Snap to the ground, always. A spawn authored at a stale height either
    // drops the player two metres or buries them to the knees.
    position.y = this.probe.groundHeightAt(position.x, position.z) + 0.02;
    this.candidates.push({ position, yaw, linked, threat: Number.POSITIVE_INFINITY, seen: false });
  }

  private gatherBase(team: Team, points: readonly Readonly<CapturePointRuntime>[]): void {
    const level = this.services.level;
    for (const spawn of level.spawnPoints) {
      if (spawn.team !== team) continue;
      if (spawn.linkedPoint !== null) continue;
      // Scatter a handful of offsets per authored base spawn, so twelve bots
      // deploying in the same second do not stack into one capsule.
      for (let i = 0; i < SPAWN_SCATTER.length; i++) {
        const r = SPAWN_SCATTER[i];
        const angle = this.rng.next() * Math.PI * 2;
        this.push(
          this.tmpA
            .copy(spawn.position)
            .add(this.tmpB.set(Math.cos(angle) * r, 0, Math.sin(angle) * r))
            .clone(),
          spawn.yaw,
          null,
        );
      }
    }
    if (this.candidates.length > 0) return;

    // No authored base for this team. Fall back to a held flag, then to the
    // map edge — a team with nowhere to deploy is a stuck round, not an error.
    for (const p of points) {
      if (p.owner !== team) continue;
      if (this.gatherPoint(team, p.id)) return;
    }
    const bounds = MACRO_TERRAIN.bounds;
    const z = team === Team.Coalition ? bounds.maxZ * 0.45 : bounds.minZ * 0.25;
    this.push(new THREE.Vector3(0, 0, z), team === Team.Coalition ? Math.PI : 0, null);
  }

  private gatherPoint(team: Team, id: CapturePointDef['id']): boolean {
    const level = this.services.level;
    const def = level.capturePoints.find((p) => p.id === id);
    if (!def) return false;
    let added = false;
    for (const spawn of level.spawnPoints) {
      if (spawn.linkedPoint !== id || spawn.team !== team) continue;
      this.push(spawn.position.clone(), spawn.yaw, id);
      added = true;
    }
    // No authored spawn on this flag: ring the perimeter. Facing outward, so a
    // player deploying onto a held point is already looking at the approach.
    const ringCount = 5;
    for (let i = 0; i < ringCount; i++) {
      const angle = (i / ringCount) * Math.PI * 2 + this.rng.next() * 0.4;
      const r = def.radius * 0.72;
      this.push(
        new THREE.Vector3(def.centre.x + Math.cos(angle) * r, 0, def.centre.z + Math.sin(angle) * r),
        Math.atan2(-Math.cos(angle), -Math.sin(angle)) + Math.PI,
        id,
      );
      added = true;
    }
    return added;
  }

  private gatherSquad(entity: EntityId, team: Team, anchor: EntityId): boolean {
    if (anchor === entity) return false;
    const player = this.services.player;
    const state = player.stateOf(anchor);
    if (!state || !state.alive || state.downed === true) return false;
    if (state.team !== team) return false;

    // Behind them, relative to where they are looking: appearing in front of a
    // squadmate is how you eat their magazine.
    const back = this.tmpB.set(Math.sin(state.yaw), 0, Math.cos(state.yaw)).multiplyScalar(SPAWN_SQUAD_OFFSET);
    for (let i = 0; i < 3; i++) {
      const swing = (i - 1) * 0.9;
      const cos = Math.cos(swing);
      const sin = Math.sin(swing);
      const offset = this.tmpA.set(back.x * cos - back.z * sin, 0, back.x * sin + back.z * cos);
      this.push(offset.add(state.position).clone(), state.yaw, null);
    }
    return true;
  }

  /* ---------------------------------------------------------------- safety */

  private scoreCandidates(entity: EntityId, team: Team): void {
    const player = this.services.player;
    const enemies: Readonly<PlayerState>[] = [];
    for (const other of player.controlled) {
      if (other === entity) continue;
      const s = player.stateOf(other);
      if (!s || !s.alive || s.team === team || s.team === Team.Neutral) continue;
      enemies.push(s);
    }
    for (const c of this.candidates) {
      for (const enemy of enemies) {
        const d = enemy.position.distanceTo(c.position);
        if (d < c.threat) c.threat = d;
        if (d > SPAWN_SIGHTLINE_RADIUS || c.seen) continue;
        // Line of sight from the enemy's EYE to the spawning player's chest.
        const from = this.tmpA.set(enemy.position.x, enemy.position.y + enemy.eyeHeight, enemy.position.z);
        const to = this.tmpB.set(c.position.x, c.position.y + 1.1, c.position.z);
        if (this.probe.visibility(from, to) > 0.5) c.seen = true;
      }
    }
  }
}
