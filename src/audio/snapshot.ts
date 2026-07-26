/**
 * AUDIO — the debug snapshot the overlay renders.
 *
 * OWNER: AUDIO. A separate module so `system.ts` (which produces it) and
 * `debug/overlay.ts` (which consumes it) do not import each other.
 *
 * Everything here comes out of the JS mixing model, NOT out of AnalyserNodes.
 * That is a deliberate choice and it is stated in the overlay: analyser taps
 * read the audio thread, which is asynchronous and unavailable while the
 * context is locked — so they would be blank in every capture, which is the one
 * case the overlay exists for.
 */
import type { SoundId } from '@/engine/types';
import type { BusName } from './library';
import type { DebugBlocker } from './occlusion';

export interface VoiceRow {
  readonly id: SoundId;
  readonly variation: number;
  readonly bus: BusName;
  readonly priority: number;
  readonly distance: number;
  readonly levelDb: number;
  readonly lowpassHz: number;
  readonly occlusion: number;
  readonly pan: number;
  readonly delay: number;
  readonly pending: number;
  readonly loop: boolean;
  /** 0..1 through the cue. */
  readonly progress: number;
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

export interface BusRow {
  readonly name: string;
  /** Instantaneous summed level in dB. */
  readonly levelDb: number;
  /** Peak-hold in dB, decaying at 20 dB/s. */
  readonly peakDb: number;
  readonly gainDb: number;
  readonly voices: number;
}

export interface IrRow {
  readonly name: string;
  readonly rt60: number;
  readonly envelope: Float32Array;
  readonly active: boolean;
}

export interface AudioSnapshot {
  readonly contextState: string;
  readonly unlocked: boolean;
  readonly sampleRate: number;
  readonly bufferBytes: number;
  readonly bakedCues: number;
  readonly bakedVariations: number;
  readonly voicesLive: number;
  readonly voicesMax: number;
  readonly steals: number;
  readonly rejections: number;
  readonly duckDb: number;
  readonly deafness: number;
  readonly envName: string;
  readonly envEnclosure: number;
  readonly envReverbSeconds: number;
  readonly envWetDb: number;
  readonly envBlend: number;
  readonly listener: { x: number; y: number; z: number; yawDeg: number };
  readonly occlusionSource: string;
  readonly rows: readonly VoiceRow[];
  readonly buses: readonly BusRow[];
  readonly irs: readonly IrRow[];
  readonly blockers: readonly DebugBlocker[];
  /** Peak envelope of the most recently triggered gunshot cue, 0..1, 192 bins. */
  readonly lastGunWaveform: Float32Array;
  readonly lastGunLabel: string;
  readonly modelTime: number;
}

export function emptySnapshot(): AudioSnapshot {
  return {
    contextState: 'none',
    unlocked: false,
    sampleRate: 0,
    bufferBytes: 0,
    bakedCues: 0,
    bakedVariations: 0,
    voicesLive: 0,
    voicesMax: 0,
    steals: 0,
    rejections: 0,
    duckDb: 0,
    deafness: 0,
    envName: 'open',
    envEnclosure: 0,
    envReverbSeconds: 0,
    envWetDb: 0,
    envBlend: 1,
    listener: { x: 0, y: 0, z: 0, yawDeg: 0 },
    occlusionSource: 'none',
    rows: [],
    buses: [],
    irs: [],
    blockers: [],
    lastGunWaveform: new Float32Array(192),
    lastGunLabel: '—',
    modelTime: 0,
  };
}
