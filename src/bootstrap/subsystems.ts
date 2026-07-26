/**
 * THE SUBSYSTEM DESCRIPTOR TABLE.
 * CORE owns this file. THE FREEZE BEGINS NOW.
 *
 * Written on day 0, revised once — before fan-out — to wire all three descriptor
 * hooks for every lane. From this commit onward it is NEVER EDITED AGAIN: not to
 * add a hook, not to change a signature, not to reorder a dependency. If you are
 * a lane agent reading this, you are in the wrong file; go to the file your
 * factory points at.
 *
 * EVERY DESCRIPTOR WIRES THREE NAMED EXPORTS OF ITS LANE'S ENTRY FILE:
 *
 *     create        create<Key>Service(ctx: BootContext)
 *     registerBakes register<Key>Bakes(assets, quality)
 *     reset         reset<Key>(seed)
 *
 * All three exist as no-ops in every entry file today, so a lane fills in a body
 * and ships — it never has to come back here. The reason `registerBakes` and
 * `reset` are FREE FUNCTIONS rather than methods on the service: `registerBakes`
 * must run before `bakeAll`, which is before any subsystem is constructed, and
 * `reset` must work whether or not `create` ever ran. A lane that needs its
 * instance in either hook keeps it in a module-scoped variable that `create`
 * assigns (see `src/game/player.ts` for the pattern).
 *
 * EVERY `create` RECEIVES THE FULL `BootContext`. A factory that ignores it
 * cannot register a tick or render system, cannot reach `ctx.assets` for its
 * baked textures, cannot fork the RNG and cannot add anything to the scene —
 * i.e. it cannot do its job. There is no such thing as a lane that legitimately
 * takes no context.
 *
 * Only CONTRACT INTERFACES appear below. No lane's concrete class name is
 * referenced, so a lane can restructure its internals freely as long as its
 * three exported functions keep their names, paths and signatures.
 *
 * `dependsOn` declares CONSTRUCTION-TIME dependencies only — services a factory
 * reads while it is running. A service read later, from inside a tick or render
 * system, needs no entry: `BootContext.services` resolves lazily and everything
 * is constructed before the first frame. Over-declaring is not free, because the
 * boot order is a topological sort over these and a cycle throws at boot.
 */
import {
  type AiService,
  type AssetRegistry,
  type AudioService,
  type BallisticsService,
  type CameraRig,
  type DestructionService,
  type GameMode,
  type HudService,
  type LevelService,
  type LightingService,
  type MaterialFactory,
  type NavService,
  type PhysicsService,
  type PlayerService,
  type RenderGraph,
  type RenderService,
  type SkyService,
  type SubsystemDescriptor,
  type TerrainService,
  type VegetationService,
  type VfxService,
  type ViewmodelRig,
  type WaterService,
  type WeaponService,
} from '@/engine/types';

import { createAssetRegistry, registerAssetsBakes, resetAssets } from '@/bake/registry';
import { createMaterialFactory, registerMaterialsBakes, resetMaterials } from '@/render/material/factory';
import { createRenderGraph, registerGraphBakes, resetGraph } from '@/render/graph';
import { createCameraRig, registerCameraBakes, resetCamera } from '@/render/camera-rig';
import { createRenderService, registerRendererBakes, resetRenderer } from '@/render/service';
import { createLightingService, registerLightingBakes, resetLighting } from '@/render/lighting/service';
import { createSkyService, registerSkyBakes, resetSky } from '@/world/sky/system';
import { createTerrainService, registerTerrainBakes, resetTerrain } from '@/world/terrain/system';
import { createWaterService, registerWaterBakes, resetWater } from '@/world/water/system';
import { createVegetationService, registerVegetationBakes, resetVegetation } from '@/world/vegetation/system';
import { createLevelService, registerLevelBakes, resetLevel } from '@/level/harbour-reach';
import { createPhysicsService, registerPhysicsBakes, resetPhysics } from '@/physics/system';
import { createDestructionService, registerDestructionBakes, resetDestruction } from '@/physics/destruction/system';
import { createWeaponService, registerWeaponsBakes, resetWeapons } from '@/weapons/system';
import { createBallisticsService, registerBallisticsBakes, resetBallistics } from '@/weapons/ballistics';
import { createViewmodelRig, registerViewmodelBakes, resetViewmodel } from '@/weapons/viewmodel/rig';
import { createVfxService, registerVfxBakes, resetVfx } from '@/vfx/system';
import { createAudioService, registerAudioBakes, resetAudio } from '@/audio/system';
import { createHudService, registerHudBakes, resetHud } from '@/ui/system';
import { createNavService, registerNavBakes, resetNav } from '@/ai/nav';
import { createAiService, registerAiBakes, resetAi } from '@/ai/system';
import { createPlayerService, registerPlayerBakes, resetPlayer } from '@/game/player';
import { createGameMode, registerModeBakes, resetMode } from '@/game/conquest';

export const SUBSYSTEMS: readonly SubsystemDescriptor[] = [
  /* ---------------------------------------------------------------- BAKE ---- */
  {
    key: 'assets',
    dependsOn: [],
    create: (ctx): AssetRegistry => createAssetRegistry(ctx),
    registerBakes: registerAssetsBakes,
    reset: resetAssets,
  },

  /* --------------------------------------------------------------- RCORE ---- */
  {
    key: 'materials',
    dependsOn: ['assets'],
    create: (ctx): MaterialFactory => createMaterialFactory(ctx),
    registerBakes: registerMaterialsBakes,
    reset: resetMaterials,
  },
  {
    key: 'graph',
    dependsOn: [],
    create: (ctx): RenderGraph => createRenderGraph(ctx),
    registerBakes: registerGraphBakes,
    reset: resetGraph,
  },
  {
    key: 'camera',
    dependsOn: [],
    create: (ctx): CameraRig => createCameraRig(ctx),
    registerBakes: registerCameraBakes,
    reset: resetCamera,
  },
  {
    key: 'renderer',
    dependsOn: ['graph', 'camera'],
    create: (ctx): RenderService => createRenderService(ctx),
    registerBakes: registerRendererBakes,
    reset: resetRenderer,
  },

  /* --------------------------------------------------------------- WORLD ---- */
  {
    key: 'sky',
    dependsOn: [],
    create: (ctx): SkyService => createSkyService(ctx),
    registerBakes: registerSkyBakes,
    reset: resetSky,
  },
  {
    key: 'lighting',
    dependsOn: ['sky'],
    create: (ctx): LightingService => createLightingService(ctx),
    registerBakes: registerLightingBakes,
    reset: resetLighting,
  },
  {
    key: 'terrain',
    dependsOn: ['materials'],
    create: (ctx): TerrainService => createTerrainService(ctx),
    registerBakes: registerTerrainBakes,
    reset: resetTerrain,
  },
  {
    key: 'water',
    dependsOn: ['materials', 'terrain'],
    create: (ctx): WaterService => createWaterService(ctx),
    registerBakes: registerWaterBakes,
    reset: resetWater,
  },
  {
    key: 'vegetation',
    dependsOn: ['terrain'],
    create: (ctx): VegetationService => createVegetationService(ctx),
    registerBakes: registerVegetationBakes,
    reset: resetVegetation,
  },
  {
    key: 'level',
    dependsOn: ['materials', 'terrain'],
    create: (ctx): LevelService => createLevelService(ctx),
    registerBakes: registerLevelBakes,
    reset: resetLevel,
  },

  /* ---------------------------------------------------------------- PHYS ---- */
  {
    key: 'physics',
    dependsOn: [],
    create: (ctx): PhysicsService => createPhysicsService(ctx),
    registerBakes: registerPhysicsBakes,
    reset: resetPhysics,
  },
  {
    key: 'destruction',
    dependsOn: ['physics', 'level'],
    create: (ctx): DestructionService => createDestructionService(ctx),
    registerBakes: registerDestructionBakes,
    reset: resetDestruction,
  },

  /* ------------------------------------------------------------- WEAPONS ---- */
  {
    key: 'weapons',
    dependsOn: ['assets'],
    create: (ctx): WeaponService => createWeaponService(ctx),
    registerBakes: registerWeaponsBakes,
    reset: resetWeapons,
  },
  {
    key: 'ballistics',
    dependsOn: ['weapons', 'physics'],
    create: (ctx): BallisticsService => createBallisticsService(ctx),
    registerBakes: registerBallisticsBakes,
    reset: resetBallistics,
  },
  {
    key: 'viewmodel',
    dependsOn: ['weapons'],
    create: (ctx): ViewmodelRig => createViewmodelRig(ctx),
    registerBakes: registerViewmodelBakes,
    reset: resetViewmodel,
  },

  /* ------------------------------------------------- PRESENTATION SERVICES -- */
  {
    key: 'vfx',
    dependsOn: ['materials'],
    create: (ctx): VfxService => createVfxService(ctx),
    registerBakes: registerVfxBakes,
    reset: resetVfx,
  },
  {
    key: 'audio',
    dependsOn: [],
    create: (ctx): AudioService => createAudioService(ctx),
    registerBakes: registerAudioBakes,
    reset: resetAudio,
  },
  {
    key: 'hud',
    dependsOn: ['assets'],
    create: (ctx): HudService => createHudService(ctx),
    registerBakes: registerHudBakes,
    reset: resetHud,
  },

  /* ------------------------------------------------------------ AI + GAME ---- */
  {
    key: 'nav',
    dependsOn: ['level'],
    create: (ctx): NavService => createNavService(ctx),
    registerBakes: registerNavBakes,
    reset: resetNav,
  },
  {
    key: 'ai',
    // `player` as well as `nav`/`level`: AI hands its `intentSource` to
    // `PlayerService.attachController` for every bot it spawns, and a service
    // read at construction time must be declared here.
    dependsOn: ['nav', 'level', 'player'],
    create: (ctx): AiService => createAiService(ctx),
    registerBakes: registerAiBakes,
    reset: resetAi,
  },
  {
    key: 'player',
    dependsOn: ['physics'],
    create: (ctx): PlayerService => createPlayerService(ctx),
    registerBakes: registerPlayerBakes,
    reset: resetPlayer,
  },
  {
    key: 'mode',
    dependsOn: ['level', 'player'],
    create: (ctx): GameMode => createGameMode(ctx),
    registerBakes: registerModeBakes,
    reset: resetMode,
  },
];
