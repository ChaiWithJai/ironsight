# IRONSIGHT — HUD SPEC

**This document is law for the HUD lane (`src/ui/**`).** It is written so that an engineer who has
never seen the reference frames can build the HUD pixel-faithfully from this file alone. Every
number here is measured off real in-game Battlefield captures (BF6 primary, BF2042 / REDSEC
secondary) and then adapted to IRONSIGHT's actual game — three capture points, no vehicles, no
chat, bots instead of a lobby.

Companions: `docs/BRIEF.md` (quality bar), `docs/LOOK_SPEC.md` (render target),
`src/engine/types.ts` §20 (`HudService`, `KillFeedEntry`), §22 (`MatchState`, `CapturePointRuntime`),
§19 (`PlayerState`), §17 (`WeaponState`).

---

## 0. The five things that make or break it

If you implement nothing else correctly, get these right. Each is a thing that reconstructions get
wrong, and each is individually enough to make the frame read as a WebGL demo.

1. **Ownership is encoded by SHAPE, not only colour.** Friendly = **circle**. Enemy = **diamond**
   (square rotated 45°). Neutral = **rounded square**. This holds in the top capture row, on world
   markers and on the minimap. Two identically-shaped chips in two colours is instantly wrong.
2. **Every zero is slashed (Ø).** Tickets, ammo, compass bearings, distances, damage numbers, XP.
   `src/bake/font.ts` already ships a slashed zero — do not "fix" it.
3. **The minimap has no frame.** No border, no corner radius, no bezel, no drop shadow, no glow. It
   is a bare hard-edged square of translucent map render that simply ends. Adding a bezel is the
   single fastest way to make the HUD look like a mod menu.
4. **The two ticket tracks fill from the OUTER screen edges inward and deplete from the CENTRE
   outward.** A team that is losing shows a growing dark stub adjacent to the centre gutter, not a
   bar that shrinks toward the edge. The tracks never change length. Verified in
   `bf6_gp_021` (440 vs 248), `bf6_gp_038` (1149 vs 977), `bf6_gp_019` (516 vs 1038).
5. **The killfeed has no background scrim at all,** and neither does the crosshair, the compass, the
   squad list, world nameplates or the XP toast. They survive on a 1px dark drop shadow and a
   coloured outer glow. Scrims exist only where a numeral must survive an arbitrary background
   (score plates, gadget tiles, weapon card, minimap, rail tiles, marker interiors).

---

## 1. Scope, adaptations, and where the source reports disagreed

### 1.1 What IRONSIGHT's HUD contains

IRONSIGHT is infantry-only Conquest with bots on one map. That deletes a large slice of the
reference HUD and changes the density of another slice. Decisions, one line each:

| Reference element | IRONSIGHT decision |
|---|---|
| Nine capture points A–I | **Three**: ALPHA / BRAVO / CHARLIE → chips `A` `B` `C`. The reference scales chip size *up* as point count falls (34px chips at 5 points, 28px at 9, ~44px shields at 2). We take the low-count end: **3.15u chips at 1.28× pitch** (§6.5). |
| Vehicle HUD (amber instrument layer, seat diagram, pitch ladder, hull bar, turret reticle, ranging brackets) | **Cut.** No vehicles in the game. Bottom-centre stays permanently empty — which is exactly what the reference infantry HUD does. No amber instrument layer anywhere. |
| Chat panel (top-left) | **Cut.** No network, no other humans. Top-left holds nothing. `bf6_gp_021` and `redsec_gp_008` both show a live infantry HUD with an empty top-left, so this is a supported state, not a hole. |
| Latency badge (top-left) | **Cut.** No network. |
| Breakthrough chevron-ratchet ticket bar, round-win pips, crown tile | **Cut.** Conquest only. The pips/crown variant (`bf6_gp_032`) is a round-based mode we do not ship. |
| Full scoreboard (TAB) | **Kept, minimal** — `forceState('scoreboard')` (§10.11). Bots have names and `PlayerScore`. |
| Deploy / spawn map | **Kept, minimal** — `forceState('spawnmenu')` (§10.11). |
| Reinforcement / call-in rail (right edge) | **Repurposed** as the **gadget & ability rail**: our throwable + gadget + class ability cooldowns. Same three tile states (ready / hatched / bracket-selected), same segment meter. |
| Killfeed | **Kept.** Bots kill each other constantly; this is where the HUD gets its life. |
| Squad list | **Kept**, 4 rows, bots as squadmates. It is also the **only** health readout (§1.2). |
| Damage-direction indicator | **Invented** (§6.20). Not present in any of the 135 reference frames — `HudService.setDamageDirection` is in the frozen contract, so we design one *in the reference's vocabulary* rather than copying. Flagged as a deviation. |
| Bleedout ring | **Invented** (§6.21), same reason: `PlayerState.bleedout` is in the contract. |

### 1.2 Health

**There is no health bar and no health number anywhere in the reference infantry HUD.** Confirmed
across `bf6_gp_015/019/021/024/032/036/038`. The local player's health is the **underline on the
bottom row of the squad list**, drawn roughly twice as wide as the squadmates' bars and in a
different colour. We copy that exactly. Do not add a corner health bar; that alone would give us
away.

### 1.3 Where the five source reports disagreed — decisions

| Disagreement | Decision | Why |
|---|---|---|
| Ticket bar fill direction | Fill anchored at the **outer** end, depletion eats inward-to-outward from the centre gutter | Direct pixel read of `bf6_gp_021` / `bf6_gp_038`: the dark stub sits against the centre gutter on the losing side. |
| Ticket bar segmented vs solid | **Solid**, unsegmented | The segmented bar people remember is the *world nameplate* health bar. Inverting these is the classic error. |
| Crosshair symmetric vs asymmetric (dashed top column) | **Symmetric**: four ticks + centre diamond | `bf6_gp_021` and `bf6_gp_032` both show four equal ticks. The asymmetric read came from one slice only. |
| Crosshair centre mark: diamond vs 2×2 square | **Diamond**, 5px | At 4–5px they converge; the diamond is the more distinctive and both slices that measured carefully said diamond. |
| Hit marker: white spiky starburst vs four amber diagonal triangles | **Four diagonal triangles**, apexes outward | `bf6_gp_019` shows it unambiguously at the victim. White for a hit, gold `--fx-kill` for a kill. The "starburst" read is the same mark at a larger scale. |
| Hit marker anchoring: screen centre vs world | **World-anchored on the victim** | `bf6_gp_019`: the marker and the damage number sit at (38%, 65%), nowhere near the crosshair. |
| Panel scrims: neutral mid-grey ~62% vs near-black ~33% | **Near-black, `rgba(0,0,0,0.33)`** | Sampled the same gadget tile over bright sand and over dark rock in `bf6_gp_032`: the tile reads darker than both. The "milky mid-grey" read came from the chat panel, which we cut. |
| Right-edge rail tiles: light grey plate vs dark scrim | **Dark scrim**, same token as the gadget tiles | Same test, `bf6_gp_021` and `bf6_gp_032`. One scrim family for the whole HUD. |
| Local player squad row: yellow / white / pale white-green | **Near-white `--self`** | All three exist in shipped frames. White is unambiguous against the squad lime and reads on any background. |
| XP toast: bare text vs green-tinted scrim | **Green-tinted scrim that wipes in** | `bf6_gp_038` at native res shows the fill clearly; it is the more distinctive of the two. |
| Killfeed name tiers: two or three | **Three**: own-squad, rest-of-team, enemy — plus a fourth white "local player involved" recolour with a leading ▶ | `bf6_gp_036` bottom row. |
| Minimap rotation | **North-up**, marker rotates | All sampled frames. |
| Compass tape scale | **Fixed**, 0.247u per degree | It varies with FOV in the reference; a fixed scale is simpler and indistinguishable at our single FOV range. |

---

## 2. Coordinate system, units, scaling

### 2.1 The unit

```
1u  =  viewportHeightPx / 100          // "one percent of screen height"
```

**Every size in this document is in `u`, including horizontal sizes.** The entire HUD scales with
screen *height*, never with width or with the diagonal. 1080p values are given in brackets
throughout as `[Npx]`.

Horizontal positions are given one of three ways:

* `L + n` — n units right of the left screen edge
* `R − n` — n units left of the right screen edge
* `C ± n` — n units from the horizontal centre (`C = viewportWidthPx / 2`)

Vertical positions are always a percentage of height, written `y = n` (so `y = 50` is the vertical
centre).

### 2.2 hudScale

```
hudScale ∈ [0.85, 1.20],  default 1.00
```

Multiplies **every** size and every margin, but **not** the `C`-relative anchors of the top-centre
column, which stay locked to 50% width. The reference demonstrably ships this — `bf6_gp_032` and
`bf6_gp_038` are the same game at measurably different HUD scales (minimap left margin 33px vs
103px, capture chip pitch 43.5px vs 35.8px). Build every measurement as `spec × hudScale`; never
hardcode a pixel.

### 2.3 Aspect ratio

Clusters pin to their own corner or to the centre; they do **not** live inside a centred safe box.
On an ultrawide the gap between clusters simply widens (`bf6_gp_036`, 2.37:1, confirms this).

**Guard:** if `viewportWidthPx / viewportHeightPx < 1.5` (tall windows), clamp the effective unit to
`min(height/100, width/160)` so the top-centre ticket assembly (51.4u wide) cannot exceed 92% of the
width.

### 2.4 Safe margins

Deliberately asymmetric — the top is tighter than the bottom.

| Edge | Margin | 1080p |
|---|---|---|
| Left | 2.96u | 32px |
| Right | 2.96u | 32px |
| Right (ability rail only) | 3.90u | 42px |
| Bottom | 3.05u | 33px |
| Top | **0** — the compass pointer is flush with y=0 and is cropped by the screen edge | 0px |

### 2.5 Pixel snapping

All rectangles, strokes and icon geometry snap to whole **device** pixels after scaling
(`Math.round`). Text baselines snap in Y; X may be fractional so tracking stays even. Strokes are
drawn on half-pixel centres so a 1px line is 1px, not a 2px blur.

### 2.6 Where the HUD is drawn

Per `src/engine/types.ts` §20 and `src/ui/system.ts`: an **orthographic pass into the WebGL canvas,
after tonemapping, at native canvas resolution** (never `renderScale`). There is no DOM UI in this
project — `tools/capture.mjs` screenshots the canvas only.

Consequences that are part of this spec:

* HUD colours are authored in **sRGB and written straight through**. The HUD is not tonemapped, not
  colour-graded, not exposed. Drawing UI before the tonemap is the most common giveaway that a
  frame came out of a hobby post stack.
* The HUD is **not** routed through the scene bloom. Every glow in this document is drawn
  explicitly (§4.6) as extra geometry.
* Sub-pixel AA on HUD glyphs comes from the SDF's own screen-space derivative, not from TAA. HUD
  geometry must be excluded from the TAA history or it will ghost on every camera turn.

---

## 3. Z-order

Back to front. One integer layer per row; nothing shares a layer across categories.

| z | Layer | Contents |
|---|---|---|
| 0 | Minimap surface | map render plate, capture-zone polygons, order path |
| 10 | Minimap contents | in-map markers, friendlies, player marker + view cone |
| 20 | World-space markers | objective markers, nameplates, distances, gadget markers, spot pins |
| 30 | Panel scrims | weapon card fill, gadget tiles, rail tiles, score plates, marker interiors |
| 40 | Screen-space HUD | compass, ticket bar, capture row, squad list, ammo numerals, killfeed, rail icons |
| 50 | Crosshair | |
| 60 | Transient feedback | hit markers, damage numbers, kill cluster, score popups, XP toast |
| 70 | Alert layer | damage-direction arcs, bleedout ring, low-health blood blobs |
| 80 | Prompts + keybind chips | interaction prompts, all chips |
| 90 | Full-screen states | deploy map, scoreboard, round-end |

**World-space markers draw UNDER the screen-space clusters** and are clipped/occluded by them. This
is deliberate — a nameplate that draws over the ammo counter looks broken.

---

## 4. Type system

### 4.1 The face

The HUD typeface is **`bake.font`** (`src/bake/font.ts`, owned by BAKE): a code-authored
stroke-skeleton SDF atlas. No font files ship; no `document.fonts`; no canvas `fillText`.

Its relevant properties, which this spec is written against:

| Property | Value |
|---|---|
| Construction | centre-line polylines + square-cap pen, constant stroke |
| Stem | 0.15 × cap height |
| Side bearing | 0.055 cap each side |
| Typical advance | ≈ 0.57 cap (condensed ~88% of a normal grotesque) |
| Ascender / descender / line height | 1.00 / −0.22 / 1.42 cap |
| Case | **caps only** — lowercase codepoints fold to the uppercase cell |
| Zero | **slashed** |
| Weights | **one** — synthesised (§4.3) |

**Adaptation:** the reference sets player names, chat bodies and map names in mixed case. Our face
has no lowercase. All names are therefore set in **caps at `t2` with +0.015 tracking**, which is
close enough that no one reads it as a mistake. Do not synthesise a lowercase by scaling caps down;
that reads as a bug.

### 4.2 Type scale

Sizes are **cap heights** in `u`. Never use a size not on this ladder.

| Token | Cap | 1080p | Weight | Tracking | Case | Used for |
|---|---|---|---|---|---|---|
| `t0` | 0.85u | 9px | Regular | +0.08 | CAPS | world distances, in-zone occupancy counts, `CAPTURE` verb, netgraph |
| `t1` | 1.05u | 11px | Bold | +0.06 | CAPS | capture-row letters, killfeed, compass labels, keybind glyphs, gadget counts, status captions, chip caps |
| `t2` | 1.20u | 13px | Regular | +0.015 | CAPS | squad names, killfeed names, map name, secondary ammo, prompt labels, XP progress line |
| `t3` | 1.55u | 17px | Bold | +0.04 | CAPS | world objective letter, score-event value, XP value |
| `t4` | 1.85u | 20px | Bold | 0 (tabular) | — | ticket counters |
| `t5` | 2.90u | 31px | Display | 0 (tabular) | — | magazine count, damage numbers |

Tracking is **extra advance in cap-height units**, added after every glyph including the last (then
trimmed from the measured run width for centring).

### 4.3 Synthetic weight

The SDF stores `code = 0.5 − d/(2·distanceRange)` with negative distance inside the ink, so the
glyph edge is at `0.5`. Weight is a threshold shift in the text shader:

```glsl
float s  = texture(uAtlas, vUv).r;
float w  = fwidth(s) * 0.75;              // screen-space derivative → crisp at any size
float a  = smoothstep(uThreshold - w, uThreshold + w, s);
```

| Weight token | `uThreshold` | Resulting stem | Notes |
|---|---|---|---|
| Light | 0.545 | ≈ 0.129 cap | secondary/dimmed rows only |
| Regular | 0.500 | 0.150 cap | names, body |
| Bold | 0.455 | ≈ 0.169 cap | all-caps labels, most numerals |
| Display | 0.430 | ≈ 0.180 cap | magazine count, damage numbers |

`Display` also gets **x-scale 0.88** on the quad and on the advance (the reference display cut is
noticeably narrower than its text cut), and a **double draw** offset ±0.35px in X if the stem still
reads light at the current `distanceRange` — that is the classic synthetic-bold smear and is
cheaper than a second atlas.

Lowering the threshold below ~0.42 will start eating the counters of `8`, `0` and `9`. Do not.

### 4.4 Numerals — the signature

Get these wrong and nothing else matters.

1. **Slashed zero** — already in the face. Never substitute `O`.
2. **Tabular.** The font auto-fits advances from ink bounds, which makes `1` narrow. The HUD text
   layer **must override the advance of every digit `0`–`9` and of `.` `,` `:` `/` to a constant
   `0.82 cap`**, so counters never reflow as they tick. This is a hard requirement, not a nicety.
   Non-digit runs keep the font's natural advances.

   *Measured basis:* in `bf6_gp_021` the ticket digits `440` have 13px ink on a 17px advance at a
   20px cap (0.85 advance / 0.65 ink), and the magazine `26` has 22px ink on a 28px advance at a
   ~33px cap (0.85 / 0.67) — the same ratio at both sizes. Our face's digit ink is ≈0.61 cap, so
   **0.82** reproduces the reference's sidebearing proportion. Do **not** use the font's natural
   ≈0.72 digit advance: the counter will read cramped, which is the classic "hand-rolled HUD" tell.
3. **Comma thousands separators** in progression text and distances over 999 (`3,514/4,000`,
   `1,150 m`). Ticket counts are written flat (`1149`, not `1,149`).
4. **Dimmed leading zeros.** Any zero-padded counter draws its pad digits in `--dim` and its
   significant digits at full brightness. Applies to the magazine count, padded to
   `digitsOf(magSize)`, and to the compass heading readout if enabled.

   *Verified:* `bf6_gp_024` renders the magazine as **`Ø94`** with a visibly grey slashed `Ø` and a
   white `94`, against a `/100` reserve — i.e. the pad width is the magazine capacity's digit count.
   This is the single detail that makes the counter read as an instrument rather than as a label.
5. **Superscript reserve.** `/198` is set at **0.40 ×** the magazine cap height with its **top
   aligned to the magazine's cap line**, i.e. `baselineSuper = baselineMag + capMag × 0.60`. It is
   NOT baseline-aligned and NOT a subscript. The secondary-weapon row, by contrast, sets `6 / 24`
   at one uniform size on one baseline — the two treatments are deliberately different.
6. **Degrees** use the `°` glyph as a raised ring.
7. `∞` is not in the face; where infinite reserve is needed, draw the two-circle glyph as vector
   geometry (§6.14) rather than as text.

### 4.5 Case and tracking rules

* Every system label, verb, tag, award, status and mode name is **ALL CAPS with +0.04…+0.11
  tracking** — wider tracking at smaller sizes. `NEUTRALIZING`, `CAPTURE`, `DEFEND`, `KILL`,
  `RELOADING`, `OBJECTIVE SECURED`.
* Names get near-zero tracking (+0.015).
* No italics anywhere. No underlines except the squad health bar, which is a rectangle, not type.

### 4.6 Text rendering treatment

| Text class | Treatment |
|---|---|
| White / neutral text | 1px hard dark drop shadow, offset (0, +1), `rgba(0,0,0,0.75)`. **No glow.** |
| Coloured text (cyan / salmon / lime / amber) | soft outer glow in its own hue: additive, radius 0.55u [6px], peak alpha 0.35. **No hard shadow.** |
| Text on a light chip (keybind, deploy chip) | no shadow, no glow — dark ink on a light plate |
| De-emphasised anything | the **whole element** drops to 25% opacity; it is never hidden |

Glow is implemented as a second draw of the same geometry with the SDF threshold raised to ~0.62
(a dilated silhouette), blurred, additive, before the sharp draw. It never goes through the scene
bloom pass.

**Nothing is pure `#FFFFFF`.** HUD white is `#E8EDF1`. The only near-pure whites are the weapon-card
brackets and the crosshair (`#F4F8FA`), which are deliberately the brightest marks in the frame.

### 4.7 CSS fallback stack — DOM surfaces only

The shipped HUD is canvas and uses `bake.font`. The following applies **only** to non-shipping DOM
surfaces: design mocks, the `tools/compare.sh` contact sheets, and any doc preview. It exists so
those never render in a default browser face, which would misrepresent the target.

```css
:root {
  --ironsight-face:
    "Bahnschrift", "DIN Alternate", "DIN Condensed", "Roboto Condensed",
    "Liberation Sans Narrow", "Arial Narrow", "Helvetica Neue Condensed Bold",
    "Nimbus Sans Narrow", ui-sans-serif, system-ui, sans-serif;
}

.hud-label {
  font-family: var(--ironsight-face);
  font-weight: 700;
  font-stretch: 87.5%;                 /* variable/optical-width faces only */
  font-variant-numeric: tabular-nums lining-nums slashed-zero;
  font-feature-settings: "tnum" 1, "lnum" 1, "zero" 1, "ss01" 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #E8EDF1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75);
  -webkit-font-smoothing: antialiased;
}

/* Closing the gap when the resolved face is not narrow (Arial Narrow is only ~82%
   of Arial; system-ui is not condensed at all). Applied to the *inline block*, and
   the container must compensate the width or the layout drifts. */
.hud-label--condense {
  display: inline-block;
  transform: scaleX(0.88);
  transform-origin: left center;
}

/* Synthetic weight for the display cut, matching the SDF's 0.430 threshold. */
.hud-display {
  font-size: 31px;                     /* t5 at 1080p */
  -webkit-text-stroke: 0.4px currentColor;
  paint-order: stroke fill;
  letter-spacing: 0;
}
```

Two gotchas that must be handled, not ignored:

* `slashed-zero` / `"zero" 1` is a **font feature**. Bahnschrift and DIN Alternate have it; Arial
  Narrow and Liberation Sans Narrow do **not**, and will silently render round zeros. On those
  faces, overlay a synthetic slash: a 1px `currentColor` rule rotated `-32deg`, `width: 0.62em`,
  absolutely positioned over each `0`. A DOM mock with round zeros is as wrong as a canvas one.
* `font-stretch` does nothing on a static non-variable face. The `scaleX(0.88)` transform is the
  reliable path; use it whenever `document.fonts.check('700 16px Bahnschrift')` is false.

---

## 5. Colour tokens

All values sRGB. Alpha is written explicitly where it is part of the token.

### 5.1 Team and state

| Token | Hex | Role |
|---|---|---|
| `--team-friendly` | `#75F0FF` | Coalition (`Team.Coalition`, = `localTeam`): ticket fill, capture circles, friendly world markers, capture-progress bar, minimap zone stroke |
| `--team-friendly-track` | `#123A52` @ 0.85 | depleted portion of the friendly ticket track |
| `--team-friendly-plate` | `rgba(18,36,52,0.70)` | friendly score-plate scrim |
| `--team-enemy` | `#FD8B80` | Insurgent: ticket fill, capture diamonds, enemy markers, victim names |
| `--team-enemy-track` | `#35202C` @ 0.85 | depleted portion of the enemy ticket track |
| `--team-enemy-plate` | `rgba(43,26,36,0.70)` | enemy score-plate scrim |
| `--team-enemy-world` | `#E9724F` | enemy **world-space** objective diamond — deliberately warmer than the screen-space salmon |
| `--neutral-obj` | `#EAF16F` | neutral / uncaptured objective: rounded-square stroke and letter |
| `--neutral-stroke` | `#B9C0C5` | generic neutral outline, dividers |

`Team.Coalition` is always the friendly hue and `Team.Insurgent` always the enemy hue, because
`MatchState.localTeam` is always Coalition in this game. If that ever stops being true, resolve
friendly/enemy from `localTeam` at draw time — never hardcode by enum value in a draw call.

**The two team hues are tokens, not constants.** The reference ships at least three pairings —
cyan/salmon, royal-blue/crimson (`bf6_gp_038`) and a colour-blind cyan/**magenta `#E8148C`**
(`bf6_gp_024`) — with byte-identical geometry in all of them. Build the HUD against exactly two
swappable hue variables and derive every "dim track" state as a **0.53 luminance multiply** of its
full colour. `bf6_gp_024` is also the proof of §0.1: with the enemy hue changed to magenta the
diamonds are still diamonds, which is *why* the shape encoding exists. A colour-only HUD fails the
moment anyone turns that setting on.

### 5.2 Squad, self, progression

| Token | Hex | Role |
|---|---|---|
| `--squad` | `#8FF03C` | squadmates: squad list rows, world nameplates, class glyphs, off-screen indicators, hex badges |
| `--squad-dead` | `#68705C` | a downed/dead squadmate's row, desaturated |
| `--self` | `#F2F6E4` | **the local player**, everywhere — squad row, own health bar, own seat/marker. Never green. |
| `--xp` | `#B7F382` | `+N XP` value |
| `--xp-scrim` | `rgba(96,190,44,0.28)` | the XP toast's tinted fill (the one coloured scrim in the HUD) |
| `--score-obj` | `#F7FC3D` | objective-scoring popups and their 1.5px outline boxes |

Three transient feeds share one screen anchor and are told apart **only by colour**:
white = kills and damage, `--score-obj` yellow = objective scoring, `--xp` green = progression.

### 5.3 Feedback and accents

| Token | Hex | Role |
|---|---|---|
| `--fx-hit` | `#F4F8FA` | non-lethal hit marker |
| `--fx-kill` | `#F5C24A` | lethal hit marker, kill skull |
| `--contest-pip` | `#E0A85C` | the four diagonal triangles on a contested objective |
| `--order-path` | `#F0B428` | minimap order/waypoint dashed polyline |
| `--warn` | `#FFB03A` | low ammo, low health, cooldown warnings |
| `--alert` | `#F03B2E` | empty magazine, damage-direction arc, blood overlay |
| `--gadget` | `#3ADE1E` | deployed gadget world markers (green, **not** team-coloured) |

### 5.4 Neutrals, chips and scrims

| Token | Value | Role |
|---|---|---|
| `--white` | `#E8EDF1` | all HUD text and line art |
| `--white-key` | `#F4F8FA` | weapon-card brackets and crosshair only — the brightest marks in the frame |
| `--dim` | `#7E8B96` | padded leading zeros, dimmed secondary values |
| `--ink` | `#12171A` | dark glyph on a light plate |
| `--chip-fill` | `#DCDED8` @ 0.90 | keybind chip plate |
| `--art` | `#D2D8DC` | weapon and gadget pictograms — flat fill, no gradient, no outline |
| `--scrim` | `rgba(0,0,0,0.33)` | **the** panel scrim: gadget tiles, rail tiles, weapon card, stowed rows, interaction band |
| `--scrim-deep` | `rgba(0,0,0,0.45)` | secondary weapon row, damage-number strip |
| `--scrim-marker` | `rgba(0,0,0,0.32)` | interior fill of world objective markers, so the letter survives foliage |
| `--hatch` | `rgba(255,255,255,0.15)` | 45° cooldown hatch stripes |
| `--map-plate` | see §6.7 | minimap surface |

**Scrims are neutral near-black, never tinted.** Verified by sampling the same gadget tile over
bright turquoise water and over dark rock in `bf6_gp_032` — the apparent tint comes entirely from
the background showing through.

### 5.5 Opacity ladder

| Element | Alpha |
|---|---|
| Compass labels | 0.92 |
| Compass minor ticks | 0.55 |
| Compass dashed rule | 0.50, ramping to 0.25 at both ends |
| Crosshair, killfeed, squad list, nameplates | 0.95 with a 1px dark shadow, **no scrim** |
| Ticket score plates | 0.70 |
| Ticket tracks (depleted portion) | 0.85 |
| Minimap plate | 0.85 |
| Minimap capture-zone polygon fill | 0.12 |
| Objective icon interior fill | 0.32 (friendly circle), 0.18 (enemy diamond) |
| Gadget / rail / weapon-card scrim | 0.33 |
| Cooldown hatch | 0.15 white |
| Keybind chip | 0.90 |
| Depleted gadget chip | 0.45 |
| De-emphasised marker or dim capture chip | **0.25 for the whole element** |
| Contested capture chip (pulsing) | 0.35 ↔ 1.00 |
| Minimap view cone | 0.13 at apex → 0 at the far edge |

---

## 6. Element specification

Every element below gives: anchor, geometry, colour, and enough construction detail to draw it as
canvas/SVG paths. Sizes are `u` at `hudScale = 1`.

### 6.1 Compass heading pointer

* **Anchor** `C, y = 0`. Flush with the very top of the frame; it is cropped, not inset.
* **Geometry** solid filled triangle, apex **down**. Width **1.30u** [14px], height **0.83u** [9px].
  Path: `M(C−0.65u, 0) L(C+0.65u, 0) L(C, 0.83u) Z`.
* **Fill** `--white`, alpha 1.0. No stroke, no glow, no shadow.
* **Behaviour** completely static. It is the read-head; the tape scrolls under it.

### 6.2 Compass tape

* **Anchor** `C`, label cap baseline at `y = 2.60` [28px].
* **Scale** `0.247u per degree` [2.67px/deg]. Major label every **30°** → **7.41u** [80px] pitch.
* **Extent** total tape width **33.0u** [356px], i.e. `C ± 16.5u`. ≈134° of arc visible.
* **Labels** `t1`, `--white` @ 0.92. Cardinals `N E S W`; all other 30° stops as three-digit bearings
  with slashed zeros (`030`, `060`, `120`, `210`, `300`, `330`).
* **Minor ticks** one per interval, at the **15° midpoint**: a vertical bar **0.19u × 0.93u**
  [2×10px], `--white` @ 0.55, vertically centred on the label row.
* **End ramp** alpha multiplies down from 1.0 to 0.0 over the outer **15%** of the tape width on
  each side. The tape **dissolves**; it is never hard-clipped and never has a fade mask box.
* **Behaviour** translates 1:1 with `PlayerState.yaw`. **Never smoothed** — a lerped compass feels
  like ice. Text does not rotate or scale.

### 6.3 Compass dashed rule

* **Anchor** `C`, `y = 3.95` [42.7px]. Spans the same 33.0u as the tape.
* **Geometry** horizontal dashed rule, thickness **0.19u** [2px], dash **0.46u** [5px], gap
  **0.37u** [4px]. `--white` @ 0.50, same end ramp as the tape.
* **Centre cross** at exactly `C`, the dash is replaced by a brighter `+`: **0.65u × 0.83u**
  [7×9px], 1px strokes, `--white` @ 0.85.
* **Behaviour** static. The rule does **not** scroll; only the labels above it do. This asymmetry is
  a real detail — the pointer is above the labels, the rule is below them, and the labels are
  sandwiched.

### 6.4 Ticket bar assembly

Sits at `y = 5.20 → 7.95` [56→86px]. Row height **2.75u** [30px]. Perfectly mirror-symmetric about
`C`. Every rectangle here has **zero corner radius**.

Left to right, with 1080p widths:

| # | Part | Size | Fill |
|---|---|---|---|
| 1 | Friendly score plate | 7.69u × 2.78u [83×30] | `--team-friendly-plate` |
| 2 | gap | 0.65u [7] | — |
| 3 | Friendly track | 16.85u × 1.11u [182×12], vertically centred in the row | see below |
| 4 | Centre gutter | 1.02u [11] | untouched background |
| 5 | Enemy track | 16.85u × 1.11u [182×12] | see below |
| 6 | gap | 0.65u [7] | — |
| 7 | Enemy score plate | 7.69u × 2.78u [83×30] | `--team-enemy-plate` |

Total **51.4u** [555px], centred on `C`.

**Track construction (the part everyone gets backwards):**

```
frac        = clamp(tickets[team] / ticketsMax, 0, 1)
filledPx    = round(trackWidth * frac)
friendly:   fill  rect [trackLeft,               trackLeft + filledPx]  in --team-friendly
            track rect [trackLeft + filledPx,    trackRight]            in --team-friendly-track
enemy:      fill  rect [trackRight - filledPx,   trackRight]            in --team-enemy
            track rect [trackLeft,               trackRight - filledPx] in --team-enemy-track
```

The bright fill is anchored at the **outer** end. The dark depleted stub grows **outward from the
centre gutter**. The track never changes length. Fill is flat colour — no gradient, no gloss, no
rounded cap, and **no segmentation**.

*Verified numerically* on `bf6_gp_021`: friendly 440 tickets → bright fill x 775→842 = 67px of the
182px track = 36.8%; enemy 248 tickets → bright fill x 1107→1145 = 38px = 20.9%; both fills flush
with their **outer** track edge. 440/1200 = 36.7% and 248/1200 = 20.7%, so `frac = tickets /
ticketsMax` with `ticketsMax = 1200` in that match. We read the denominator from
`MatchState.ticketsMax` and never hardcode it — `src/game/conquest.ts` owns that number.

**Drain-front glow:** a 3.7u-wide [40px] brighter blob centred on the fill's leading (inner) edge,
same hue at +35% luminance, additive, feathered. Present only while `|Δtickets| > 0` in the last
1.5s.

**Score plates:** ticket count centred, `t4`, tabular, slashed zeros, in the team hue (not white),
no thousands comma.

### 6.5 Capture-point row — adapted to three points

* **Anchor** `C`, chip centres at `y = 10.5` [113.5px].
* **Chip size** `s = 3.40u` [37px] across. **Pitch** `1.28 × s = 4.35u` [47px].
* **Three chips** → row width `2 × 4.35 + 3.40 = 12.10u` [131px]. Chip centres at `C − 4.35u`, `C`,
  `C + 4.35u`. **BRAVO lands exactly on `C`** — with an odd point count the middle chip must sit on
  screen centre.
* **Order** fixed left→right ALPHA, BRAVO, CHARLIE regardless of world position. Letters `A B C`,
  `t1`, centred in the chip, in the chip's own colour.

> **How the three-point size was derived.** The reference keeps a **constant pitch : chip ratio of
> 1.28** and grows the chip as the point count falls. Measured: `bf6_gp_021`, nine points → chip
> **28px**, pitch **35.2px** (ratio 1.27, row y 100→127); `bf6_gp_032`, five points → chip **34px**,
> pitch **44px** (ratio 1.29, row y 97→130). Both put the middle chip at x = 959.5 ≈ centre.
> Extrapolating the chip trend to three points gives **37px**, and 1.28 × 37 = **47px**. That is the
> adaptation rule: *hold the ratio, scale the chip to the count* — not "copy the nine-point row and
> delete six chips", which would leave a comically small cluster floating in the middle of the
> screen.

**Shapes** (`s` = 3.40u; all strokes are centred on the path):

| State | Shape | Construction |
|---|---|---|
| Friendly-owned | **Circle** | `r = 0.5s` [18.5px]; stroke **0.23u** [2.5px] `--team-friendly`; interior `--scrim-marker`; 0.37u [4px] outer glow |
| Enemy-owned | **Diamond** | square of side `0.72s` rotated 45° (→ `1.02s` point-to-point), corner radius 0.19u [2px]; stroke **0.28u** [3px] `--team-enemy`; interior `--scrim-marker` @ 0.18; glow |
| Neutral | **Rounded square** | `0.76s × 0.76s` [28×28px], radius 0.19u [2px]; stroke **0.14u** [1.5px] `--neutral-obj`; interior **white @ 0.30** — the only chip with a *light* fill; letter `--neutral-stroke` |
| Capturing (either team) | owner shape + capturing shape | **two concentric glyphs**: the current owner's shape/colour, with the capturing team's shape/colour drawn over it offset by 0. The doubled glyph (a salmon diamond inside a cyan circle) is the contested read. |
| Transitional / neutralising | **empty circle, no letter** | dim circle, 0.14u stroke, no fill, no letter |
| De-emphasised | *unchanged shape* | the whole chip at **0.25 alpha**, glow removed, stroke thinned to 0.14u, fill dropped |

Mapping from `CaptureState`:

```
Neutral            → Rounded square, --neutral-obj
OwnedCoalition     → Circle,  friendly hue
OwnedInsurgent     → Diamond, enemy hue
CapturingCoalition → owner shape + friendly circle overlay, pulsing
CapturingInsurgent → owner shape + enemy diamond overlay, pulsing
Contested          → owner shape, solid-filled in the owner hue @ 0.55, letter knocked out white, pulsing
```

**Status line (optional, transient):** a single all-caps line centred at `y = 12.6`, `t1`,
`--white`, +0.07 tracking, no scrim — e.g. `THE ENEMY HOLDS MORE OBJECTIVES`. Shown only when the
ticket bleed differential flips.

### 6.6 Killfeed

* **Anchor** top-right. Right rule at `R − 2.96u`. First row baseline `y = 5.6`. Grows **downward**.
* **Row pitch** 2.75u [29.7px]. **Max 5 rows**; a sixth evicts the oldest immediately.
* **No background scrim whatsoever.** Ragged left edge, flush right edge.
* **Row layout** left→right:
  `[▶ local marker] [killer name] [weapon glyph] [skull if headshot] [victim name]`
* **Killer / victim names** `t2`, cap 1.20u. Colour tiers:

| Tier | Colour |
|---|---|
| Own squad | `--squad` |
| Rest of own team | `--team-friendly` |
| Enemy | `--team-enemy` |
| **Any row involving the local player** | whole row recoloured `--white`, prefixed with a solid white right-pointing triangle **0.74u × 0.83u** [8×9px] |

* **Weapon glyph** flat silhouette from the killer's `WeaponId`, **2.4u wide × 1.5u tall**
  [26×16px], tinted to the **killer's** colour at 0.55 alpha. 0.46u [5px] gaps either side.
* **Skull** drawn only on `headshot`, **1.20u** [13px], in the **victim's** colour, immediately
  before the victim name. Geometry: rounded cranium (superellipse, `rx=0.5w, ry=0.42w`), a
  flat-bottomed jaw block `0.55w × 0.22w` below it, two knocked-out square eye sockets
  `0.18w × 0.20w` at ±0.19w, and a `0.10w` nose notch.
* **Motion** §8.

### 6.7 Minimap

* **Anchor** bottom-left. Left edge `L + 2.87u` [31px], bottom edge at `100 − 3.05` [y = 1047].
* **Size** a **square**: `23.6u × 23.6u` [255×255px]. Square in *pixels*, not in percent.
  (Measured on `bf6_gp_021`: plate edges at x = 31 and 284, y = 792 and 1047 → 253 × 255.)
* **NO frame, NO border, NO radius, NO shadow, NO glow, NO compass ring.** The map render simply
  ends at a hard axis-aligned edge. Optionally a single 1px `rgba(255,255,255,0.35)` rule along the
  **top edge only** (present in the reference; it reads as a lens edge, not a bezel).
* **Surface** an orthographic top-down render of HARBOUR REACH, heavily desaturated, drawn at
  **0.85 alpha** over the world:

| Feature | Colour |
|---|---|
| Ground / sand | `#8A9196` |
| Water | `#4E6068` |
| Roads and plazas | `#A2ABAF` (1.5–2px ribbons) |
| Building footprints | `#585E64`, each with a 1px `#7C858A` top edge that fakes extrusion |
| Vegetation / out-of-bounds | fine dotted hatch, `rgba(0,0,0,0.25)`, 3px pitch |
| Baked film grain | ±3% luminance noise, 1px, static |

  **Adaptation note:** the reference minimap is a cool grey-blue. Ours must stay cool and
  desaturated even though HARBOUR REACH is warm ochre — the desaturation is what makes the team
  colours pop off the plate. Do not tint the map warm to "match the world".

* **North-up.** The plate never rotates; the player marker rotates.
* **Zoom** fixed, showing ~180m across the square. The map pans; the player is not locked to centre.

**Contents:**

| Item | Spec |
|---|---|
| Capture-zone polygon | the objective's real footprint as a closed polygon, **1.5–2.5px stroke** in the owner's colour, fill same hue @ **0.12**. Hard corners, no smoothing. |
| In-map objective marker | same circle/diamond/square vocabulary, **2.4u** [26px], 2px stroke |
| Player marker | filled circle **1.85u** [20px] in `--self` with the squad slot digit knocked out in `--ink`, plus a **view cone**: a 50° wedge, **6.0u** [65px] long, fill `--self` ramping 0.13 → 0 at the far edge, no outline |
| Squadmates | `--squad` filled arrowheads **1.1u** [12px], rotated to facing |
| Non-squad team | `--team-friendly` arrowheads, same size |
| Enemy contacts (spotted only) | `--team-enemy` diamonds **0.93u** [10px] |
| Order path | dashed polyline, `--order-path`, 2px, dash 0.55u / gap 0.46u [6/5px], **each dash rotated to lie along the path direction** — on a diagonal leg they are diagonal slashes, not axis-aligned ticks. No arrowhead. |
| Map name | `HARBOUR REACH`, `t2`, `--white` @ 0.85, horizontally centred, baseline at 88% down the map's own height |
| Keybind chip | standard chip (§6.16) with `M`, inset 0.55u [6px] from the map's bottom-left corner, **inside** the plate |

**Edge clamping — a required behaviour, not a nicety.** Off-map objectives clamp so their **centre
sits exactly on the plate boundary**, at full size and **not clipped**: half the glyph hangs outside
the square. Verified on all four edges in the reference. When two markers clamp to the same point
they simply overlap and read as one composite glyph. Do not hide, shrink or inset them.

### 6.8 Squad list

* **Anchor** immediately **right** of the minimap (never below it), left edge at
  `minimapRight + 1.8u` [19px] — measured at x = 303–305 against a minimap right edge of 284, in
  `bf6_gp_019`, `bf6_gp_021` and `bf6_gp_032` alike. **Bottom-aligned to the minimap's bottom
  edge**, growing upward.
* **4 rows**, pitch **5.46u** [59px]. **No panel, no scrim, no background.**
* **Row layout** left→right: `[class glyph] [slot badge] [divider] [name]`, with the **health bar on
  a second line below the whole row** — never inline.

| Part | Spec |
|---|---|
| Class glyph | **2.4u** [26px], 0.28u [3px] stroke, **outline only**: Assault = a wide chevron `Λ` with a short internal stem; Engineer = a double-ended open wrench; Support = a bold `✚`; Recon = a four-lobed compass-rose diamond. `✕` replaces it when the member is dead. |
| Slot badge | a **flattened hexagon** — flat top and bottom, **pointed left and right** — `2.2u × 2.0u` [24×22px], **solid filled** in the row colour with the slot digit **knocked out** in `--ink` at `t1`. Vertices, for `w=2.2u, h=2.0u`: `(−w/2, 0) (−w/2+0.24w, −h/2) (w/2−0.24w, −h/2) (w/2, 0) (w/2−0.24w, h/2) (−w/2+0.24w, h/2)`. Not a circle, not a square, not an outline. |
| Divider | 0.19u × 1.5u [2×16px] vertical bar in the row colour, 0.37u [4px] before the name |
| Name | `t2`, row colour, +0.015 tracking, soft outer glow, no shadow |
| Health bar | **0.42u** [4.5px] tall, sitting **1.0u** [11px] below the name baseline, left edge aligned 0.19u left of the class glyph. **Fully transparent empty track** — only the filled portion is drawn. |

**Colour and the local player:**

* Squadmates: everything in `--squad`. Bar length at full health **8.2u** [89px] — measured
  x 303→392 in `bf6_gp_021` and `bf6_gp_032`.
* **The local player is always the BOTTOM row**, regardless of slot number, and renders entirely in
  `--self` — glyph, badge, name and bar — with a bar **16.5u** [178px] long, exactly double.
  **This bar is the game's only health readout.**
* Downed / dead: whole row to `--squad-dead`, class glyph swaps to `✕`, bar drawn empty.
* Rows never reorder.

### 6.9 Primary weapon card

* **Anchor** bottom-right. Right edge `R − 2.96u`. Card `20.4u × 5.9u` [220×64px],
  `y = 87.7 → 93.6` [947→1011px]. (Measured on `bf6_gp_019`: bracket verticals at x = 1664 and the
  arm rules at y = 947 and 1010.)
* **Fill** `--scrim` (`rgba(0,0,0,0.33)`), sharp corners, no radius, no border.
* **Frame: two square BRACKETS, not a rectangle.** Each bracket is a full-card-height vertical
  stroke with short horizontal returns **1.0u** [11px] at top and bottom only — a literal `[` and
  `]`. Stroke **0.19u** [2px] measured, drawn at **alpha 1.0 in `--white-key`** so it is the
  brightest and hardest-edged mark in the frame despite being thin. **The card's top and bottom
  edges are open.** The brackets sit just *outside* the scrim, standing proud on the left and right.
* **Contents**, left→right:
  * **Weapon silhouette** flat `--art` fill, no outline, ~**9.7u × 2.4u** [105×26px], left-aligned
    with 1.3u [14px] inset, vertically centred. Built from the weapon's own procedural profile —
    receiver box, barrel line, magazine wedge, stock — with internal cut-lines drawn as `--scrim`
    negative space rather than as strokes.
  * **Magazine count** `t5` Display, tabular, slashed zeros, `--white`, right-aligned to the inner
    edge of the `]`. Zero-padded to `digitsOf(magSize)` with the pad digits in `--dim` (§4.4).
  * **Reserve** `/198` at 0.40× the magazine cap, **top-aligned to the magazine cap line** (§4.4),
    `--white` @ 0.80.

**The bracket is the "active weapon" affordance** and migrates to whichever slot is selected. In
some reference frames the bracket is absent (a transitional state) — treat it as an affordance, not
permanent chrome.

### 6.10 Stowed weapon row

* **Anchor** directly below the primary card, sharing its right edge, **indented 2.6u** [28px] from
  the primary's left edge. `y = 94.0 → 96.8`, height **2.8u** [30px].
* **Fill** `--scrim-deep`. **No brackets.**
* Small weapon silhouette left; ammo string `6 / 24` right-aligned at `t2`, **one uniform size on
  one baseline** with a thin space either side of the slash — deliberately unlike the primary's
  big/superscript split.
* A **keybind chip** `2` sits to the row's **left, outside it**, 0.65u [7px] gap.

### 6.11 Gadget tile strip

* **Anchor** immediately left of the weapon card, sharing its top edge `y = 87.7`.
  Right edge at `weaponCardLeft − 1.9u` [20px].
* **Tiles** up to 3, each **6.1u × 5.8u** [66×63px], butted with a **0.19u** [2px] gap, sharp
  corners, no border, no radius. Fill `--scrim`.
* **Icon** centred, `--art`, ~50% of the tile width, flat line-art.
* **Count numeral** pinned to the tile's **top-right corner**, 0.46u [5px] inset, `t1`, `--white`.
  Infinite stock draws the `∞` vector glyph (§6.14).
* **Selected tile**: four white **L-shaped corner brackets** drawn just *inside* the tile corners,
  arms **25% of the tile side**, 0.19u [2px] stroke, `--white` @ 0.70. **Not a fill, not a border,
  not a glow.**
* **Unavailable / cooling tile**: a **45° diagonal hatch** overlay across the tile — stripes
  **0.19u** [2px] wide at **0.83u** [9px] pitch running lower-left to upper-right — `--hatch`, with
  the icon dropped to 0.45 alpha. This hatch is the distinctive tell for "disabled"; do **not** grey
  the icon out or hide the tile.
* **Keybind chip** centred **below** each tile, 0.37u [4px] gap, outside the tile. A chip whose
  count is 0 drops to **0.45** alpha.

### 6.12 Throwable / quick-use row

* **Anchor** a single row **1.1u** [12px] above the weapon card, spanning the card's own width as
  its measure (items left- and right-aligned to the card's edges, not clustered).
* `y = 85.3 → 87.1`, height 1.85u [20px].
* **No scrim.** Items are `[chip][pictogram][count]` pairs: chip is the standard 1.85u keybind chip;
  pictogram is flat `--art` ~1.7u [18px] tall; count at `t1` `--white`.
* Depleted item: chip and pictogram to 0.45 alpha.

### 6.13 Right-edge gadget & ability rail

* **Anchor** right edge, tiles right-aligned to `R − 3.90u` [42px] — slightly further in than the
  weapon card. Vertically free-floating, centred around `y ≈ 69`, typically `y = 60 → 78`.
  (Measured on `bf6_gp_032`: tile right edge x = 1878, meter x = 1882–1886.)
* **Tiles** a vertical stack of 3–4 squares, **4.4u** [48px] each, butted with a 1px darker rule
  between them. Fill `--scrim`. White line-art icon **3.1u** [34px] centred.
* **Three stackable states**, exactly as §6.11: `ready` (plain scrim), `cooling` (45° hatch + icon
  at 0.45), `selected` (four L corner brackets, 0.19u stroke, offset 0.37u outside the tile
  corners). **A tile can be hatched AND bracketed at once.** A passive trait renders as a **bare
  icon with no tile at all**.
* **Segment meter** immediately to the right of the stack, separated by a **0.37u** [4px] gap: a
  **0.55u** [6px] wide vertical bar, `--white` @ 0.85, running the stack's full height, **broken by
  gaps aligned to the tile boundaries** — one segment per tile, filling bottom-to-top. Its right
  edge therefore lands exactly on the global right rule at `R − 2.96u`, which is why the rail's own
  tiles are inset further than everything else.
* A charging tile may additionally carry a horizontal **0.37u** [4px] progress bar in
  `--gadget` across its bottom edge, with a small square cap at the leading end.

### 6.14 The `∞` glyph

Not in the face. Draw as vector: two circles of radius `0.30 × capHeight`, centres at
`±0.32 × capHeight` from the run's centre, stroke `0.15 × capHeight`, with the inner arcs replaced
by a smooth crossing — i.e. a lemniscate stroked at the face's stem weight so it matches the
surrounding numerals.

### 6.15 Crosshair

* **Anchor** exactly `C, y = 50`.
* **Four ticks**, each a flat bar **1.11u × 0.28u** [12×3px], **oriented along its radius**: the top
  and bottom ticks are **vertical** bars, the left and right ticks are **horizontal** bars. Square
  ends, no rounding, no taper.
* **Inner gap** from centre to the near end of each tick: **1.67u** [18px] at rest, so the outer
  extent is ±2.78u [30px].
* **Centre mark** a small **diamond** (square rotated 45°), **0.42u** [4.5px] across. Not a round dot.
* **Colour** `--white-key` @ 0.95 with a 1px dark fringe for contrast against bright sky.
* **No ring, no outline, no diagonals, no dot-plus-ring.**
* **Behaviour** the four ticks translate radially outward with `WeaponState.currentSpreadDeg`; they
  never rotate, never change length or thickness. The centre diamond never moves.
  `gap(u) = 1.67 + currentSpreadDeg × 1.15`, clamped to **6.5u** [70px].

> *Measured, per-pixel, on `bf6_gp_024`:* top tick occupies dy −30…−19, bottom +18…+29, left
> dx −30…−19, right +18…+29, each 2px of core ink (3px with AA); centre mark dy −2…+2, dx −2…+1.
> `bf6_gp_021` gives dy −28…−17 / +16…+27 for the same reticle at a different HUD scale.
> `bf6_gp_032`, taken while the player is moving, shows the ticks at a gap of **42px** — that is the
> bloomed state and it is what sets the clamp above. `bf6_gp_015` (parachuting) shows **only** the
> centre mark, ticks fully retracted.
* **Hidden entirely** when `adsBlend > 0.5` (scoped/ADS) and when the player is downed. In a
  free-fall / no-weapon state the ticks fully retract and only the diamond remains.

### 6.16 Keybind chips

The one **inverted** element family in the HUD: a **light plate with a dark glyph**, and the only
rounded corners anywhere.

* **Plate** `1.85u × 1.85u` [20×20px] for a single glyph, radius **0.19u** [2px], fill `--chip-fill`
  @ 0.90. Multi-key labels share **one wider plate**, `1.85u` tall, padded 0.37u [4px] each side —
  never two adjacent chips.
* **Glyph** `t1`, `--ink`, centred, all-caps.
* **Placement rule:** a chip always sits on the side of its target **nearest screen centre** —
  beneath gadget tiles, left of the stowed weapon row, inside the minimap's bottom-left corner.
* **Behaviour** static. Brightens to 1.00 alpha for 90ms when its key is pressed.

### 6.17 Interaction prompt

* **Anchor** lower-centre, horizontally centred on `C`, band at `y = 59.6 → 62.2`
  (~9.6u below the crosshair).
* **Band** height **2.6u** [28px], **sized to its content**, fill `--scrim`, hard edges, no radius,
  no border.
* **Contents** left-aligned with 1.5u [16px] padding: keybind chip, 0.74u [8px] gap, then the action
  label in `t1` `--white`, +0.07 tracking, all caps (`REVIVE`, `RESUPPLY`, `PLANT CHARGE`).
* **Hold actions** a fill in `--white` @ 0.20 sweeps the band left→right over the hold duration.

### 6.18 World-space objective marker

Projected at the objective's world position; clamps to the screen edge when off-frame.

* **Icon** the same shape vocabulary at **4.5u** [49px] — circle (friendly), diamond (enemy),
  rounded square (neutral). Stroke **0.28u** [3px] in the owner hue (`--team-enemy-world` for the
  enemy diamond), interior `--scrim-marker`, 0.37u [4px] outer glow. Letter centred, `t3`, same hue.
* **Verb** above the icon, **2.6u** [28px] up, centred: `CAPTURE` / `DEFEND` / `NEUTRALIZING`, `t0`,
  +0.11 tracking. **The verb inherits the marker's own hue** — magenta over a magenta diamond in
  `bf6_gp_024`, cyan over a cyan circle — **except** when the point is contested, where marker and
  verb both go to `--contest-pip` amber (`bf6_gp_036`). `NEUTRALIZING` is the one exception and is
  always `--white`, because it describes what *you* are doing rather than who owns the point.
* **Distance** below the icon, **2.6u** down, centred, `t0`, in the marker's own hue, `58 m` /
  `1,150 m` (comma over 999, slashed zeros, normal space before the unit).
* **Contested state** four solid triangles in `--contest-pip`, **1.2u × 1.0u** [13×11px], at the
  four **45° diagonal** positions, apexes pointing **inward**, offset 0.93u [10px] outside the
  icon's bounding box. They pulse (§8).
* **Off-screen state** the icon is **retained** and clamped to the screen edge (margin 3.7u [40px]);
  a solid chevron is **welded to the icon's leading vertex** with a small gap, pointing toward the
  true bearing. The icon is never replaced by a bare arrow.
* **Occlusion** the marker dims to **0.55** when geometry occludes it; partial occlusion may darken
  only the occluded quadrant.
* **LOD chain** full (icon + letter + verb + distance) → outline only, 1.85u, letter still legible →
  a solid coloured pip 0.93u with no letter. **De-emphasis is always a drop to 0.25 alpha, never a
  removal.**

### 6.19 Capture progress bar (world-space)

* **Anchor** directly under the world objective marker, `y ≈ marker + 4.2u`.
* **Bar** **8.5u × 0.55u** [92×6px], square caps, **no visible track** — the unfilled portion is
  fully transparent. Fill in the **capturing** team's colour with a soft outer glow, growing
  left→right.
* **Occupancy counts flank it**: friendly headcount in `--team-friendly` immediately **left**, enemy
  headcount in `--team-enemy` immediately **right**, each `t0`, offset 0.93u [10px] from the bar
  end. Reads `4 ▬▬▬▬ Ø`. Sourced from `CapturePointRuntime.occupants`.
* **Status verb** centred **1.9u** below the bar, `t0`, `--white`, +0.10 tracking, no scrim.
* **Driven by** `CapturePointRuntime.progress` (−1 fully Insurgent … +1 fully Coalition):
  `fill = |progress|`, hue = `progress > 0 ? friendly : enemy`.
* **Behaviour** tracks the model with **no smoothing** — the bar rate *is* the information. When
  both teams occupy the point the bar stalls and the verb changes to `CONTESTED`.

### 6.20 Damage-direction indicator — **invented**

No reference frame contains one; `HudService.setDamageDirection` is in the frozen contract, so this
is designed in the reference's vocabulary rather than copied. Flagged as a deviation.

* **Anchor** screen centre, at radius **13.0u** [140px].
* **Geometry** a tapered arc segment spanning **34°** of the circle, thickness **0.83u** [9px] at
  its centre tapering to 0 at both ends (a crescent/fin, matching the off-screen-indicator fin
  language). Drawn at the screen-space bearing of `worldDirection` relative to the camera's yaw.
* **Colour** `--alert` with a 0.55u outer glow of the same hue. Alpha scales with `amount`:
  `alpha = 0.45 + 0.5 × clamp(amount / 40, 0, 1)`.
* **Aggregation** eight fixed 45° sectors, each holding one accumulator. A new hit inside a sector
  refreshes that sector's timer and takes `max` of the alphas — it does not spawn a second arc.
* **Motion** in over 90ms `E_SNAP`, hold 0.9s, out over 0.5s linear.
* **Explicitly not**: a full ring, a red screen-edge vignette, a numeric readout, or a
  compass-style tick. Those all read as a different game.

### 6.21 Bleedout ring — **invented**

Shown only when `PlayerState.downed === true`.

* Centred on `C, y = 50`, radius **9.3u** [100px], stroke **0.46u** [5px].
* Drawn as **12 evenly spaced dash arcs** (matching the reference's dashed interaction ring
  language), `--alert`, with a 0.55u glow.
* The dashes **extinguish clockwise from 12 o'clock** as `PlayerState.bleedout` falls 1 → 0.
* The word `DOWN` in `t3` `--alert` sits 2.8u below the ring centre.
* The crosshair is hidden and the whole HUD except the squad list, ticket bar and this ring drops to
  0.35 alpha while downed.

### 6.22 Blood / damage overlay

Not a HUD element in the strict sense but it lives on the same plane.

* Irregular translucent `--alert` blobs and streaks, **1.4u to 8.3u** across [15–90px], scattered
  around the frame **periphery**, densest in the two bottom corners.
* Heavily **depth-of-field blurred** so they read as being on a lens/visor plane, not on the HUD
  plane. No hard edges. **No vignette ring, no full-screen red tint.**
* Accumulates with damage taken; clears over ~4s of not being hit.

### 6.23 Hit marker

* **World-anchored on the victim**, not at the crosshair.
* **Four small filled triangles** at the four **diagonal** positions around the hit point, each
  apex pointing **outward**. Each triangle **1.1u** [12px]; total footprint **3.2u** [34px].

| Kind (`showHitmarker`) | Colour | Scale |
|---|---|---|
| `body` | `--fx-hit` white | 1.00 |
| `head` | `--fx-hit` white | 1.15, plus a 0.19u ring segment on each triangle's outer edge |
| `armour` | `--white` @ 0.65, desaturated | 0.90 |
| `kill` | `--fx-kill` gold, 0.55u glow | 1.25 |

* Motion §8.

### 6.24 Damage number

* **World-anchored** at the victim, offset up-right of the hit marker.
* **Two-part chip**, not a bare number:
  * **Left**: a light-grey translucent square tile **2.8u × 2.6u** [30×28px],
    fill `rgba(200,205,210,0.30)`, containing a small white `×` glyph **0.74u** [8px] centred.
  * **Right**, butted with a 1px lighter vertical rule between them: a dark strip
    `--scrim-deep` carrying the damage number in `t5` Display, `--white`, slashed zeros, hugging the
    digits with 0.37u [4px] padding.
* Consecutive hits on the same target within 0.6s **accumulate into the same chip** rather than
  spawning new ones.

### 6.25 Kill confirmation cluster

* **Anchor** below-left of screen centre, **left edge at `C − 32u`**, stacking **upward** from a
  bottom line at `y = 71`. Row pitch **3.0u**.
* **Award ribbon** a white glyph **3.7u × 1.6u** [40×17px]: a vertical dagger flanked left and right
  by four stacked tapering horizontal bars each, reading as stylised laurel wings. Pure white, no
  scrim.
* **KILL banner** the word `KILL`, `t1`, `--white`, inside a rectangle with a **0.19u** [2px] white
  stroke, **sharp corners, fully transparent fill**, padding 0.74u × 0.37u.
* **Award tags** same construction at 0.14u [1.5px] stroke — `DEFENSIVE`, `DAMAGE ASSIST`, `HEADSHOT`
  — side by side with a 0.37u gap, each sized to its own label.
* **Points** a filled white skull glyph followed by the value in `t3`, `--white`, slashed zeros.
* **Victim name** beneath, in the **victim's** team colour, `t2`.
* The empty-box treatment (stroke only, transparent interior) is what distinguishes these from the
  filled interaction band. **Never fill an award tag.**

### 6.26 Score-event popup (objective)

* Same anchor family as the kill cluster.
* A rectangle with a **0.14u** [1.5px] `--score-obj` stroke, **transparent fill**, sharp corners,
  containing yellow all-caps `t1` text with a lowercase-reading multiplier — `NEUTRALIZING x2`,
  `CAPTURED`, `DEFENDED`.
* The point value sits **1.5u** [16px] to its right in `t3` `--score-obj`, slashed zeros.

### 6.27 XP toast

* **Anchor** right side, **right-aligned to `R − 10.6u`** [115px] — immediately inboard of the
  ability rail, with a ~2.5u clear gap so the two never collide. `y = 60.6 → 64.8`.
  (Measured on `bf6_gp_032`: both lines right-align at x = 1797, rail tiles begin at x = 1834.)
* **Line 1** `+2ØØ XP` in `--xp`, `t3` Bold, sitting on a **translucent green fill**
  (`--xp-scrim`) hugging the text with 0.37u padding. This is the only coloured scrim in the HUD.
* **Line 2** `3,514/4,000` in `--white` @ 0.85, `t2`, comma separators, slashed zeros, no fill.
* Multiple awards stack downward.

### 6.28 World nameplate (friendly)

* **Anchor** projected above each visible squadmate/teammate.
* **Line 1** `[hex slot badge] [name] [optional "[3/5]" occupancy]`. Badge is the same solid
  flattened hexagon as the squad list at **1.7u** [18px] with the digit knocked out. Name `t2` in
  `--squad`.
* **Scrim** a faint **green-tinted** scrim behind the name, `rgba(80,180,40,0.22)`, hugging the text
  with 0.28u [3px] padding — **not** a neutral dark scrim. Plus a soft dark halo.
* **Line 2** the class glyph, **larger than the badge** (~2.4u), drawn *below* the name at the
  soldier's actual world position, in `--squad`.
* **Health bar** a 0.28u [3px] `--squad` bar immediately below the name, width matching the name's
  text width — drawn **only when health < 100%**.
* **Constant screen size** — no perspective scaling. Fades with distance and occlusion; the badge
  holds full opacity longer than the name.
* **LOD chain** badge+name+glyph → shape only → a bare solid `--team-friendly` diamond pip 0.93u.
* **Enemies get no nameplate.** Only a transient spot pin (§6.29).

### 6.29 Enemy spot / ping marker

* A classic map-pin silhouette: a filled circle **1.85u** [20px] with a downward-tapering point
  extending **1.3u** [14px] below it, total **1.85u × 3.2u**, in `--team-enemy` @ 0.65, no stroke.
* A small right- or left-pointing chevron beside it when the ping is off-screen in that direction.
* Time-limited; fades after 4s.

### 6.30 Off-screen squadmate indicator

* Floats at the screen edge where the teammate leaves view. Three parts, all `--squad` with a strong
  0.74u [8px] outer glow:
  1. a **solid filled circle** Ø**2.4u** [26px] carrying the slot digit knocked out dark at `t1`;
  2. a directional **wedge** immediately outboard — a `1.5u × 2.0u` [16×22px] filled fin with a
     **concave inner edge**, pointing away from screen centre;
  3. the **distance** centred **1.3u** below the circle, `t1`, `37Ø m`.
* Slides along the screen edge tracking the bearing; the wedge rotates to point at them.

### 6.31 Deployed gadget marker

* A **pure `--gadget` green** hard-edged filled silhouette **2.6u** [28px] tall at the gadget's
  world position — ammo crate, med pouch, sensor. **Green, not team-coloured.** No scrim, no
  outline, no leader line, no text.

### 6.32 Notice banner (`pushNotice`)

* **Anchor** centred on `C`, `y = 20.5` — under the capture row, above the world markers.
* A single all-caps line, `t3`, +0.08 tracking, **no scrim**, with a 1px dark shadow, plus a 0.14u
  horizontal rule 1.1u beneath it that extends 2.8u past the text on each side.

| `kind` | Colour |
|---|---|
| `capture` | `--team-friendly` |
| `lost` | `--team-enemy` |
| `objective` | `--score-obj` |
| `system` | `--white` |

---

## 7. Blueprint chrome

The connective tissue of the whole UI language, and the thing whose absence makes a reconstruction
feel like a bootstrap template. **1px strokes at 25–45% opacity**, `--white`, drawn at z=90 behind
overlay content and in the outer 10% margin of full-screen states only (never over live gameplay):

* short horizontal ruler lines with four evenly spaced 0.55u tick marks, terminating in a double
  chevron `»` (mirrored `«` on the right side);
* tall thin bracket `[` `]` marks ~17% of screen height, each with a small hollow square at its
  vertical midpoint;
* loose vertical columns of 0.46u [5px] **hollow** squares at 1.3u [14px] pitch;
* standalone `+` crosses, 0.74u [8px];
* one long thin diagonal hairline crossing the frame.

All non-functional. Use sparingly — three or four marks per full-screen state, not a border.

---

## 8. Motion

### 8.1 Easing curves

| Token | Curve | Use |
|---|---|---|
| `E_OUT` | `cubic-bezier(0.22, 1.00, 0.36, 1.00)` | settles: bar fills, reflows, fades in |
| `E_SNAP` | `cubic-bezier(0.16, 1.00, 0.30, 1.00)` | pops: hit markers, chip scale-in |
| `E_IO` | `cubic-bezier(0.65, 0.00, 0.35, 1.00)` | symmetric transitions: shape morphs |
| `LIN` | linear | anything that *is* a rate: capture progress, reload sweep, compass |

### 8.2 Table

| Element | In | Hold | Out | Notes |
|---|---|---|---|---|
| Ticket fill | 450ms `E_OUT` lerp toward target | — | — | never snaps |
| Ticket digits | 120ms brightness ×1.4 | — | 250ms back | on every value change |
| Drain-front glow | 150ms | 1.5s after last change | 400ms | |
| Capture chip morph | 220ms `E_IO` crossfade; incoming shape scales 0.90→1.00 | — | — | |
| Capture chip contested pulse | 1.1s sine loop, alpha 0.35 ↔ 1.00 | while contested | — | |
| Contested corner triangles | 0.9s sine loop, offset 0.93u ↔ 1.4u | while contested | — | pulse inward/outward |
| Capture progress bar | `LIN`, 1:1 with model | — | — | **never smoothed** |
| Killfeed row | 180ms slide from +2.5u X + alpha 0→1, `E_OUT` | **6.0s** | 350ms alpha→0 | rows below reflow over 160ms `E_OUT` |
| Killfeed (local player row) | same | **8.0s** | same | brighter, holds longer |
| Hit marker | scale 0.55→1.00 over **70ms** `E_SNAP` | 110ms | 180ms alpha→0 | kill variant: 320ms out |
| Damage number | pops at impact | drifts up **2.0u** over 850ms `E_OUT` | last 350ms of the drift | accumulating hit re-pops the chip 1.00→1.12→1.00 over 120ms |
| Kill cluster | ribbon t=0, victim name t=+80ms, KILL banner t=+160ms, tags t=+240ms; each 120ms alpha + 0.37u rise | **1.5s** | 350ms | a new event pushes the stack up 3.0u over 200ms |
| Score popup | punches in at scale 1.15 → 1.00 over 140ms `E_SNAP` | 1.2s | rises 0.55u + fades 300ms | |
| XP toast | green scrim wipes left→right 220ms `LIN`, text alpha 150ms | **1.6s** | drift up 0.55u + fade 350ms | |
| Reload | card scrim ×1.5 flash 120ms at start; magazine numerals to `--dim` for the whole reload; a 0.19u progress line sweeps the card's bottom edge `LIN` | — | numerals snap to `--white` over 80ms at completion | |
| Low-ammo pulse | — | 900ms sine loop `--warn` ↔ `--white` | — | at `ammo ≤ 0.25 × magSize` |
| Empty-magazine pulse | — | 700ms sine loop `--alert` ↔ `--warn` | — | at `ammo === 0` |
| Crosshair bloom | grow: **60ms `LIN`** (no smoothing on the way out) | — | recover: **220ms `E_OUT`** | asymmetric on purpose |
| Damage direction | 90ms `E_SNAP` | 900ms | 500ms `LIN` | §6.20 |
| Interaction prompt | 120ms alpha + 0.55u rise `E_OUT` | while in range | 100ms | |
| Notice banner | 180ms slide from +1.1u Y `E_OUT` | 2.5s (or `durationSeconds`) | 400ms | |
| Keybind chip press | 90ms to full alpha | — | 200ms | |
| Squad health bar | **heal**: 250ms `E_OUT` | — | **damage: INSTANT** | an eased damage bar hides the hit |
| Ability tile ready | hatch wipes away over 300ms `E_OUT`, then a 120ms white flash | — | — | |
| Compass, minimap pan/rotate | **1:1, no interpolation** | — | — | lerping either feels like ice |
| Marker occlusion dim | 120ms `E_IO` both ways | — | — | |

### 8.3 Global rules

* Nothing animates position by more than **3.0u**. Big travel reads as a web page.
* Nothing scales by more than **1.25**.
* No rotation animation anywhere except the compass tape translate and the minimap markers' facing.
* No easing longer than **500ms** on anything the player is reading during combat.

---

## 9. Render order within a frame

1. Resolve `hudScale` and `u` from the canvas size.
2. Draw z=0…10 (minimap plate + contents) into the HUD ortho camera.
3. Project and draw z=20 world markers, sorted back-to-front by depth.
4. Draw z=30 scrims, then z=40 screen-space content, both as batched instanced quads.
5. Draw z=50 crosshair, z=60 transient, z=70 alert, z=80 prompts and chips.
6. For every element with a glow token: draw the dilated blurred pass **immediately before** its
   sharp pass, additively, within the same z-layer.
7. Text is one draw call per (atlas, threshold, colour-mode) tuple. Do not issue a draw per glyph.

---

## 10. State machines

Every dynamic element as an explicit state table. Transitions not listed do not exist.

### 10.1 Ticket bar

Source: `MatchState.tickets`, `MatchState.ticketsMax`, `MatchState.phase`.

| State | Entry condition | Presentation |
|---|---|---|
| `IDLE` | no change in 1.5s | flat fill, no glow |
| `DRAINING` | `tickets[team]` decreased | fill lerps 450ms; digits flash 120ms; drain-front glow on |
| `CRITICAL` | `tickets[team] / ticketsMax ≤ 0.15` | the losing team's plate digits pulse 900ms sine, `--warn` ↔ team hue |
| `ROUND_OVER` | `phase` is post-round | both fills freeze; the winner's plate inverts to a filled team-hue plate with `--ink` digits |

### 10.2 Capture chip

Source: `CapturePointRuntime.state`, `.contested`, `.progress`, and distance to the local player.

| State | Shape | Colour | Modifier |
|---|---|---|---|
| `NEUTRAL` | rounded square | `--neutral-obj`, white @0.30 fill | — |
| `OWNED_FRIENDLY` | circle | `--team-friendly` | — |
| `OWNED_ENEMY` | diamond | `--team-enemy` | — |
| `CAPTURING` | owner shape **+** capturing team's shape overlaid | both | 1.1s alpha pulse |
| `CONTESTED` | owner shape, **solid filled** @ 0.55 | owner hue, letter knocked out white | 1.1s alpha pulse |
| `NEUTRALISING` | empty circle, **no letter** | dim | — |
| `DIM` | any of the above | whole element @ **0.25**, no glow, stroke thinned to 0.14u | applied when the point is >250m away and not the ordered objective |

Transitions crossfade over 220ms. Every state change also fires a §6.32 notice
(`capture` / `lost` / `objective`).

### 10.3 World objective marker

| State | Trigger | Presentation |
|---|---|---|
| `LOD0` | on-screen, < 120m | icon + letter + verb + distance |
| `LOD1` | on-screen, 120–400m | outline icon 1.85u + letter, distance only |
| `LOD2` | > 400m | solid pip 0.93u, no letter, no text |
| `OCCLUDED` | geometry between camera and point | multiply alpha ×0.55 |
| `CLAMPED` | off-screen | icon retained at the screen edge + welded chevron toward the true bearing |
| `ORDERED` | this is the squad's current order | an extra **2px white ring** around the icon — white is otherwise never used for objective icons |
| `CONTESTED` overlay | `.contested` | four `--contest-pip` triangles at the diagonals, pulsing |

### 10.4 Killfeed

```
enqueue(KillFeedEntry)
  → SLIDE_IN (180ms)
  → HOLD (6.0s; 8.0s if killer or victim is the local player)
  → FADE (350ms)
  → dequeue
```

* Rows are a FIFO capped at **5**. A sixth arrival immediately transitions the oldest to `FADE`
  regardless of its remaining hold.
* Reflow of the rows below happens over 160ms `E_OUT` and is independent of the row's own animation.
* `killer === victim` renders as a single centred name (suicide) with a skull and no weapon glyph.
* `weapon === null` renders no weapon glyph and closes the gap.

### 10.5 Hit marker

```
IDLE ──showHitmarker(kind)──► POP(70ms) ──► HOLD(110ms) ──► FADE(180ms) ──► IDLE
```

* Retriggerable from any state: a new call resets to `POP` with the new `kind`.
* Precedence when two arrive in the same frame: `kill` > `head` > `armour` > `body`.
* Anchored in **world space** at the victim's chest; if the victim entity dies and despawns the
  marker holds its last projected screen position for the remainder of the animation.

### 10.6 Damage direction

Eight sectors, each an independent instance of:

```
IDLE ──setDamageDirection(dir, amount)──► RISE(90ms) ──► HOLD(900ms) ──► FADE(500ms) ──► IDLE
```

* A hit landing in a sector already in `HOLD` or `FADE` resets that sector to `HOLD` and takes
  `alpha = max(existing, new)`.
* Sector index = `floor((atan2 bearing relative to camera yaw + π/8) / (π/4)) mod 8`.

### 10.7 Reload

Source: `WeaponState.reloading`, `.reloadEndTick`, `.ammo`.

| State | Condition | Presentation |
|---|---|---|
| `READY` | `!reloading && ammo > 0` | magazine numerals `--white` |
| `RELOADING` | `reloading` | numerals to `--dim`; scrim flash on entry; progress line sweeps the card's bottom edge, `LIN`, over `(reloadEndTick − now)` |
| `CHAMBERING` | 80ms after `reloading` falls false | numerals ramp `--dim` → `--white` |
| `EMPTY` | `ammo === 0 && !reloading` | numerals pulse `--alert` ↔ `--warn`, 700ms |

### 10.8 Low ammo

| State | Condition | Presentation |
|---|---|---|
| `NORMAL` | `ammo > 0.25 × magSize` | `--white` |
| `LOW` | `0 < ammo ≤ 0.25 × magSize` | `--warn`, 900ms pulse |
| `EMPTY` | `ammo === 0` | `--alert`, 700ms pulse; the reserve string also goes `--warn` if `reserve === 0` |

### 10.9 Spotted

Two distinct meanings, both required:

**(a) Enemy spotted by us** — an enemy the squad has marked.

| State | Trigger | Presentation |
|---|---|---|
| `HIDDEN` | not spotted | nothing |
| `SPOTTED` | AI/player spot event | §6.29 map-pin at the enemy's position, plus a `--team-enemy` diamond on the minimap |
| `DECAY` | 4s after the last refresh | pin fades over 600ms |

**(b) The local player is spotted by an enemy** — invented, flagged as a deviation.

| State | Trigger | Presentation |
|---|---|---|
| `CLEAR` | no enemy has line-of-sight lock | nothing |
| `MARKED` | an enemy has held LOS on the player for > 0.6s | a `--team-enemy` **hollow diamond outline 3.7u** [40px] centred at `C, y=50`, 1px stroke, alpha pulsing 0.20 ↔ 0.45 at 1.2s. It sits **outside** the crosshair's gap radius so it never obscures the aim point. |

### 10.10 Squad list row

| State | Condition | Presentation |
|---|---|---|
| `LOCAL` | this is the local player | `--self`, bottom row always, bar 16.7u |
| `ALIVE` | `alive && health === 100` | `--squad`, bar full, 9.0u |
| `HURT` | `alive && health < 100` | `--squad`, bar width = `health/100 × 9.0u` |
| `DOWNED` | `downed` | `--squad-dead`, bar drawn as an empty outline, class glyph unchanged |
| `DEAD` | `!alive` | `--squad-dead`, class glyph → `✕`, bar absent |

Rows never reorder. An empty squad slot draws nothing (the list simply has fewer rows).

### 10.11 HUD root state (`HudService.forceState`)

| State | What is visible |
|---|---|
| `default` | everything in §6 that is `always on` |
| `capturing` | as `default`, plus the world capture bar, occupancy counts and status verb forced on for the nearest point |
| `dead` | everything except the crosshair, weapon card, stowed row, gadget strip, throwable row and ability rail; the killfeed, ticket bar, capture row, compass and squad list remain; the whole HUD at 0.6 alpha |
| `spawnmenu` | full-screen deploy map (z=90): the minimap surface scaled to fill, capture points as large markers, spawn choices as pips, mode/map identity block top-left, `DEPLOY` outlined button bottom-right; live HUD hidden except the ticket bar and capture row |
| `scoreboard` | full-screen table (z=90) over a live, unblurred gameplay backdrop with `rgba(255,255,255,0.06)` / `rgba(255,255,255,0.02)` alternating row bands; the local player's row in a 2px `--team-friendly` outline with a `rgba(40,110,190,0.35)` fill; live HUD dimmed to 0.25 |

### 10.12 Persistence

| Always on | Transient (auto-expiring) | De-emphasised, never removed |
|---|---|---|
| compass, ticket bar, capture row, minimap, squad list, weapon card, stowed row, gadget strip, throwable row, ability rail, crosshair | killfeed rows (6s), hit markers (0.36s), damage numbers (0.85s), kill cluster (2.0s), score popups (1.5s), XP toast (2.1s), interaction prompts (proximity), notices (2.5s), damage-direction arcs (1.5s), spot pins (4s) | distant world markers → 0.25 alpha; unavailable abilities → hatch overlay; irrelevant capture chips → thinner stroke, no fill; cooldown text → 0.45 alpha |

---

## 11. Element index — layout map

Everything, one row each. `C` = horizontal centre, `L`/`R` = left/right screen edge.

| Element | X anchor | Y | Size (u) | z | § |
|---|---|---|---|---|---|
| Compass pointer | `C` | 0 | 1.30 × 0.83 | 40 | 6.1 |
| Compass tape | `C ± 16.5` | 2.60 baseline | 33.0 wide, 0.247/deg | 40 | 6.2 |
| Compass dashed rule | `C ± 16.5` | 3.95 | 33.0 × 0.19 | 40 | 6.3 |
| Ticket assembly | `C ± 25.7` | 5.20 → 7.95 | 51.4 × 2.75 | 30/40 | 6.4 |
| Capture row (3) | `C`, `C ± 4.35` | 10.5 centres | 12.10 × 3.40 | 40 | 6.5 |
| Status line | `C` | 12.6 | — | 40 | 6.5 |
| Notice banner | `C` | 20.5 | — | 40 | 6.32 |
| Killfeed | `R − 2.96` | 5.6, pitch 2.75 | ≤ 5 rows | 40 | 6.6 |
| Minimap | `L + 2.87` | bottom − 3.05 | 23.6 × 23.6 | 0/10 | 6.7 |
| Squad list | minimap right + 1.8 | bottom-aligned, pitch 5.46 | 4 rows | 40 | 6.8 |
| Crosshair | `C` | 50 | gap 1.67, tick 1.11 × 0.28 | 50 | 6.15 |
| Interaction prompt | `C` | 59.6 → 62.2 | content × 2.6 | 80 | 6.17 |
| Kill / score cluster | `C − 32` left edge | bottom 71, up | pitch 3.0 | 60 | 6.25 |
| XP toast | `R − 10.6` | 60.6 → 64.8 | — | 60 | 6.27 |
| Ability rail | `R − 3.90` | 60 → 78 | 4.4 tiles | 30/40 | 6.13 |
| Rail segment meter | `R − 3.53` → `R − 2.96` | matches rail | 0.55 wide | 40 | 6.13 |
| Throwable row | card width | 85.3 → 87.1 | 1.85 tall | 40 | 6.12 |
| Gadget tiles | card left − 1.9, growing left | 87.7 → 93.5 | 6.1 × 5.8 | 30/40 | 6.11 |
| Gadget chips | under each tile | 94.2 | 1.85 | 80 | 6.16 |
| Weapon card | `R − 2.96` | 87.7 → 93.6 | 20.4 × 5.9 | 30/40 | 6.9 |
| Stowed row | `R − 2.96` | 94.0 → 96.8 | 17.8 × 2.8 | 30/40 | 6.10 |
| Damage-direction arcs | `C`, r = 13.0 | 50 | 34° × 0.83 | 70 | 6.20 |
| Bleedout ring | `C`, r = 9.3 | 50 | 0.46 stroke | 70 | 6.21 |

**Empty by design:** top-left (entire quadrant), bottom-centre (that is vehicle furniture and we
have no vehicles), and the centre field — the middle ~44% of width by ~55% of height contains
**only** the crosshair and world-projected marks. No panel HUD ever enters it.

---

## 12. Acceptance checklist

A HUD frame ships only when every one of these is true. Check them against
`reference/gameplay/bf6_gp_019.jpg`, `bf6_gp_021.jpg`, `bf6_gp_024.jpg`, `bf6_gp_032.jpg` and
`bf6_gp_038.jpg`.

- [ ] Friendly = circle, enemy = diamond, neutral = rounded square, in all three places they appear.
- [ ] Swapping the enemy hue token to magenta changes **nothing** but the colour — the shape read
      survives intact (the `bf6_gp_024` test).
- [ ] The magazine count is zero-padded to the mag capacity's digit width, with the pad in `--dim`
      and the significant digits white (`Ø94`, not `94` and not a uniformly white `094`).
- [ ] Every zero in the frame is slashed.
- [ ] The minimap has no border, no radius, no shadow, no glow.
- [ ] The losing ticket track shows its dark stub **against the centre gutter**, not at the edge.
- [ ] The two tracks never touch; there is a 1.02u gutter on `C`.
- [ ] Killfeed, crosshair, compass, squad list and nameplates have **no scrim**.
- [ ] Keybind chips are light plates with dark glyphs and are the only rounded corners in the frame.
- [ ] The reserve ammo is top-aligned to the magazine's cap line, not its baseline.
- [ ] The weapon card is framed by two brackets, not a rectangle; its top and bottom edges are open.
- [ ] The squad list sits to the **right** of the minimap and the local player is the bottom row, in
      `--self`, with a bar roughly twice as wide as the others.
- [ ] There is **no** health bar or health number anywhere else on screen.
- [ ] Off-map minimap objectives sit half-outside the plate boundary, uncropped.
- [ ] The disabled ability state is a 45° hatch, not a grey-out.
- [ ] The selected tile is four corner brackets, not a border or a fill.
- [ ] Nothing is pure `#FFFFFF` except the card brackets and the crosshair.
- [ ] Top-left and bottom-centre are empty.
- [ ] The HUD is drawn after tonemapping, at native resolution, and is not in the TAA history.
- [ ] Digits are tabular: a counter ticking from 199 to 200 does not shift a single pixel.
