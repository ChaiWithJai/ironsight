# IRONSIGHT — OWNERSHIP

**The anti-collision map.** Every file in the repo belongs to exactly one lane. If a path is not
listed under your lane, you do not edit it — not to "quickly fix" something, not to add an import.
If you need something from another lane it is already a method on a service in
`src/engine/types.ts`.

Read `docs/ARCHITECTURE.md` first; this table is its index.

---

## The three shared files, and the one shared-but-sectioned file

| File | Rule |
|---|---|
| `src/engine/harness.ts` | **LOCKED.** Nobody edits it, including CORE. |
| `src/bootstrap/subsystems.ts` | Written by CORE on day 0, revised once before fan-out to wire all three hooks for all 23 descriptors. **THE FREEZE BEGINS NOW — never edited again.** Lanes replace the body of the file their factory points at. |
| `src/bootstrap/nulls.ts` | Written by CORE on day 0 and revised once, pre-fan-out, to implement the contract members added by the seam-closure pass. **THE FREEZE BEGINS NOW — never edited again.** |
| `src/shots/index.ts` | Written once by CORE on day 0 as an `import.meta.glob` loader. **Never edited again** — lanes only create `src/shots/<lane>.ts`. |
| `src/engine/types.ts` | Sectioned, one named amender per section (the banner says who). Additions are **append-only inside your own section**, must be narrow, and must be called out in your report. |

---

## The three named exports every lane ships

Your lane's entry file exports exactly these three symbols. `src/bootstrap/subsystems.ts` imports
them **by name and by path** and is frozen, so renaming, moving or re-signing any of them breaks the
build for everyone. See `docs/ARCHITECTURE.md` §2.1 for the pattern and the worked example.

| Lane | Entry file | `create` | `registerBakes` | `reset` |
|---|---|---|---|---|
| BAKE | `src/bake/registry.ts` | `createAssetRegistry` | `registerAssetsBakes` | `resetAssets` |
| RCORE | `src/render/material/factory.ts` | `createMaterialFactory` | `registerMaterialsBakes` | `resetMaterials` |
| RCORE | `src/render/graph.ts` | `createRenderGraph` | `registerGraphBakes` | `resetGraph` |
| RCORE | `src/render/camera-rig.ts` | `createCameraRig` | `registerCameraBakes` | `resetCamera` |
| RCORE | `src/render/service.ts` | `createRenderService` | `registerRendererBakes` | `resetRenderer` |
| LIGHT | `src/render/lighting/service.ts` | `createLightingService` | `registerLightingBakes` | `resetLighting` |
| SKY | `src/world/sky/system.ts` | `createSkyService` | `registerSkyBakes` | `resetSky` |
| TERRAIN | `src/world/terrain/system.ts` | `createTerrainService` | `registerTerrainBakes` | `resetTerrain` |
| WATER | `src/world/water/system.ts` | `createWaterService` | `registerWaterBakes` | `resetWater` |
| VEG | `src/world/vegetation/system.ts` | `createVegetationService` | `registerVegetationBakes` | `resetVegetation` |
| LEVEL | `src/level/harbour-reach.ts` | `createLevelService` | `registerLevelBakes` | `resetLevel` |
| PHYS | `src/physics/system.ts` | `createPhysicsService` | `registerPhysicsBakes` | `resetPhysics` |
| PHYS | `src/physics/destruction/system.ts` | `createDestructionService` | `registerDestructionBakes` | `resetDestruction` |
| WEAPONS | `src/weapons/system.ts` | `createWeaponService` | `registerWeaponsBakes` | `resetWeapons` |
| WEAPONS | `src/weapons/ballistics.ts` | `createBallisticsService` | `registerBallisticsBakes` | `resetBallistics` |
| WEAPONS | `src/weapons/viewmodel/rig.ts` | `createViewmodelRig` | `registerViewmodelBakes` | `resetViewmodel` |
| VFX | `src/vfx/system.ts` | `createVfxService` | `registerVfxBakes` | `resetVfx` |
| AUDIO | `src/audio/system.ts` | `createAudioService` | `registerAudioBakes` | `resetAudio` |
| HUD | `src/ui/system.ts` | `createHudService` | `registerHudBakes` | `resetHud` |
| AI | `src/ai/nav.ts` | `createNavService` | `registerNavBakes` | `resetNav` |
| AI | `src/ai/system.ts` | `createAiService` | `registerAiBakes` | `resetAi` |
| GAME | `src/game/player.ts` | `createPlayerService` | `registerPlayerBakes` | `resetPlayer` |
| GAME | `src/game/conquest.ts` | `createGameMode` | `registerModeBakes` | `resetMode` |

Every `create` takes one argument: the full `BootContext`. Every `registerBakes` takes
`(assets, quality)` and may only *declare* steps. Every `reset` takes `(seed)`.

---

## Lane table

| Lane | Owns (globs) | Exposes from `types.ts` | Registers shots |
|---|---|---|---|
| **CORE** | `src/main.ts`<br>`src/bootstrap/**`<br>`src/engine/*.ts` (except `harness.ts`, which is locked) — this includes `src/engine/renderer.ts`, the `WebGLRenderer` construction and `EXT_color_buffer_float` probe<br>`src/engine/math/**`<br>`src/shots/index.ts`<br>`tools/**` | `Services`, `ServiceRegistry`, `BootContext`, `SubsystemDescriptor`, `Engine`, `Clock`, `Rng`, `EventBus`/`SimBus`/`FxBus`/`FxEmitter`, `EntityStore`, `ComponentStore`, `TickCtx`, `FrameCtx`, `TickSystem`, `RenderSystem`, `TickPhase`, `RenderStage`, `QualityService`, `QualitySettings`, `GpuCaps`, `InputService`, `PlayerIntent`, `IntentSource`, `SceneGraph`, `Profiler`, `DebugService`, `MacroTerrain`, `Sim` | `core` |
| **BAKE** | `src/bake/**` | `AssetRegistry`, `AssetKey`, `BakeStep`, `BakeRunContext`, `BakeProgress`, `BakeStats`, `GpuBakeDevice`, `GpuBakeDesc`, `WorkerPool`, `NoiseLib`, `MipMode`, `BakeKind`, `AssetKind`, `TextureSet`, `MeshAsset`, `AudioAsset`, `BakedFont`, `GeometrySpec` (producer side) | `bake` |
| **RCORE** | `src/render/service.ts`<br>`src/render/graph.ts`<br>`src/render/targets.ts`<br>`src/render/fullscreen.ts`<br>`src/render/camera-rig.ts`<br>`src/render/color.ts`<br>`src/render/material/**`<br>`src/render/passes/**` | `RenderService`, `RenderGraph`, `RenderPass`, `RTId`, `RTFormat`, `RTDesc`, `RTHistory`, `PassOrder`, `CameraRig`, `CameraState`, `MaterialFactory`, `MaterialSpec`, `MaterialFeature`, `SurfaceId`, `SurfaceProfile`, `GeometrySpec` (consumer side), `RenderLayer` | `render`, `material` |
| **LIGHT** | `src/render/lighting/**` | `LightingService`, `LocalLight`, `LightType`, `SunState` | `lighting` |
| **SKY** | `src/world/sky/**` | `SkyService`, `SkyState` | `sky` |
| **TERRAIN** | `src/world/terrain/**` | `TerrainService` | `terrain` |
| **WATER** | `src/world/water/**` | `WaterService` | `water` |
| **VEG** | `src/world/vegetation/**` | `VegetationService`, `ExclusionHandle` | `vegetation` |
| **LEVEL** | `src/level/**` | `LevelService`, `CapturePointDef`, `CapturePointId`, `SpawnPointDef`, `CoverSlot`, `CameraRigPose`, `StaticColliderDef`, `NavmeshData` (producer side) | `level` |
| **PHYS** | `src/physics/**` | `PhysicsService`, `BodyDesc`, `BodyMode`, `BodyHandle`, `ColliderShape`, `RayHit`, `QueryFilter`, `CollisionGroup`, `LAYER_SOLID`, `LAYER_SHOOTABLE`, `CharacterController`, `CharacterConfig`, `CharacterMoveResult`, `DestructionService`, `DestructibleDef`, `DestructionResult` | `physics`, `destruction` |
| **WEAPONS** | `src/weapons/**` | `WeaponService`, `WeaponId`, `WeaponDef`, `WeaponState`, `WeaponFeelState`, `FireMode`, `RecoilPattern`, `SpreadDef`, `ViewFeelDef`, `AdsDef`, `BallisticsDef`, `BallisticsService`, `ShotRequest`, `ImpactEvent`, `ViewmodelRig` | `weapons`, `ballistics` |
| **VFX** | `src/vfx/**` | `VfxService`, `VfxId`, `VfxSpawnParams`, `DecalKind`, `DecalRequest`, `VfxHandle`, `DecalHandle` | `vfx` |
| **AUDIO** | `src/audio/**` | `AudioService`, `SoundId`, `SoundEmitDesc`, `AcousticEnvironment`, `SoundHandle` | `audio` |
| **AI** | `src/ai/**` | `AiService`, `NavService`, `BotProfile`, `BotView`, `BotBehaviour`, `SquadOrder`, `NavmeshData` (consumer side) | `ai` |
| **HUD** | `src/ui/**` | `HudService`, `KillFeedEntry`, `BakedFont` (consumer side) | `hud` |
| **GAME** | `src/game/**` | `PlayerService` (incl. `stateOf` / `intentOf` / `attachController` / `releaseController` / `controlled` / `localEntity`), `PlayerState`, `Stance`, `GameMode`, `MatchState`, `MatchPhase`, `CaptureState`, `CapturePointRuntime`, `PlayerScore`, `SpawnChoice`, `Team`, `DamageInfo`, `DamageKind`, `HitZone` | `game` |

**GAME additionally owns per-entity intent dispatch** — the only two `TickSystem`s at
`TickPhase.Intent` and `TickPhase.Movement` in the whole repo. See `docs/ARCHITECTURE.md` §3.4.

### Render passes owned by a content lane, not by RCORE

`src/render/passes/**` is RCORE's directory, so a pass that lives anywhere else needs saying out
loud or two lanes register the same slot and both run.

| `PassOrder` slot | Registered by | Lives in |
|---|---|---|
| `PostResolveVfx` (pass 20) | **VFX** | `src/vfx/` |
| `Simulate` | any GPU-simulating lane (VFX first) | that lane's directory |
| `ForwardWater` (pass 14) + the `SceneColorCopy` blit at `subOrder: -10` | **WATER** | `src/world/water/` |
| `Underwater` | **WATER** | `src/world/water/` |
| `Hud` (pass 27) | **HUD** | `src/ui/` |
| `Gtao`, `Ssr`, `Volumetrics` | **LIGHT** | `src/render/lighting/` |
| `SkyLuts`, `SkyRender` | **SKY** | `src/world/sky/` |

Every one of these is registered from `BootContext.afterBoot`, never from the factory body — see
`docs/ARCHITECTURE.md` §2.2.

### Four paths that get confused, and who owns each

| Path | Lane | What it is |
|---|---|---|
| `src/engine/renderer.ts` | CORE | constructs the one `THREE.WebGLRenderer` and probes `EXT_color_buffer_float` |
| `src/render/service.ts` | RCORE | `RenderService` facade + resize path + the `RenderStage.Submit` system |
| `src/ui/renderer.ts` | HUD | the in-canvas 2D layer: instanced quads, one draw per material |
| `src/render/lighting/service.ts` | LIGHT | `LightingService`, not RCORE's — `src/render/lighting/**` is LIGHT's whole directory |

---

## `types.ts` section amenders

Only the named lane may append to a section, and only additively. The banner in the file is
authoritative; this is the index.

| Section | Amender |
|---|---|
| 0 Primitives · 1 Determinism · 2 Quality · 3 Input · 4 Events · 5 Entities · 6 Frame lifecycle · 7 Services · 8 Profiling · 11 Scene graph · 23 Harness re-exports | CORE |
| 9 Bake + assets | BAKE |
| 10 Surfaces + materials · 12 Render graph + camera | RCORE |
| 13 Lighting | LIGHT |
| 14 Sky | SKY |
| 15 Terrain / water / vegetation / level | TERRAIN (TERRAIN coordinates; WATER, VEG and LEVEL append to their own interfaces) |
| 16 Physics + destruction | PHYS |
| 17 Weapons + ballistics | WEAPONS |
| 18 VFX + decals | VFX |
| 19 Audio | AUDIO |
| 20 HUD | HUD |
| 21 Navigation + AI | AI |
| 22 Player + game mode | GAME |

Section 22 was amended once by CORE on day 0, before fan-out, to add the per-entity locomotion seam
(`PlayerService.stateOf` and the controller table). GAME owns it from here.

**Sections 0, 3, 4, 7, 9, 10, 11, 12, 15, 16, 17, 20, 21 and 22 were amended once by CORE, before
fan-out, in the seam-closure pass** — four agents simulated real lane work against the contract and
found thirty places where it was type-complete and behaviourally insufficient. Each section's named
amender owns it from here; the additions are listed in that commit's report and every one of them is
additive except three deliberate re-signings (`MaterialFactory.registerDeform` now takes a
`DeformChunk`, `RenderPass.setup` also receives `QualitySettings`, and `MatchState.tickets` /
`CapturePointRuntime.occupants` are `Record<Team, number>` rather than 2-tuples).

---

## Shot roster

One file per lane, at `src/shots/<name>.ts`, picked up automatically by the glob in
`src/shots/index.ts`. Shot files are **thin**: pose the camera, force state, return. No
module-level side effects, no imports outside your lane — one broken shot file breaks the capture
tool for everyone.

| Shot file | Lane | Must prove |
|---|---|---|
| `core.ts` | CORE | the engine boots, the graph runs, a frame lands — the smoke test the whole repo depends on |
| `bake.ts` | BAKE | material chart: close-up, grazing angle, and at distance — no tiling, no smoothness on approach |
| `render.ts` | RCORE | TAA convergence, motion blur, bloom threshold, tonemap ramp; tier A/B |
| `material.ts` | RCORE | the uber material across every `SurfaceId`, wear and micro-detail readable at 0.3 m |
| `lighting.ts` | LIGHT | cascade transitions, PCSS contact hardening, GTAO in creases, SSR on wet stone |
| `sky.ts` | SKY | golden-hour sky, clouds, god rays, aerial perspective pushing the headland into haze |
| `terrain.ts` | TERRAIN | headland, beach, erosion channels, splat transitions, cliff strata |
| `water.ts` | WATER | sun glitter off the water, shoreline foam, refraction, the half-sunk freighter waterline |
| `vegetation.ts` | VEG | palms in wind, grass field density falloff, LOD/impostor transition |
| `level.ts` | LEVEL | ALPHA / BRAVO / CHARLIE establishing shots, ground transitions, no hard seams |
| `physics.ts` | PHYS | character on a slope and a stair, debris pile at rest, ragdoll |
| `destruction.ts` | PHYS | a cover wall mid-collapse and after settle, with the sightline it opened |
| `weapons.ts` | WEAPONS | hip / ADS / mid-burst / reload viewmodel poses, muzzle flash lighting the world |
| `ballistics.ts` | WEAPONS | tracer over distance, penetration through a wall, ricochet off steel |
| `vfx.ts` | VFX | surface-keyed impacts, smoke plume, explosion, decal accumulation |
| `audio.ts` | AUDIO | the mixer / occlusion debug overlay rendered in-canvas (audio still needs a visual proof) |
| `ai.ts` | AI | a bot squad advancing and using cover, path debug, soldier silhouette at 3 LODs |
| `hud.ts` | HUD | the full HUD in combat, plus the scoreboard and deploy screens |
| `game.ts` | GAME | a contested capture in progress: capture bar, tickets bleeding, killfeed live |

---

## Boundary CI

`tools/check-boundaries.mjs` (owned by CORE) runs inside `npm run verify` — which is
`typecheck && boundaries && build`, is green today, and must be green when you finish. **Never
weaken a rule to make your code pass; fix the code.** It fails the build on any of these:

- an import from another lane's directory
- `Math.random(` anywhere in `src/`
- `new THREE.Mesh*Material` outside `src/render/material/`
- `new THREE.ShaderMaterial` / `new THREE.RawShaderMaterial` outside `src/render/` — unlit UI,
  gizmos and sky go through `MaterialFactory.createUnlit`
- `onBeforeCompile` outside `src/render/material/`
- `renderer.setRenderTarget` outside `src/render/`
- `performance.now(` / `Date.now(` outside `src/engine/clock.ts` and `src/engine/profiler.ts`
