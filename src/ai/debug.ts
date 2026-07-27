/**
 * The AI debug draw: corridors, goals, cover slots and sight lines.
 *
 * OWNER: AI.
 *
 * `src/shots/ai.ts` must prove "a bot squad advancing and using cover, path
 * debug, soldier silhouette at 3 LODs", and a bot's decision is invisible in a
 * still frame unless the reasoning is drawn. This is the only way a critic can
 * tell "took cover behind that wall" from "happened to stop near a wall".
 *
 * It is NOT parented into `SceneGroup.Debug`. The harness reset chain hides that
 * whole group before every capture (`driver.ts`), which is correct — no lane's
 * gizmos belong in a review PNG by accident — so an overlay that must appear in
 * exactly one shot owns its own visibility instead of borrowing someone else's.
 *
 * One `LineSegments` with a per-vertex colour attribute, rewritten in place each
 * frame from a fixed-capacity buffer: no allocation, no material churn, and it
 * costs one draw call when it is on and nothing at all when it is off.
 */
import * as THREE from 'three';
import {
  RenderLayer,
  SceneGroup,
  type CoverSlot,
  type MaterialFactory,
  type PlayerState,
  type SceneGraph,
} from '@/engine/types';
import type { Bot } from '@/ai/bot';
import type { NavRuntime } from '@/ai/nav';

/** Vertices, i.e. 2 per segment. 12 k lines is far more than the map ever shows. */
const MAX_VERTICES = 24000;

const DEBUG_VERTEX = /* glsl */ `
  in vec3 colour;
  out vec3 vColour;
  void main() {
    vColour = colour;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DEBUG_FRAGMENT = /* glsl */ `
  precision highp float;
  in vec3 vColour;
  out vec4 outColor;
  void main() {
    // Drawn into the HDR scene target, so the colours are radiance and not
    // sRGB: 3.0 puts a debug line comfortably above the golden-hour ground
    // without blooming, which would smear the very lines it exists to read.
    outColor = vec4(vColour * 3.0, 1.0);
  }
`;

const TMP = new THREE.Vector3();

/** Corridor legs drawn per bot, and how far along it the overlay follows. */
const CORRIDOR_DRAW_CORNERS = 5;
const CORRIDOR_DRAW_M = 45;

export class AiDebugDraw {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  private readonly colours = new Float32Array(MAX_VERTICES * 3);
  private readonly lines: THREE.LineSegments;
  private vertex = 0;

  constructor(scene: SceneGraph, materials: MaterialFactory) {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('colour', new THREE.BufferAttribute(this.colours, 3));
    // A constant up-facing normal and a zero UV. Neither is used by the shader
    // below — they exist because the depth/velocity prepass draws this layer
    // with an OVERRIDE material that declares both, and a missing attribute
    // there is a WebGL warning per frame and a garbage entry in the normal
    // G-buffer along every line.
    const normals = new Float32Array(MAX_VERTICES * 3);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX_VERTICES * 2), 2));
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    (this.geometry.getAttribute('colour') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setDrawRange(0, 0);

    const material = materials.createUnlit({
      id: 'ai.debug.lines',
      vertexShader: DEBUG_VERTEX,
      fragmentShader: DEBUG_FRAGMENT,
      uniforms: {},
      blending: 'opaque',
      depthTest: true,
      // Depth WRITE off: overlapping corridor segments would otherwise z-fight
      // with each other along their shared corners.
      depthWrite: false,
      toneMapped: true,
    });

    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.name = 'ai.debug';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 900;
    scene.group(SceneGroup.Characters).add(this.lines);
    scene.addDynamic(this.lines, RenderLayer.WorldOpaque);
  }

  private on = false;

  get enabled(): boolean {
    return this.on;
  }

  /**
   * Enable/disable by DRAW RANGE, not by `Object3D.visible`.
   *
   * `SceneGraph.addDynamic` hands the object to the culling system, which owns
   * `visible` and rewrites it every frame from its own frustum test — so a
   * `visible = false` here survives exactly until the next frame and the overlay
   * reappears in shots that deliberately turned it off. An empty draw range is
   * the one "off" nothing else in the engine competes for.
   */
  set enabled(value: boolean) {
    this.on = value;
    if (!value) {
      this.vertex = 0;
      this.geometry.setDrawRange(0, 0);
    }
  }

  private segment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (this.vertex + 2 > MAX_VERTICES) return;
    const p = this.vertex * 3;
    this.positions[p] = ax;
    this.positions[p + 1] = ay;
    this.positions[p + 2] = az;
    this.positions[p + 3] = bx;
    this.positions[p + 4] = by;
    this.positions[p + 5] = bz;
    this.colours[p] = r;
    this.colours[p + 1] = g;
    this.colours[p + 2] = b;
    this.colours[p + 3] = r;
    this.colours[p + 4] = g;
    this.colours[p + 5] = b;
    this.vertex += 2;
  }

  /**
   * Rebuild the whole overlay. `stateOf` is the locomotion state accessor so
   * this file never has to know how a bot's body is stored.
   */
  update(
    bots: readonly Bot[],
    nav: NavRuntime,
    stateOf: (bot: Bot) => Readonly<PlayerState> | null,
    cameraPosition: THREE.Vector3,
  ): void {
    if (!this.on) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    this.vertex = 0;

    // ---- cover slots in play -----------------------------------------------
    // Only slots a live bot could actually reach and use, as a stub standing out
    // of the ground pointing the way it protects. Green when free, amber when a
    // bot has claimed it. Drawing every slot on the map instead turns the frame
    // into a hedge and hides the one fact worth showing — WHICH slot was chosen.
    // Claim is tracked by SLOT OBJECT, not by index. `CoverBook.find` reports
    // an index only while it is serving its own derived slots; once LEVEL
    // publishes a cover set the query is delegated and the index is -1, and an
    // index-keyed set would then silently show every slot as free — i.e. it
    // would stop showing the one thing this overlay exists to show, on exactly
    // the day the real data landed.
    const claimed = new Set<CoverSlot>();
    for (const bot of bots) if (bot.cover) claimed.add(bot.cover);
    const slots = nav.cover.all;
    const near: { x: number; y: number; z: number }[] = [];
    for (const bot of bots) {
      if (!bot.alive) continue;
      const state = stateOf(bot);
      if (state) near.push({ x: state.position.x, y: state.position.y, z: state.position.z });
    }
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const dx = slot.position.x - cameraPosition.x;
      const dz = slot.position.z - cameraPosition.z;
      if (dx * dx + dz * dz > 90 * 90) continue;
      let inPlay = claimed.has(slot);
      for (let n = 0; !inPlay && n < near.length; n++) {
        const bx = slot.position.x - near[n].x;
        const bz = slot.position.z - near[n].z;
        // The HEIGHT test is not decoration. Cover sets include rooftop and
        // balcony positions directly above a street fight; without it the
        // overlay draws a row of markers along every parapet in frame and the
        // slots the squad on the ground is actually using disappear into it.
        const by = slot.position.y - near[n].y;
        inPlay = bx * bx + bz * bz < 13 * 13 && by * by < 9;
      }
      if (!inPlay) continue;
      const taken = claimed.has(slot);
      const r = taken ? 1 : 0.16;
      const g = taken ? 0.62 : 0.78;
      const b = taken ? 0.08 : 0.3;
      const h = slot.stance === 'stand' ? 1.5 : 0.95;
      this.segment(slot.position.x, slot.position.y, slot.position.z, slot.position.x, slot.position.y + h, slot.position.z, r, g, b);
      // The facing tick: which way the slot protects against.
      this.segment(
        slot.position.x,
        slot.position.y + h,
        slot.position.z,
        slot.position.x + slot.facing.x * 0.9,
        slot.position.y + h,
        slot.position.z + slot.facing.z * 0.9,
        r,
        g,
        b,
      );
    }

    // ---- per-bot corridor, goal and sight line -----------------------------
    for (const bot of bots) {
      const state = stateOf(bot);
      if (!state || !bot.alive) continue;
      const eyeY = state.position.y + state.eyeHeight;

      const path = bot.path;
      if (path.status === 'ready' && path.cornerCount > 0) {
        // Corridor: cyan for the leg being walked now, dimmer ahead of it.
        let px = state.position.x;
        let py = state.position.y + 0.25;
        let pz = state.position.z;
        // BOUNDED, and the bound is the point of the overlay. Once the
        // string-pull was fixed a corridor became a real 150 m cross-town route
        // of twenty-odd corners, and drawing all of it for every bot turned
        // `ai_firefight` into a wireframe cage laid over the town — legible as
        // nothing at all. The next few legs are the DECISION; the rest is just
        // the map. Capped by count and by run so the overlay stays local to the
        // squad it is explaining.
        let drawn = 0;
        let run = 0;
        for (let i = bot.corridorIndex; i < path.cornerCount && drawn < CORRIDOR_DRAW_CORNERS && run < CORRIDOR_DRAW_M; i++) {
          const c = path.corners[i].position;
          run += Math.hypot(c.x - px, c.z - pz);
          drawn++;
          const current = i === bot.corridorIndex;
          this.segment(px, py, pz, c.x, c.y + 0.25, c.z, current ? 0.25 : 0.1, current ? 0.85 : 0.34, current ? 1 : 0.5);
          // A tick at every corner, so the string-pull is legible as a polyline
          // rather than as one continuous smear.
          this.segment(c.x, c.y + 0.25, c.z, c.x, c.y + 0.85, c.z, 0.16, 0.55, 0.8);
          px = c.x;
          py = c.y + 0.25;
          pz = c.z;
        }
      }

      // The claimed cover slot, tied to its owner. A magenta tether plus a post
      // is the one unambiguous statement in this overlay: THIS man chose THAT
      // slot, whichever set it came from and whether or not it has an index.
      if (bot.cover) {
        const c = bot.cover;
        this.segment(state.position.x, eyeY - 0.4, state.position.z, c.position.x, c.position.y + 1.1, c.position.z, 1, 0.15, 0.85);
        this.segment(c.position.x, c.position.y, c.position.z, c.position.x, c.position.y + 1.7, c.position.z, 1, 0.15, 0.85);
        this.segment(
          c.position.x,
          c.position.y + 1.7,
          c.position.z,
          c.position.x + c.facing.x * 1.2,
          c.position.y + 1.7,
          c.position.z + c.facing.z * 1.2,
          1,
          0.15,
          0.85,
        );
      }

      // The bot's own goal, as a vertical stake.
      if (bot.goal.lengthSq() > 0) {
        this.segment(bot.goal.x, bot.goal.y, bot.goal.z, bot.goal.x, bot.goal.y + 2.2, bot.goal.z, 0.9, 0.85, 0.2);
      }

      // Sight line to what he believes he is looking at. Red while the trigger
      // is down, orange while he has a contact he has not shot at yet.
      const memory = bot.target !== 0 ? bot.memoryOf(bot.target) : undefined;
      if (memory) {
        TMP.copy(memory.lastKnown);
        const hot = bot.trigger;
        this.segment(
          state.position.x,
          eyeY,
          state.position.z,
          TMP.x,
          TMP.y + 1.2,
          TMP.z,
          hot ? 1 : 0.85,
          hot ? 0.12 : 0.42,
          hot ? 0.08 : 0.1,
        );
      }
    }

    this.geometry.setDrawRange(0, this.vertex);
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colour = this.geometry.getAttribute('colour') as THREE.BufferAttribute;
    position.addUpdateRange(0, this.vertex * 3);
    colour.addUpdateRange(0, this.vertex * 3);
    position.needsUpdate = true;
    colour.needsUpdate = true;
  }
}
