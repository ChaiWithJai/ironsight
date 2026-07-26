/**
 * Component definitions shared by two or more lanes. CORE owns this file.
 *
 * A component that only one lane reads belongs in that lane. These are here
 * because damage (GAME) needs the health that weapons (WEAPONS) subtracts, the
 * renderer needs the transform that physics (PHYS) writes, and AI needs the team
 * that the game mode (GAME) assigns.
 */
import * as THREE from 'three';
import { Team, type ComponentDef, type EntityId, type TransformComponent, type Vec3 } from '@/engine/types';

/**
 * Interpolated transform. SIMULATION WRITES ONLY `curr`/`currRot`; the render
 * side lerps prev→curr by `FrameCtx.alpha`. Copying curr into prev is the job of
 * whoever advances the entity, once per tick, BEFORE writing the new curr.
 */
export const Transform: ComponentDef<TransformComponent> = {
  name: 'transform',
  create: () => ({
    prev: new THREE.Vector3(),
    curr: new THREE.Vector3(),
    prevRot: new THREE.Quaternion(),
    currRot: new THREE.Quaternion(),
    scale: 1,
  }),
};

export interface HealthComponent {
  current: number;
  max: number;
  /** Tick of the last damage event; drives regen delay and the hit indicator. */
  lastDamageTick: number;
  dead: boolean;
}

export const Health: ComponentDef<HealthComponent> = {
  name: 'health',
  create: () => ({ current: 100, max: 100, lastDamageTick: -1, dead: false }),
};

export interface TeamComponent {
  team: Team;
  /** Display name used by the killfeed and scoreboard. */
  name: string;
  squad: number;
}

export const TeamTag: ComponentDef<TeamComponent> = {
  name: 'team',
  create: () => ({ team: Team.Neutral, name: '', squad: 0 }),
};

export interface VelocityComponent {
  linear: Vec3;
  /** Ground-plane speed in m/s, cached so bob, footsteps and AI all agree. */
  groundSpeed: number;
}

export const Velocity: ComponentDef<VelocityComponent> = {
  name: 'velocity',
  create: () => ({ linear: new THREE.Vector3(), groundSpeed: 0 }),
};

/** Anything a bullet can hit and a bot can see. Kept minimal on purpose. */
export interface ActorComponent {
  eyeHeight: number;
  yaw: number;
  pitch: number;
  /** Body the character controller owns, or -1 before it is created. */
  bodyHandle: number;
  /** The entity currently controlling this actor (self for bots and the player). */
  controller: EntityId;
}

export const Actor: ComponentDef<ActorComponent> = {
  name: 'actor',
  create: () => ({ eyeHeight: 1.62, yaw: 0, pitch: 0, bodyHandle: -1, controller: 0 as EntityId }),
};

/** Every shared component, for reset sweeps and debug tooling. */
export const SHARED_COMPONENTS: readonly ComponentDef<unknown>[] = [
  Transform as ComponentDef<unknown>,
  Health as ComponentDef<unknown>,
  TeamTag as ComponentDef<unknown>,
  Velocity as ComponentDef<unknown>,
  Actor as ComponentDef<unknown>,
];
