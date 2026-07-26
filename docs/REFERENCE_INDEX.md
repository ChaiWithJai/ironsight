# IRONSIGHT — Reference Index

**Purpose.** This file tells the visual critic loop *which real Battlefield frame to blind-A/B each
IRONSIGHT shot against*. It exists so a critic handed "shot `hero_harbour`" can go straight to two
or three fair comparison partners instead of browsing 183 images.

**Usage.**

```bash
./tools/compare.sh --ours hero_harbour --ref reference/gameplay/bf6_gp_019.jpg
```

**The fairness rule.** A blind A/B only tests *our rendering* if the reference is matched for time
of day, environment type and camera framing. Comparing our golden-hour first-person harbour shot
against a snow-blue WWII cutscene tests subject matter, not craft, and the critic will pick ours
out for the wrong reason. Every pairing below is chosen on that basis, and the
[DO NOT COMPARE AGAINST](#do-not-compare-against) list exists to stop the obviously unfair ones
being used by accident.

**Provenance of these notes.** All 183 images were triaged at contact-sheet resolution. Every frame
named in the tables below was then opened and read at full resolution. Frames I did not open at
full resolution are not recommended in this document.

---

## 1. What the corpus actually contains

| Set | Count | Honest state |
|---|---|---|
| `gameplay/bf6_gp_*` | 40 | **The strongest set.** Mostly genuine 1080p+ multiplayer captures with live HUD. A Pacific/Mediterranean coastal-resort map dominates — palms, turquoise shallows, seawalls, terracotta roofs. This is the closest thing in the corpus to HARBOUR REACH. Also ~8 menu/end-of-round/key-art frames that are useless. |
| `gameplay/bf2042_gp_*` | 40 | Mixed. Perhaps 15 real in-game frames; the rest are scoreboards, loadout screens, end-of-round and portrait crops. The real ones are valuable for **hard desert sun**, **iron-sight ADS** and **explosion/fire VFX**. |
| `gameplay/bfv_gp_*` | 40 | Roughly 40% are letterboxed War Story *cutscenes*, not gameplay — treat those as press-tier. The genuine multiplayer frames are excellent for **contre-jour hard sun**, **rubble/destruction** and **cool-shadow grade**. |
| `gameplay/redsec_gp_*` | 15 | **Mostly junk.** Memes, error dialogs, logos, promo art, 384×215 and 512×512 crops. Two or three frames are usable. Do not spend critic time here. |
| `battlefield/*` (press) | 48 | Staged bullshots. No HUD, third-person hero framing, character close-ups. **Lighting ambition only** — never a framing or HUD partner. |

**Known duplicate:** `bf6_gp_038.jpg` and `redsec_gp_008.jpg` are byte-identical (same MD5). Use
`bf6_gp_038`; ignore the REDSEC copy.

**Non-standard frames** (avoid — the aspect ratio alone will give the A/B away):
`bf2042_gp_004` (1920×475), `bf6_gp_017` (1920×569), `bf6_gp_020` (1920×2452), `bf6_gp_031`
(872×1112), `bf2042_gp_010` / `bf2042_gp_011` / `bf6_gp_002` (portrait), and every REDSEC frame
under 1280 px wide (`redsec_gp_000`, `003`, `004`, `005`, `007`, `009`, `014`).

---

## 2. Master table — the useful frames

Sorted by usefulness within each title.

### Battlefield 6 (gameplay)

| File | What it is | Best reference FOR |
|---|---|---|
| `bf6_gp_019.jpg` | FP infantry, high midday sun, coastal resort — pool, palms, red-tile pavilions, open sea horizon. Full live HUD. | **The single best all-round partner.** HUD layout at rest, palm foliage in hard light, water-vs-sky value separation, sandstone/stucco albedo, weapon silhouette against a bright field. |
| `bf6_gp_013.jpg` | FP from a boat at sea level, hands on a mounted MG, harbour crane + burning dock on the far shore, water droplets on lens. | **Water.** Sea-level wave shape, sub-surface teal→deep-blue gradient, foam, specular breakup, waterline against a shoreline. Also harbour-crane silhouette and lens-droplet treatment. |
| `bf6_gp_016.jpg` | Squad on a balustrade above a Mediterranean hill town — terracotta roofs, cypress, stucco, blown sun through drifting smoke. Third-person, no HUD. | **Architecture and grade for HARBOUR REACH.** Roof/wall colour language, cypress-and-stucco silhouette, sun bloom disc through smoke, aerial perspective at 200–600 m. |
| `bf6_gp_039.jpg` | FP campaign vista over a burning valley town, low backlit sun, volumetric shafts through smoke, distance markers in world space. | **Long-range vista + volumetrics.** Backlit haze, god-rays, fire glow read at distance, minimal-HUD framing with 100 m/130 m world labels. |
| `bf6_gp_008.jpg` | Ultrawide (1920×804) no-HUD vista of the same valley — forest fires, smoke columns, rock and pine, construction crane. | Aerial perspective and smoke-column layering. Ultrawide, so crop before comparing. |
| `bf6_gp_025.jpg` | Soldier on a headland ruin looking down at a burning coastal city, landing craft on the water, thick low smoke. Letterboxed cutscene. | **`headland_vista` subject match** — this is CHARLIE looking down at the harbour. Smoke-over-water, city-scale haze, low-contrast distant values. |
| `bf6_gp_024.jpg` | FP infantry, hard blue-sky day, palm-lined base road, scoped rifle held low-ready, full HUD. | **`hud_full` and viewmodel framing.** Where the weapon sits in frame at hip-ready, forearm/glove material, HUD legibility over a bright road. |
| `bf6_gp_038.jpg` | FP infantry mid-capture, helicopter landing 20 m away, palms and chain-link, full HUD with capture progress and "NEUTRALIZING" callouts. | **HUD under load** — objective progress bar, capture callouts, killfeed, XP ticker all live at once. Also rotor-downwash dust. |
| `bf6_gp_032.jpg` | FP infantry on a resort path, bougainvillea in bloom, jet overhead, scoped rifle raised, full HUD. | Saturated foliage that does not blow out, thin-object (palm frond, contrail) antialiasing, sky gradient with cumulus. |
| `bf6_gp_015.jpg` | FP parachute descent, hands on risers, turquoise shallows over a stone seawall and breakwater below. | **Shallow-water shading** — depth-based transmission over sand and rock, wet-stone breakwater, top-down water read. Also aerial framing over a town. |
| `bf6_gp_034.jpg` | Letterboxed vista of a lakeside village in a mountain basin, heavy atmospheric haze, birds, poplars. | **Aerial perspective, pure.** The cleanest example in the corpus of distance→desaturation→value-lift. Reference this when our headland looks too contrasty at range. |
| `bf6_gp_023.jpg` | Letterboxed combat cutscene: soldiers behind a concrete barrier, large fuel fireball, embers, dust haze, blown-out sun side. | **`firefight` VFX.** Fireball structure, ember distribution, smoke that catches key light, contact shadows on flat concrete under an overcast-bright sky. |
| `bf6_gp_018.jpg` | Full-frame smoke and fire cloud with helicopter silhouettes; almost no geometry. | **Smoke shading only.** Value range of lit vs shadowed smoke, fire bounce into the underside of a plume. Not a framing partner. |
| `bf6_gp_028.jpg` | Night, rain, gunboat on a river beside a lit city skyline and bridge. No HUD. | **`night_flares` emissives.** Window-light density, reflections stretching on dark water, how little the sky is allowed to go to pure black. |
| `bf6_gp_026.jpg` | Night urban campaign frame with title-card text. | Night ambient level and emissive falloff only. Text overlay makes it unusable as a direct A/B. |

### Battlefield 2042 (gameplay)

| File | What it is | Best reference FOR |
|---|---|---|
| `bf2042_gp_022.jpg` | FP infantry in a desert village, blown white sky, hot concrete plaza, deep shade under a corrugated wall, palm and bougainvillea. Full HUD. | **`market_square` lighting.** Hard-sun/deep-shade split, blown highlight handling, sand-dust in the air, warm bounce into shadow. The best hard-sun infantry frame in the corpus. |
| `bf2042_gp_000.jpg` | FP **iron-sight ADS** on a concrete barrier at ~39 m, sights and target in shallow focus, red damage vignette, full HUD. | **`viewmodel_ads`.** Post ring/front post proportion, ADS depth-of-field falloff, how much of frame the sight occupies, hit-vignette treatment. |
| `bf2042_gp_027.jpg` | FP infantry, huge orange fuel fireball to the right, tornado column, flying debris, overcast grey sky. Full HUD. | **`firefight`.** Fireball → smoke transition, debris silhouettes, muzzle-adjacent weapon exposure against a blown-hot light source. |
| `bf2042_gp_006.jpg` | FP infantry on a rooftop at dusk/overcast, squad around, beached container freighter and harbour cranes in fog. Full HUD. | **Half-sunk freighter + harbour infrastructure**, flat overcast key, distance fog on a large hull. Useful when our BRAVO cranes read too clean. |
| `bf2042_gp_035.jpg` | FP inside a dark industrial hangar packed with soldiers, magenta/teal emissive bounce, tracer streaks, muzzle flashes. Full HUD. | **`night_flares` and interior emissives.** Coloured practical lights on figures, tracer streak length, HUD legibility against a dark cluttered field. |
| `bf2042_gp_020.jpg` | FP prone in red desert sand, low camera. | Ground-plane micro-detail and prone camera height. Environment colour is too alien for a fair grade comparison. |

### Battlefield V (gameplay)

| File | What it is | Best reference FOR |
|---|---|---|
| `bfv_gp_028.jpg` | Harbour town square, **strong contre-jour**: sun behind a stone arch, wet cobbles throwing long specular streaks, deep foreground shade, dust motes, blue sky with cumulus. | **`market_square`, best in class.** Interior-arch-to-exterior-square transition, silhouetted figures with rim light, cobble specular, shadow-to-sky dynamic range. |
| `bfv_gp_038.jpg` | FP infantry advancing through harbour rubble toward a ruined church and a beached hull; cool blue key, orange fire pockets. Full HUD. | **Destruction.** Rubble scatter and size distribution, broken masonry silhouettes, warm-fire-in-cool-shadow colour contrast, HUD over a busy dark field. |
| `bfv_gp_036.jpg` | FP on a tractor in a lavender field at dawn, pastel salmon/lilac sky, long soft shadows, hills fading into haze. Full HUD. | **Golden/blue-hour sky and aerial perspective.** Sky gradient with warm underlit cloud, dense low vegetation in low sun, saturated field that stays in gamut. |
| `bfv_gp_031.jpg` | FP infantry in a snow-lit courtyard: hard sun on one wall, deep blue shade on the adjacent one, shell-holed masonry. Full HUD. | **Ambient colour in shade.** Explicit demonstration that shadow is *sky-blue lit*, not black. Use for our shadow-tint calibration; ignore the snow palette. |
| `bfv_gp_001.jpg` | FP revolver, meadow and dirt track leading into a Tuscan-style village at low sun, teammates and a jeep. Full HUD (plus an on-screen perf overlay). | Warm low-sun village grade and grass shading. **Caveat:** carries a third-party FPS/telemetry overlay — crop the top-left before A/B. |
| `bfv_gp_002.jpg` | Night, heavy fog, strongly stylised teal/magenta War Story grade. | Night volumetrics ambition only. The grade is too authored to be a fair partner. |

### REDSEC (gameplay)

| File | What it is | Best reference FOR |
|---|---|---|
| `redsec_gp_013.jpg` | Cutscene close-up of an operator holding a weapon, blurred coastal cliff behind. | Weapon **material** detail in daylight — anodised metal, polymer, rim light on a barrel. Not a framing partner: it is a cutscene close-up with heavy DOF. |

Everything else in `redsec_gp_*` is non-gameplay. See the DO NOT list.

### Press (`reference/battlefield/`) — atmosphere ambition only

| File | What it is | Use for |
|---|---|---|
| `bf1_05.jpg` | Mediterranean limestone scrub under hard sun, third-person. | Rock and dry-scrub albedo, hard-sun terrain contrast for the headland. |
| `bf6_05.jpg` | Season key art: carrier, palms bent in wind, fireball, waders, big type. | Nothing but mood. **It has marketing typography burned in.** |
| `bf6_09.jpg` | Staged hero composition. | Mood only. |

Treat the whole press folder as a mood board. It is never a legitimate blind-A/B partner, because
no-HUD third-person bullshot framing makes the "which is the real game" question trivial for the
wrong reason.

---

## 3. COMPARISON PAIRS

For each planned IRONSIGHT shot: the frames to blind-A/B against, in priority order, and what the
comparison is actually testing.

**Two frames per shot are in-game captures with a live HUD — those are the real blind A/B.** Where a
third entry is a letterboxed or ultrawide frame (`bf6_gp_025`, `bf6_gp_023`, `bf6_gp_034`,
`bf6_gp_008`, `bf6_gp_016`), it is a *targeted* comparison, not a blind one: **crop the bars off,
and judge the named property only** (haze, smoke, architecture), never framing or UI. Do not run a
randomised blind A/B against a letterboxed frame — the bars decide it before the critic looks at
the pixels.

### `hero_harbour` — FP infantry, golden hour, town + water

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf6_gp_019.jpg` | FP infantry, coastal town, open water, sun high-and-hard, live HUD. Matched on framing, environment and HUD presence. Tests our sandstone albedo, palm foliage, water horizon and HUD weight simultaneously. |
| 2 | `gameplay/bf6_gp_016.jpg` | Same Mediterranean architecture and colour language at a comparable sun angle. Framing is third-person, so **crop to the town and compare the environment only** — this is the architecture/grade check, not the framing check. |
| 3 | `gameplay/bfv_gp_036.jpg` | Matched on *time of day* rather than subject: genuine low-sun sky gradient and long soft shadows with a live HUD. Use when the question is "is our golden hour actually golden hour". |

*Do not* pair this shot with `bf6_gp_034` — that frame's haze level is far heavier than a hero
foreground shot should be, and it will read as a different weather state.

### `viewmodel_ads` — weapon ADS close

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf2042_gp_000.jpg` | The corpus's only clean iron-sight ADS frame. Tests sight-post proportion, ADS FOV, focus falloff between sight and target, and that the weapon is *not* uniformly sharp. |
| 2 | `gameplay/bf6_gp_032.jpg` | Optic raised toward centre, bright daylight. Tests scope-body material, tube shading, glove/forearm detail and how the weapon separates from a bright background. |
| 3 | `gameplay/bf6_gp_024.jpg` | Same weapon class at low-ready with the same HUD. Use as the paired "hip vs ADS" control — our ADS transition should move the weapon between these two positions. |

Secondary, materials only: `gameplay/redsec_gp_013.jpg` for barrel/receiver microdetail. Never for
framing.

### `market_square` — interior/exterior transition, hard sun + deep shade

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bfv_gp_028.jpg` | Textbook contre-jour town square: shaded arch in the foreground, blown sky, wet cobble specular, dust in the shafts. Exactly the dynamic range our shot has to survive. |
| 2 | `gameplay/bf2042_gp_022.jpg` | FP infantry, hard sun on a plaza with a deeply shaded wall two metres away, live HUD. The direct like-for-like on sun/shade split *with* HUD. |
| 3 | `gameplay/bfv_gp_031.jpg` | Adjacent lit and shaded walls in one frame. The specific test: is our shadow ambient sky-tinted, or is it grey mud? |

### `headland_vista` — long-range vista, aerial perspective

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf6_gp_025.jpg` | Elevated ruin looking down at a smoking coastal city and its water. Same subject as CHARLIE. Tests haze, smoke-over-water and distant value compression. |
| 2 | `gameplay/bf6_gp_039.jpg` | FP vista with backlit low sun, volumetric shafts and world-space distance labels. Tests god-rays and the readability of distant geometry through haze. |
| 3 | `gameplay/bf6_gp_034.jpg` | The purest aerial-perspective sample: water, hills and mountains at three distinct depth bands. Reference this if our headland is holding too much contrast at range. |

Ultrawide alternate: `gameplay/bf6_gp_008.jpg` (crop to 16:9 first).

### `firefight` — combat with VFX, smoke, tracers

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf2042_gp_027.jpg` | FP infantry, live HUD, large fuel fireball and debris in frame. Matched on framing *and* on having UI competing with VFX. |
| 2 | `gameplay/bf6_gp_023.jpg` | Fireball, embers and dust-haze at close range with figures for scale. Tests ember density and whether our fire lights the environment or just sits on top of it. |
| 3 | `gameplay/bf6_gp_038.jpg` | Live-fire capture moment with downwash dust and full combat HUD state. Use when the question is "does a busy combat frame stay readable". |

Smoke-only spot check (not a framing partner): `gameplay/bf6_gp_018.jpg`.

### `night_flares` — low light + emissives

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf2042_gp_035.jpg` | Real gameplay at low light with coloured practicals, tracers and muzzle flashes, full HUD. The only frame that tests emissives *and* HUD legibility in the dark together. |
| 2 | `gameplay/bf6_gp_028.jpg` | Night over water with a lit skyline. Tests emissive reflection on dark water and that our night sky is not crushed to black. |
| 3 | `gameplay/bfv_gp_038.jpg` | Cool low-key daylight with warm fire pockets. Not night, but the closest gameplay frame for warm-emissive-in-cool-ambient balance with a live HUD. |

Ambition only, not for A/B: `gameplay/bf6_gp_026.jpg`, `gameplay/bfv_gp_002.jpg`.

### `hud_full` — HUD legibility over gameplay

| Rank | Reference | Why it is fair |
|---|---|---|
| 1 | `gameplay/bf6_gp_024.jpg` | Clean 1080p, full modern HUD at rest over a bright environment. The baseline legibility test. |
| 2 | `gameplay/bf6_gp_038.jpg` | Same HUD in a loaded state: capture progress, callouts, killfeed and XP ticker simultaneously. Tests our hierarchy under pressure. |
| 3 | `gameplay/bf6_gp_019.jpg` | Same HUD over a high-key sea-and-sky background — the hardest legibility case, where light UI has to hold against a bright field. |

Cross-generation control (only if the critic needs a different UI dialect):
`gameplay/bf2042_gp_022.jpg` for a bottom-heavy HUD, `gameplay/bfv_gp_038.jpg` for a sparse one.

---

## 4. DO NOT COMPARE AGAINST

Using any of these as a blind-A/B partner produces a result that says nothing about our rendering.

| Frame(s) | Reason |
|---|---|
| `bf6_gp_003`, `bf6_gp_007` | End-of-round / Top Squad screens. Full-screen menu chrome over a blurred backdrop with posed character line-ups. Tests UI mockup skill, not rendering. |
| `bf6_gp_005` | Season key art with marketing typography burned into the frame. |
| `bf6_gp_035`, `bf6_gp_000` | Vehicle frames (jet chase-cam, patrol boat) with a **vehicle HUD** — altimeter ladders, throttle, radar, `AFTERBURNER`/`DEPLOY RAMP` prompts. We have no vehicles and no vehicle HUD; the comparison is decided by content we deliberately do not ship. |
| `bf6_gp_021` and other cockpit/optic frames | Helicopter and armour cockpit interiors. Same reason. |
| `bf6_gp_036` | Melee kill-cam close-up with blood-on-lens, ultrawide. Extreme close framing plus a full-screen effect we do not have. |
| `bf6_gp_002`, `bf6_gp_031`, `bf2042_gp_010`, `bf2042_gp_011` | Portrait-orientation phone crops. Aspect ratio alone identifies them. |
| `bf6_gp_017`, `bf6_gp_020`, `bf2042_gp_004` | Extreme crops / stitched tall images. Not comparable framing. |
| Any `bf2042_gp_*` frame showing a scoreboard, deploy map, loadout, weapon-customisation or Portal menu — roughly half that set | Menu screens. Check before use: if it has a full-width panel or a mouse cursor, it is a menu. |
| Any letterboxed `bfv_gp_*` frame — roughly 40% of that set | Campaign War Story cutscenes: cinematic bars, authored camera, per-shot grading. Press-tier, not gameplay-tier, and the bars give them away instantly. The rule is mechanical — **if it has black bars top and bottom, do not use it as a gameplay A/B partner.** |
| `redsec_gp_000`, `002`–`005`, `007`, `009`–`011`, `014` | Memes, error dialogs, logos, promo art and sub-720p crops. Not screenshots of a running game. |
| `redsec_gp_008` | Byte-identical duplicate of `bf6_gp_038`. Use the BF6 filename so results are not double-counted. |
| Character close-ups anywhere in `reference/battlefield/` (e.g. `bf6_05`, `bf6_09`) | Staged third-person hero shots dominated by a rendered human face/kit at close range. We do not ship close-up character rendering, and a photoreal face is the single easiest tell in a blind A/B. |
| The whole of `reference/battlefield/` for framing or UI questions | No HUD, impossible camera angles, cinematic settings. Atmosphere ambition only, per the brief. |

---

## 5. The 12 most valuable frames overall

Ranked. If the corpus had to be cut to twelve images, these are the twelve.

1. **`gameplay/bf6_gp_019.jpg`** — FP infantry, coastal resort, hard sun, full HUD. The single most
   complete calibration target: framing, HUD, palm foliage, sandstone, sea and sky all in one
   1920×1080 in-game frame. If IRONSIGHT can survive an A/B against this, it survives the brief.
2. **`gameplay/bfv_gp_028.jpg`** — Contre-jour harbour square. Defines the dynamic range our
   `market_square` must hold: blown sky, silhouetted figures with rim light, wet cobble specular,
   and shade that stays open. Nothing else in the corpus states the HDR target this clearly.
3. **`gameplay/bf6_gp_016.jpg`** — Mediterranean hill town: terracotta, cypress, stucco, sun disc
   through smoke. This is HARBOUR REACH's architecture and colour language, already resolved.
4. **`gameplay/bf6_gp_013.jpg`** — Sea-level water with a harbour crane beyond. The corpus's best
   water frame: wave shape, depth transmission, foam, specular breakup, plus lens droplets.
5. **`gameplay/bf6_gp_024.jpg`** — Clean full HUD over a bright environment at hip-ready. The HUD
   legibility baseline and the viewmodel rest-position baseline in one frame.
6. **`gameplay/bf2042_gp_022.jpg`** — Hard desert sun, blown sky, deep shade two metres from the
   camera, live HUD. The hard-light infantry case with UI attached.
7. **`gameplay/bf6_gp_025.jpg`** — Headland ruin over a burning coastal city. Subject-matched to
   CHARLIE and the strongest single statement of smoke-over-water and distant value compression.
8. **`gameplay/bf2042_gp_000.jpg`** — Iron-sight ADS with focus falloff. The only frame that
   settles what our ADS should look like: sight proportion, FOV, and what stays sharp.
9. **`gameplay/bf6_gp_039.jpg`** — Backlit vista with volumetric shafts and world-space distance
   labels. Sets both the god-ray target and the long-range legibility target.
10. **`gameplay/bf2042_gp_027.jpg`** — FP fireball with full HUD. Proves a combat frame can carry
    heavy VFX and still read; the direct partner for `firefight`.
11. **`gameplay/bfv_gp_031.jpg`** — Adjacent lit and shaded walls in one frame. The cheapest,
    clearest check that our shadow ambient is sky-tinted and not grey. Most WebGL tells live here.
12. **`gameplay/bf6_gp_034.jpg`** — Pure aerial perspective across three depth bands. The
    calibration frame for how much contrast the headland is allowed to keep at 800 m.

Honourable mentions that only just missed: `bfv_gp_038` (destruction), `bf6_gp_015` (shallow
water), `bf2042_gp_035` (night emissives + HUD), `bfv_gp_036` (dawn sky gradient).

---

## Appendix A — HUD anatomy, read off the BF6 gameplay frames

Recorded here because the critic needs to know *what* to compare when judging `hud_full`. Layout is
consistent across `bf6_gp_019`, `024`, `032`, `038`, `015`, `013`.

- **Top centre, from the top down:** a compass ribbon (cardinal letters + degree numbers on a
  ticked rule, with a centre caret); then the ticket bar — bracketed friendly count on the left,
  blue fill bar, a small crown/lead marker at centre, red fill bar, enemy count on the right; then
  a row of capture-point letters, `A`–`I`, with **circles for uncontested and diamonds for
  held/contested**, coloured by owning team.
- **Bottom left:** a dark translucent minimap rendered as a rotated square, with objective letters
  pinned around its outside edge; the sector name in small caps underneath; then the squad roster —
  four rows, each with a slot number, a role glyph, the player name and a thin green health bar.
- **Bottom right:** the ammo block — large magazine count with a smaller `/reserve` beside it, and a
  weapon silhouette; a gadget row of icon tiles with small count badges and keybind numbers; a
  grenade/armour row above.
- **Right edge:** a vertical stack of small contextual action icons, plus a transient XP ticker.
- **Top right:** the killfeed — attacker, weapon glyph, victim, team-coloured.
- **Centre:** a minimal crosshair (four short ticks, no circle), and world-anchored objective
  markers carrying distances in metres (`140 m`, `370 m`, `460 m`).
- **Typography:** condensed, uppercase, slightly transparent, with a soft drop shadow rather than a
  hard outline. Never pure white — the fills sit a little below peak.

## Appendix B — regenerating the triage contact sheets

The contact sheets used to classify the corpus are not committed (the reference folder is
gitignored). To rebuild them, tile the JPEGs 3×3 at 720×405 per cell with the filename burned into
each tile; 15 sheets covers `gameplay/`, 6 covers `battlefield/`. That is enough resolution to
classify time of day, framing and HUD presence, but **not** enough to judge material detail — always
open a candidate at full resolution before adding it to this index.
