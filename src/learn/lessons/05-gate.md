Every well-built world has a wall — not to keep people out, but to keep **entropy** out.

IRONSIGHT was written by more than two hundred AI agents working in parallel on one renderer.
That should have produced chaos. It produced a game, because every change had to pass through
gates that a machine — not a mood — controls. This academy walks through the same gates, and this
final chapter lets you run some of their rituals *live, in your browser, right now*.

## The rituals below

The three checks under this scroll are re-run when you command the gate:

- **The Rite of the Twin Scribes** — two independent generators are given the same seed and asked
  for 4,096 numbers each. Their fingerprints must match. This is Chapter I's promise, *proven*.
- **The Rite of the Unmoved Mountain** — the terrain of Chapter II is computed twice and
  fingerprinted. Same seed, same mountain, or the gate turns red.
- **The Rite of the Separate Threads** — a decoy stream draws extra numbers between two forks of
  fate; the forked stream must be unaffected. This is what makes parallel work *composable*.

If any rite fails you will see it fail — the page does not know how to lie about it, because the
verdicts are computed from the same functions the demos use.

## The teaching

Testing an interactive, visual thing feels impossible until you notice what the rituals have in
common: **they only test pure functions of a seed.** That is not luck — the whole academy was
*built deterministic so that it would be testable*. The order of causality is the lesson:

1. **Contain entropy first** — one seeded RNG, no wall clock, no network, state in the URL.
2. **Then testing is cheap** — a screenshot of a deterministic page is a fact, not a flake.
   `tools/learn-shots.mjs` freezes each chapter at a known tick and captures pixels; any diff is
   a real change, made by a real commit, with a name on it.
3. **Then speed is free** — because the checks never flake, you can run them on every change and
   *trust* green. The feedback loop is: edit → hot reload (<1 s) → `npm run verify` → pixels.

The real project's gates, which this lane also passes through: `npm run typecheck` (the contract),
`npm run boundaries` (the law — no cross-lane imports, no `Math.random()`, no `fetch`, no
`Date.now()`), `npm run build` (the world must actually compile), and the screenshot harness (the
world must actually *look right* — verified by blind A/B comparison, because it is very easy to
grade your own work generously).

> Entropy is not defeated once. It is defeated on every commit, forever, by gates that do not
> get tired. That is the dharma of software: the law is only real if something enforces it.

## Graduation

You have held the seed, raised the land, peopled it, read its ledger, and stood at its gate.
One thing remains: [**forge your own civilization**](../forge/). Name its people, choose a sigil,
declare an era, and rename a place. The forge publishes those choices as a static URL contract;
following it boots the full civilization and changes the real in-game HUD. Its field missions then
listen to movement, weapon, damage, destruction, and place data from the shipped FPS. This time the
world—not a miniature—is the lesson.
