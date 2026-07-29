---
name: blind-ab-critic-loop
description: >
  Score your own visual output honestly by comparing it blind against a real reference, using an
  LLM (or human) critic that never knows which panel is yours, and reporting a DELTA rather than an
  absolute score so the number survives a harsh or lenient judge. Use when driving an iterative
  "make it look better" loop, when self-assessment keeps inflating, or when you need a stable visual
  regression signal across many rounds. Proven in IRONSIGHT — and the source of its hardest lesson.
status: PROVEN as a mechanism (the harness and the delta-scoring fix both exist and work). Read the
  honesty section: this loop also produced the project's most expensive false-confidence failure.
---

# Blind A/B critic loop

## What it is

An automated (or semi-automated) critique loop where each render is composited **beside a real
reference frame** into a single sheet labelled only **A** and **B**, with the left/right assignment
randomised. A critic — an LLM agent or a human — is asked "which of these is the shipped AAA frame,
and what specifically gave it away?" and scores both panels on a fixed rubric, *without* being able to
see which panel is the project's own work. The answer key is written to a separate directory the
critic is forbidden to open until after the verdict is recorded.

The blind is the entire point. It is very easy to rate your own work generously when you know which
one is yours (`HANDOFF.md` §3, `tools/compare.mjs` header).

## The mechanism (`tools/compare.sh` / `tools/compare.mjs`)

```
./tools/compare.sh --ours tools/shots/hero_ridge.png \
                   --ref  reference/battlefield/bf6_00.jpg \
                   --out  tools/compare/hero_ridge_vs_bf6.png
./tools/compare.sh --reveal tools/compare/hero_ridge_vs_bf6.png   # AFTER a verdict is recorded
```

Load-bearing details, each of which the code got right on purpose:

- **Sides randomised, but derived from a hash of the pair** so a given comparison is *stable* across
  reruns — a critic re-reviewing the same sheet must not see the panels silently swap under them
  (`tools/compare.mjs`, the layout-derivation comment).
- **The answer key goes to `tools/compare/.keys/<sheet>.json`**, a directory critics are instructed
  never to open. `--reveal` reads it back only after a verdict exists.
- **Panels are composited at identical size.** A size or crop mismatch is itself a tell and would
  leak provenance.
- It is a general A/B harness — it does not care where the reference panel comes from. On a fresh
  clone with no reference corpus, point it at any two images; it still builds the sheet.

## The rubric turns taste into falsifiable observations (`docs/AAA_RUBRIC.md`)

"Make it look AAA" is useless as an instruction. The rubric exists so it becomes a list of
falsifiable claims about a specific PNG. A critic must:

1. **Look at the image before reading anything about it** — form a cold first impression.
2. **Answer the provenance question first, in one line**: *shipped AAA title, or WebGL/hobby demo?*
   Then *what specifically gave it away?* The first thing noticed is the most important finding in the
   whole review, because it is what a player would notice too.
3. Work the checklist, scoring each axis 0–10 **and citing the exact pixels** that justify it.
   "Shadows are bad" is worthless. "The shadow under the crate has a uniform 3 px penumbra identical
   to the 40 m crane's, so there is no contact-hardening and probably a single fixed-radius PCF
   kernel" is a finding.
4. **Be harsh.** A 7 is competent indie, an 8 is good mobile AAA; a 9–10 only for something you would
   accept in a marketing screenshot.
5. **Every finding names the file/subsystem responsible and the concrete change.** Findings that
   cannot be acted on are noise.

## THE hard lesson: the instrument drifts — score the gap, not the frame

This is the most important thing in the skill, and it was discovered the expensive way
(`HANDOFF.md` §2.1, `docs/AAA_RUBRIC.md` "The instrument drifts").

**Measured:** in one round, three hero shots whose code was *not touched* moved **−1.90, −1.76 and
−1.42**. `light_cascades` was verified pixel-identical by eye and lost 1.90. Nothing about the frames
changed — the critics did. That drift (~1.7) is **larger than the entire per-round signal** (+0.14 to
+0.73), so every between-round trajectory measured with absolute scores was inside the noise floor.
The likely cause: a strongly-worded anti-inflation warning in the critic prompt biased them
systematically downward. A caution meant to protect the measurement distorted it instead.

**The fix — a blind calibration anchor and a differential score:**

1. Every critic scores **both** blind panels on all axes — ours and the reference — without knowing
   which is which. **`delta = score(ours) − score(reference)`** is the metric that matters. A harsh
   critic marks both panels down and the delta survives; a lenient one marks both up and it survives.
2. **The reference panel is a calibration check.** A real shipped AAA frame should land ≈8.5–9.5. A
   critic who scores the *reference* at 6.5 has proven their scale is compressed — discard their
   absolute numbers, keep their delta and their findings.
3. **Scoring both forces like-for-like reasoning.** A critic who just scored a real frame's materials
   9.0 cannot casually award ours 7.0 without saying what the gap is.

Report `delta` as the headline. IRONSIGHT's targets: `delta ≥ −2.0` interim, `delta ≥ −0.5` project
bar. **Absolute scores are usable only for ranking shots against each other *within* one round; never
resurrect absolute between-round comparisons.**

## THE second lesson: a critic loop is blind to behaviour

Twelve rounds of this loop scored the *look* of an `ai_firefight` frame and never noticed that the
bots in it did not move (`HANDOFF.md` §2.2). The loop optimises what it can see, and a screenshot
cannot see a mechanic. A human played the game for ten minutes and found four real bugs the critics
missed entirely. **A visual critic loop must be paired with a behaviour instrument** (see the
deterministic-screenshot-harness skill and IRONSIGHT's `tools/soak.sh`) and with actual human play —
never trusted as the sole measure of whether the thing works.

## Keeping it reproducible and lawful

The reference corpus (real gameplay frames) is **third-party imagery**: in IRONSIGHT it is gitignored,
local-only, never committed, never shipped, and not redistributed (`README.md`, `HANDOFF.md` §5). The
A/B sheets composite a real frame beside ours, so `tools/compare/` is gitignored too — it was briefly
tracked and had to be purged from history. If you build this loop: assemble the reference corpus
locally, keep it out of the repo and the bundle (a CI grep can ban any import of `reference/`), and
document that scores are only reproducible against a corpus a user assembles themselves.

## Reproducing this in a new project
1. Build a compositor that puts your frame beside a reference at identical size, labels them A/B,
   randomises sides by a stable hash, and writes the key to a directory the critic cannot read.
2. Write a rubric that demands a cold provenance call first, pixel-cited per-axis scores, and an
   actionable file-named change per finding.
3. Have the critic score **both** panels; report `delta = ours − reference`.
4. Use the reference score as a calibration check and discard the absolutes of any critic whose
   reference score proves their scale is off.
5. Compare deltas between rounds, never absolutes.
6. Pair it with a behaviour instrument and with human play. The loop cannot see a mechanic.
7. Keep the reference imagery out of git and out of the bundle.

## Key files
- `tools/compare.mjs` / `tools/compare.sh` — the blind sheet builder, hash-stable side assignment,
  `.keys/` answer key, `--reveal`.
- `docs/AAA_RUBRIC.md` — the rubric, the drift measurement, and the delta-scoring fix.
- `HANDOFF.md` §2.1–2.2, §3, §5 — the drift lesson, the behaviour-blindness lesson, corpus hygiene.
