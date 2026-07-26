/**
 * AUDIO — bake declarations.
 *
 * OWNER: AUDIO. Architecture §6.1 step 13: "~60 cues + 3 impulse responses,
 * pure DSP". We declare four steps rather than one so the progress string moves
 * (a 12-second silent step looks exactly like a hang from outside the tab) and
 * so a future profile can drop a whole family without touching the others.
 *
 * These are `BakeKind.MainThread` steps and that is deliberate, not a shortcut:
 * `WorkerPool.run` dispatches by JOB NAME into BAKE's own worker protocol, and
 * AUDIO cannot add a job to another lane's worker without a cross-lane import.
 * Every step therefore yields to the event loop between cue families, which is
 * what the 300 s ready timeout actually cares about. The synthesis is ~0.6 s of
 * straight-line float maths and does not touch the GPU, so it is one of the few
 * bakes that is NOT slower under SwiftShader.
 */
import { AssetKind, BakeKind, type AssetKey, type AssetRegistry, type AudioAsset, type QualitySettings } from '@/engine/types';
import { LIBRARY, ENVIRONMENTS, ENV_NAMES, type EnvName } from './library';
import { renderImpulse, type ImpulseResponse, type RoomSpec } from './dsp/impulse';
import type { SoundId } from '@/engine/types';

/** One entry per baked variation of one cue. */
export type CueBank = Partial<Record<SoundId, AudioAsset[]>>;

export interface IrBank {
  readonly responses: Readonly<Record<EnvName, ImpulseResponse>>;
  /** Truncated copies used by the EARLY-REFLECTION convolver. */
  readonly early: Readonly<Record<EnvName, ImpulseResponse>>;
}

/**
 * Physical descriptions of the seven environments. These are rooms, not presets:
 * change a dimension and the early reflection pattern moves accordingly, which
 * is why a courtyard and an interior of the same RT60 still sound different.
 */
const ROOMS: Readonly<Record<EnvName, RoomSpec>> = {
  // Open shoreline. Ground bounce and nothing else; a long, very quiet tail
  // from the town behind you.
  open: {
    size: [120, 40, 120],
    offset: [3, -18, 5],
    rt60: [0.9, 0.6, 0.28],
    absorption: 0.72,
    enclosure: 0.05,
    lowCrossHz: 220,
    highCrossHz: 2400,
    modal: 0,
  },
  // The harbour: a stone quay wall, the freighter's flank, water. One hard,
  // late slap off the hull is most of its character.
  harbour: {
    size: [90, 26, 140],
    offset: [-24, -9, 12],
    rt60: [2.6, 1.9, 0.85],
    absorption: 0.42,
    enclosure: 0.3,
    lowCrossHz: 200,
    highCrossHz: 2200,
    slap: [0.185, 0.42, 3200],
    modal: 0.1,
  },
  // A tight sandstone alley: very early lateral reflections, bright, ringing.
  street: {
    size: [7.5, 11, 60],
    offset: [0.8, -3.4, -6],
    rt60: [1.8, 1.5, 0.75],
    absorption: 0.2,
    enclosure: 0.72,
    lowCrossHz: 260,
    highCrossHz: 3200,
    slap: [0.075, 0.3, 6000],
    modal: 0.35,
  },
  // Market square: wide, low, plenty of cloth awnings soaking up the treble.
  courtyard: {
    size: [34, 14, 30],
    offset: [4, -4.2, -3],
    rt60: [1.5, 1.2, 0.45],
    absorption: 0.35,
    enclosure: 0.55,
    lowCrossHz: 230,
    highCrossHz: 2600,
    modal: 0.12,
  },
  // A plastered room: short, dense, dark. The mixing time arrives almost at
  // once, which is exactly what makes a small room feel small.
  interior: {
    size: [6, 3.2, 8],
    offset: [0.6, -0.3, 1.1],
    rt60: [0.95, 0.75, 0.34],
    absorption: 0.34,
    enclosure: 0.9,
    lowCrossHz: 180,
    highCrossHz: 1900,
    modal: 0.22,
  },
  // A vaulted service tunnel under the fort: strong modal ringing, no treble.
  tunnel: {
    size: [3.4, 3, 46],
    offset: [0.3, -0.2, -14],
    rt60: [3.2, 2.4, 0.9],
    absorption: 0.1,
    enclosure: 1.0,
    lowCrossHz: 160,
    highCrossHz: 1500,
    slap: [0.055, 0.5, 2400],
    modal: 0.85,
  },
  // The old fort: stone ramparts around a large open court. Long tail, and a
  // very distinct late slap off the far wall.
  fort: {
    size: [52, 20, 46],
    offset: [-8, -6.5, 6],
    rt60: [2.9, 2.1, 0.95],
    absorption: 0.22,
    enclosure: 0.62,
    lowCrossHz: 200,
    highCrossHz: 2300,
    slap: [0.24, 0.36, 4200],
    modal: 0.28,
  },
};

/** Which cue families land in which bake step. Keeps each step ~0.15 s. */
const WEAPON_IDS: SoundId[] = [
  'w.rifle.fire',
  'w.carbine.fire',
  'w.dmr.fire',
  'w.smg.fire',
  'w.lmg.fire',
  'w.shotgun.fire',
  'w.pistol.fire',
  'w.tail',
  'w.distant',
  'w.dry',
  'w.magout',
  'w.magin',
  'w.bolt',
  'w.ads',
  'w.shell',
  'b.whizby',
  'b.crack',
];

const WORLD_IDS: SoundId[] = [
  'i.stone',
  'i.metal',
  'i.wood',
  'i.glass',
  'i.sand',
  'i.water',
  'i.flesh',
  'i.fabric',
  'i.foliage',
  'p.footstep',
  'p.land',
  'p.jump',
  'p.gear',
  'p.breath',
  'p.hurt',
  'x.near',
  'x.far',
  'x.debris',
  'x.collapse',
];

const AMBIENCE_IDS: SoundId[] = ['amb.surf', 'amb.wind', 'amb.palms', 'amb.gull', 'amb.halyard', 'amb.distant'];

const UI_IDS: SoundId[] = ['ui.capture', 'ui.lost', 'ui.ticket', 'ui.hit', 'ui.spawn', 'ui.select'];

/**
 * Degradation policy. The compact profile halves the number of takes rather
 * than dropping cues or lowering the sample rate: a missing cue is a defect, a
 * slightly more repetitive burst is merely less good. Gunshots never fall below
 * three takes, because two is where the comb filtering becomes audible again.
 */
function variationsFor(id: SoundId, profileName: string): number {
  const recipe = LIBRARY[id];
  if (profileName !== 'compact') return recipe.variations;
  // A SURFACE-KEYED cue's variation index is an ENCODING — footsteps pack
  // [group][stance][take] into it — not a bag of interchangeable takes. Halving
  // the count would drop the last four surface groups off the end and the
  // runtime's `variation % count` would then silently play sand for stone.
  // Repetition is a quality loss; a stone floor that sounds like sand is a bug.
  if (recipe.surfaceKeyed) return recipe.variations;
  const floor = recipe.gunshot ? 3 : 1;
  return Math.max(floor, Math.ceil(recipe.variations / 2));
}

async function bakeFamily(
  ids: readonly SoundId[],
  sampleRate: number,
  profileName: string,
  seedOf: (id: string, variation: number) => number,
  progress: (f: number) => void,
  yieldFrame: () => Promise<void>,
): Promise<CueBank> {
  const bank: CueBank = {};
  let totalCost = 0;
  for (const id of ids) totalCost += LIBRARY[id].cost;
  let spent = 0;
  for (const id of ids) {
    const recipe = LIBRARY[id];
    const takes = variationsFor(id, profileName);
    const assets: AudioAsset[] = [];
    for (let v = 0; v < takes; v++) {
      const pcm = recipe.synth(sampleRate, v, seedOf(id, v));
      assets.push({ channels: [pcm], sampleRate, peak: 1 });
    }
    bank[id] = assets;
    spent += recipe.cost;
    progress(spent / totalCost);
    // One yield per cue family member: the synthesis of a single cue is at
    // most ~20 ms, so this keeps the main thread responsive without paying a
    // frame per variation.
    await yieldFrame();
  }
  return bank;
}

let weaponsKey: AssetKey<CueBank> | null = null;
let worldKey: AssetKey<CueBank> | null = null;
let ambienceKey: AssetKey<CueBank> | null = null;
let uiKey: AssetKey<CueBank> | null = null;
let irKey: AssetKey<IrBank> | null = null;

export interface AudioBakeKeys {
  readonly weapons: AssetKey<CueBank> | null;
  readonly world: AssetKey<CueBank> | null;
  readonly ambience: AssetKey<CueBank> | null;
  readonly ui: AssetKey<CueBank> | null;
  readonly ir: AssetKey<IrBank> | null;
}

export function audioBakeKeys(): AudioBakeKeys {
  return { weapons: weaponsKey, world: worldKey, ambience: ambienceKey, ui: uiKey, ir: irKey };
}

/**
 * Declare AUDIO's bake steps. Called once, after `assets` exists and before any
 * other subsystem is constructed — so there is no service to touch here.
 */
export function declareAudioBakes(assets: AssetRegistry, _quality: Readonly<QualitySettings>): void {
  if (weaponsKey) return;

  const family = (
    id: string,
    ids: readonly SoundId[],
    cost: number,
  ): AssetKey<CueBank> =>
    assets.define<CueBank>(id, AssetKind.Audio, {
      kind: BakeKind.MainThread,
      version: 3,
      cost,
      cacheable: false,
      run: async (ctx) => {
        // One integer per (cue, variation) drawn from the bake RNG fork; the DSP
        // expands it locally (see `dsp/core.makeNoise`). Drawing in a fixed
        // order over a fixed id list keeps the stream stable under edit.
        const draws = new Map<string, number>();
        const seedOf = (cueId: string, variation: number): number => {
          const k = `${cueId}#${variation}`;
          let s = draws.get(k);
          if (s === undefined) {
            s = (ctx.rng.int(0x7fffffff) ^ (variation * 0x9e3779b1)) | 0;
            draws.set(k, s);
          }
          return s;
        };
        return bakeFamily(
          ids,
          ctx.audioCtx.sampleRate,
          ctx.profile.name,
          seedOf,
          (f) => ctx.progress(f, id),
          ctx.yieldFrame,
        );
      },
    });

  weaponsKey = family('audio.cues.weapons', WEAPON_IDS, 46);
  worldKey = family('audio.cues.world', WORLD_IDS, 52);
  ambienceKey = family('audio.cues.ambience', AMBIENCE_IDS, 34);
  uiKey = family('audio.cues.ui', UI_IDS, 8);

  irKey = assets.define<IrBank>('audio.impulses', AssetKind.Audio, {
    kind: BakeKind.MainThread,
    version: 3,
    cost: 24,
    cacheable: false,
    run: async (ctx) => {
      const fs = ctx.audioCtx.sampleRate;
      // `reverbQuality` 0 truncates the tails hard: an IR is the single most
      // expensive thing in the live graph (a 3 s stereo convolution is ~4% of a
      // core), so Low buys its frame budget back here rather than by dropping
      // reverb entirely — a dry firefight in a stone street is a bigger defect
      // than a short one.
      const q = ctx.quality.audio.reverbQuality;
      const tailScale = q === 0 ? 0.4 : q === 1 ? 0.7 : 1;
      const responses = {} as Record<EnvName, ImpulseResponse>;
      const early = {} as Record<EnvName, ImpulseResponse>;
      for (let i = 0; i < ENV_NAMES.length; i++) {
        const name = ENV_NAMES[i];
        const base = ROOMS[name];
        const spec: RoomSpec = {
          ...base,
          rt60: [base.rt60[0] * tailScale, base.rt60[1] * tailScale, base.rt60[2] * tailScale] as const,
        };
        const seed = ctx.rng.int(0x7fffffff);
        responses[name] = renderImpulse(spec, fs, seed);
        // The early convolver gets the first 90 ms only. Splitting ER from the
        // late field is what lets the runtime move a source closer or further
        // without changing the room, which a single wet send cannot do.
        early[name] = truncate(responses[name], Math.floor(0.09 * fs));
        ctx.progress((i + 1) / ENV_NAMES.length, 'audio.impulses');
        await ctx.yieldFrame();
      }
      const bank: IrBank = { responses, early };
      void ENVIRONMENTS;
      return bank;
    },
  });
}

function truncate(ir: ImpulseResponse, samples: number): ImpulseResponse {
  const n = Math.min(samples, ir.left.length);
  const left = ir.left.slice(0, n);
  const right = ir.right.slice(0, n);
  // Fade the truncation point or the tail convolver's input clicks.
  const fade = Math.min(n >> 2, Math.floor(0.02 * ir.sampleRate));
  for (let i = 0; i < fade; i++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    left[n - 1 - i] *= w;
    right[n - 1 - i] *= w;
  }
  return { left, right, sampleRate: ir.sampleRate, rt60: n / ir.sampleRate, envelope: ir.envelope };
}
