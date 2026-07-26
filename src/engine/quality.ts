/**
 * The four quality tier tables and the dynamic-resolution governor.
 * CORE owns this file, and after Wave 1b the performance agent owns it alone.
 *
 * NO LANE RAISES ITS OWN BUDGET. Twelve agents each nudging their own particle
 * count, shadow resolution or draw ceiling is precisely how you arrive at a
 * 40 ms frame with no single culprit and no way to bisect it. Every number that
 * scales with quality lives in this one table, is read through
 * `QualityService.settings`, and changes here or nowhere.
 *
 * The numbers come straight from docs/ARCHITECTURE.md §5 and are calibrated to
 * a 16.6 ms budget: 1080p on a discrete GPU for Medium/High/Ultra, 720p for Low.
 */
import {
  AntiAliasMode,
  QualityTier,
  RTFormat,
  type BakeProfile,
  type BudgetLimits,
  type GpuCaps,
  type QualityService,
  type QualitySettings,
  type ShadowSettings,
} from '@/engine/types';
import { suggestedWorkerCount } from '@/engine/caps';
import { clamp } from '@/engine/math/curves';

const MB = 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* Shadow tables                                                              */
/* -------------------------------------------------------------------------- */
/**
 * `lightSizeUv` is the sun's angular diameter expressed in shadow-map UV units
 * for cascade 0, which is what drives PCSS penumbra growth. The real sun is
 * ~0.53° across; at golden hour the visible penumbra is wider than geometry
 * alone predicts because of aerial scattering, so these are tuned slightly
 * generous rather than physically exact.
 */
const SHADOWS: Readonly<Record<QualityTier, ShadowSettings>> = {
  [QualityTier.Low]: {
    cascadeCount: 2,
    atlasSize: 2048,
    tileSizes: [1024, 1024],
    splits: [30, 90],
    maxDistance: 90,
    lightSizeUv: 0.012,
    pcssBlockerSamples: 4,
    pcssFilterSamples: 4,
    updateCadence: [1, 2],
    contactShadowSteps: 0,
  },
  [QualityTier.Medium]: {
    cascadeCount: 3,
    atlasSize: 3072,
    tileSizes: [1024, 1024, 1024],
    splits: [16, 55, 140],
    maxDistance: 140,
    lightSizeUv: 0.010,
    pcssBlockerSamples: 8,
    pcssFilterSamples: 8,
    updateCadence: [1, 1, 2],
    contactShadowSteps: 0,
  },
  [QualityTier.High]: {
    cascadeCount: 4,
    atlasSize: 3072,
    tileSizes: [2048, 1536, 1024, 1024],
    splits: [12, 38, 110, 220],
    maxDistance: 220,
    lightSizeUv: 0.008,
    pcssBlockerSamples: 12,
    pcssFilterSamples: 12,
    updateCadence: [1, 1, 2, 4],
    contactShadowSteps: 0,
  },
  [QualityTier.Ultra]: {
    cascadeCount: 4,
    atlasSize: 4096,
    tileSizes: [2048, 2048, 2048, 2048],
    splits: [12, 38, 110, 300],
    maxDistance: 300,
    lightSizeUv: 0.007,
    pcssBlockerSamples: 16,
    pcssFilterSamples: 16,
    updateCadence: [1, 1, 2, 4],
    contactShadowSteps: 16,
  },
};

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */
/**
 * `drawCalls` is the number that actually caps 1080p, not the GPU: three costs
 * roughly 5–8 µs of JavaScript per draw, so 480 draws is 2.4–3.8 ms of main
 * thread competing with physics, AI and culling. Dynamic resolution does not
 * help a CPU-bound frame at all, which is why the Profiler treats a draw-call
 * violation as build-breaking rather than as a hint.
 */
const BUDGETS: Readonly<Record<QualityTier, BudgetLimits>> = {
  [QualityTier.Low]: {
    drawCalls: 160,
    triangles: 1_600_000,
    shadowTriangles: 900_000,
    textureBytes: 112 * MB,
    renderTargetBytes: 45 * MB,
    shaderPrograms: 24,
    gpuMs: 15.0,
    cpuMs: 9.0,
    physicsMs: 2.0,
    aiMs: 1.0,
  },
  [QualityTier.Medium]: {
    drawCalls: 250,
    triangles: 2_800_000,
    shadowTriangles: 1_600_000,
    textureBytes: 192 * MB,
    renderTargetBytes: 95 * MB,
    shaderPrograms: 32,
    gpuMs: 14.5,
    cpuMs: 7.5,
    physicsMs: 1.4,
    aiMs: 0.6,
  },
  [QualityTier.High]: {
    drawCalls: 360,
    triangles: 4_200_000,
    shadowTriangles: 2_400_000,
    textureBytes: 320 * MB,
    renderTargetBytes: 150 * MB,
    shaderPrograms: 40,
    gpuMs: 14.4,
    cpuMs: 5.5,
    physicsMs: 1.0,
    aiMs: 0.45,
  },
  [QualityTier.Ultra]: {
    drawCalls: 480,
    triangles: 5_600_000,
    shadowTriangles: 3_200_000,
    textureBytes: 512 * MB,
    renderTargetBytes: 200 * MB,
    shaderPrograms: 40,
    gpuMs: 14.4,
    cpuMs: 4.6,
    physicsMs: 0.8,
    aiMs: 0.35,
  },
};

/* -------------------------------------------------------------------------- */
/* Bake profiles                                                              */
/* -------------------------------------------------------------------------- */
/**
 * `unitCeiling` is the single most load-bearing number in the boot path. The
 * capture tool hard-fails at 300 s waiting for `ready`, Playwright uses a fresh
 * profile so IndexedDB never hits, and SwiftShader runs GPU bakes 20–60× slower
 * than a discrete part. If the sum of declared BakeStep costs exceeds the
 * ceiling the scheduler halves `grantedTexelSize` on the lowest-priority steps —
 * it never drops a step, because a missing material is a defect and a 256²
 * material is merely softer.
 */
export const BAKE_PROFILES: Readonly<Record<BakeProfile['name'], BakeProfile>> = {
  compact: {
    name: 'compact',
    heroTexelSize: 512,
    bulkTexelSize: 256,
    terrainHeightRes: 512,
    erosionIterations: 24,
    impostorViews: 8,
    impostorAtlasSize: 1024,
    unitCeiling: 700,
    workerCount: 0,
    allowReadback: true,
  },
  standard: {
    name: 'standard',
    heroTexelSize: 1024,
    bulkTexelSize: 512,
    terrainHeightRes: 1024,
    erosionIterations: 48,
    impostorViews: 12,
    impostorAtlasSize: 2048,
    unitCeiling: 1400,
    workerCount: 0,
    allowReadback: true,
  },
  full: {
    name: 'full',
    heroTexelSize: 2048,
    bulkTexelSize: 1024,
    terrainHeightRes: 2048,
    erosionIterations: 64,
    impostorViews: 16,
    impostorAtlasSize: 2048,
    unitCeiling: 2200,
    workerCount: 0,
    allowReadback: true,
  },
};

const PROFILE_FOR_TIER: Readonly<Record<QualityTier, BakeProfile['name']>> = {
  [QualityTier.Low]: 'compact',
  [QualityTier.Medium]: 'standard',
  [QualityTier.High]: 'standard',
  [QualityTier.Ultra]: 'full',
};

/* -------------------------------------------------------------------------- */
/* The tier tables                                                            */
/* -------------------------------------------------------------------------- */

function buildSettings(tier: QualityTier, caps: Readonly<GpuCaps>): QualitySettings {
  const byTier = <T>(low: T, medium: T, high: T, ultra: T): T =>
    tier === QualityTier.Low ? low : tier === QualityTier.Medium ? medium : tier === QualityTier.High ? high : ultra;

  // Software rasterisers get the standard bake profile regardless of render
  // tier: shots stay beautiful, they just bake coarser and finish inside the
  // 300 s ready timeout. Workers are also disabled — under SwiftShader the
  // marshalling cost exceeds the parallelism win and inline is more predictable.
  const profileName: BakeProfile['name'] = caps.isSoftware
    ? 'standard'
    : PROFILE_FOR_TIER[tier];
  const bake: BakeProfile = {
    ...BAKE_PROFILES[profileName],
    workerCount: caps.isSoftware ? 0 : suggestedWorkerCount(),
    // Readback stalls the pipeline; under software rendering it is catastrophic
    // and the only bake that genuinely needs it (terrain → physics heightfield)
    // has a coarse analytic fallback.
    allowReadback: !caps.isSoftware,
  };

  const hdrFormat = caps.colorBufferFloat
    ? byTier<RTFormat.RGBA16F | RTFormat.R11G11B10F>(
        RTFormat.R11G11B10F,
        RTFormat.RGBA16F,
        RTFormat.RGBA16F,
        RTFormat.RGBA16F,
      )
    : RTFormat.R11G11B10F;

  return {
    tier,
    baseWidth: byTier(1280, 1920, 1920, 1920),
    baseHeight: byTier(720, 1080, 1080, 1080),
    renderScale: 1,
    renderScaleRange: byTier<readonly [number, number]>([0.7, 1.0], [0.75, 1.0], [0.85, 1.0], [1.0, 1.0]),
    dynamicResolution: tier !== QualityTier.Ultra,
    aa: byTier(AntiAliasMode.Fxaa, AntiAliasMode.Taa, AntiAliasMode.Taa, AntiAliasMode.Taa),
    taaSamples: byTier<4 | 8 | 16>(4, 4, 8, 8),
    hdrFormat,
    shadows: SHADOWS[tier],
    gtao: {
      enabled: tier !== QualityTier.Low,
      scale: 0.5,
      slices: byTier(0, 2, 3, 4),
      stepsPerSlice: byTier(0, 4, 6, 8),
      bentNormals: tier >= QualityTier.High,
    },
    ssr: {
      enabled: tier >= QualityTier.High,
      scale: 0.5,
      maxSteps: byTier(0, 0, 24, 48),
      // Above ~0.45 roughness the cone is wider than a screen-space trace can
      // resolve and the IBL fallback is both cheaper and more stable.
      maxRoughness: 0.45,
      thickness: 0.35,
    },
    volumetrics: {
      enabled: tier !== QualityTier.Low,
      froxels: byTier<readonly [number, number, number]>([0, 0, 0], [96, 54, 32], [128, 72, 48], [160, 90, 64]),
      maxDistance: byTier(0, 120, 220, 320),
      marchSteps: byTier(0, 24, 32, 48),
    },
    clouds: {
      enabled: tier !== QualityTier.Low,
      scale: byTier(0, 0.5, 0.5, 0.5),
      steps: byTier(0, 32, 48, 64),
    },
    bloom: { levels: byTier(4, 5, 6, 6) },
    motionBlur: {
      enabled: tier !== QualityTier.Low,
      samples: byTier(0, 6, 8, 12),
      // 180° shutter — the film convention, and the only value that does not
      // read as either a strobe or a smear at 60 fps.
      shutterAngleDeg: 180,
    },
    dof: { enabled: tier >= QualityTier.High, adsOnly: tier < QualityTier.Ultra },
    terrain: {
      clipmapLevels: byTier(5, 6, 7, 7),
      clipmapVerts: byTier(64, 96, 128, 128),
      splatSize: byTier(1024, 2048, 2048, 4096),
    },
    vegetation: {
      densityScale: byTier(0.45, 0.75, 1.0, 1.25),
      grassRadius: byTier(22, 40, 55, 70),
      grassInstances: byTier(14_000, 45_000, 90_000, 140_000),
      drawDistance: byTier(90, 150, 220, 300),
      shadowDistance: byTier(20, 40, 60, 80),
      lodBias: byTier(1.4, 1.1, 1.0, 0.9),
      windDetail: byTier<0 | 1 | 2>(0, 1, 2, 2),
    },
    particles: {
      maxLive: byTier(1200, 3000, 6000, 12_000),
      soft: tier !== QualityTier.Low,
      lit: tier >= QualityTier.High,
      shadowReceive: tier === QualityTier.Ultra,
    },
    decals: { maxLive: byTier(256, 768, 2048, 4096) },
    destruction: { maxChunks: byTier(64, 128, 256, 512), settleSeconds: byTier(4, 6, 8, 10) },
    physics: { substeps: 1, maxDynamicBodies: byTier(120, 220, 420, 700) },
    ai: {
      maxBots: byTier(10, 16, 20, 24),
      perceptionHz: byTier(4, 6, 8, 10),
      pathsPerTick: byTier(1, 2, 3, 4),
    },
    audio: { maxVoices: byTier(24, 40, 64, 96), reverbQuality: byTier<0 | 1 | 2>(0, 1, 2, 2) },
    maxAnisotropy: Math.min(caps.maxAnisotropy, byTier(4, 8, 16, 16)),
    budgets: BUDGETS[tier],
    bake,
  };
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/** Hysteresis band for the dynamic-resolution governor, in milliseconds. */
const DR_LOWER_MS = 14.5;
const DR_UPPER_MS = 17.5;
const DR_STEP = 0.05;
const DR_COOLDOWN_FRAMES = 30;

export class EngineQualityService implements QualityService {
  private settingsValue: QualitySettings;
  private scale = 1;
  private cooldown = 0;
  private dynamicEnabled: boolean;
  private readonly listeners: Array<(s: Readonly<QualitySettings>) => void> = [];
  /** Set by the driver; hard-disables the governor for the whole capture. */
  deterministic = false;

  constructor(readonly caps: Readonly<GpuCaps>, tier: QualityTier = caps.estimatedTier) {
    this.settingsValue = buildSettings(tier, caps);
    this.dynamicEnabled = this.settingsValue.dynamicResolution;
  }

  get tier(): QualityTier {
    return this.settingsValue.tier;
  }

  get settings(): Readonly<QualitySettings> {
    return this.settingsValue;
  }

  get renderScale(): number {
    return this.deterministic ? 1 : this.scale;
  }

  setTier(tier: QualityTier): void {
    if (tier === this.settingsValue.tier) return;
    this.settingsValue = buildSettings(tier, this.caps);
    this.dynamicEnabled = this.settingsValue.dynamicResolution;
    this.scale = 1;
    this.cooldown = 0;
    this.notify();
  }

  setDynamicResolution(enabled: boolean): void {
    this.dynamicEnabled = enabled;
    if (!enabled) this.scale = 1;
  }

  onChange(fn: (settings: Readonly<QualitySettings>) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Called once per rendered frame with the measured frame cost. Returns true
   * when the scale changed, which is the renderer's cue to resize its targets.
   *
   * Deliberately slow: at most one 0.05 step per 30 frames. A governor that
   * reacts every frame produces visible resolution pumping on any scene with a
   * cost gradient — walking around a corner should not shimmer.
   */
  governFrame(frameMs: number): boolean {
    if (this.deterministic || !this.dynamicEnabled) {
      if (this.scale !== 1) {
        this.scale = 1;
        return true;
      }
      return false;
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return false;
    }
    const [min, max] = this.settingsValue.renderScaleRange;
    let next = this.scale;
    if (frameMs > DR_UPPER_MS) next = clamp(this.scale - DR_STEP, min, max);
    else if (frameMs < DR_LOWER_MS) next = clamp(this.scale + DR_STEP, min, max);
    if (Math.abs(next - this.scale) < 1e-6) return false;
    this.scale = next;
    this.cooldown = DR_COOLDOWN_FRAMES;
    return true;
  }

  private notify(): void {
    for (const fn of this.listeners.slice()) fn(this.settingsValue);
  }
}

export function createQualityService(caps: Readonly<GpuCaps>, override?: QualityTier): EngineQualityService {
  return new EngineQualityService(caps, override ?? caps.estimatedTier);
}

/** Exposed for the debug overlay and for tier A/B shots. */
export function tierName(tier: QualityTier): string {
  return ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'][tier] ?? 'UNKNOWN';
}
