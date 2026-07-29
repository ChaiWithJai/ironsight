Every civilization in this academy begins the same way: someone speaks a number.

Not a big number. A number you could write on a coin, or tattoo on a wrist, or put in a URL. From
that number — the **seed** — everything else follows: where the stars hang, where the land rises,
who is born and what they name their towns. Speak the same number twice and you get the same world
twice, down to the last pixel. That is not a metaphor. Try it below: the two scribes never consult
each other. They only share the seed.

## The teaching

This is the first and deepest JAMStack idea: **a static site is not a dead site.** There is no
server behind this page, no database, no API host — it is files on a CDN. And yet it computes a
universe in front of you, because the **J** in JAM is a full programming language running on the
most widely deployed runtime in history: the browser.

The generator here is `PCG32` — the *only* source of randomness allowed in the entire IRONSIGHT
engine (`Math.random()` fails the build). Why so strict? Because `Math.random()` answers to no
seed: it gives you a different world every time, which means you can never *reproduce* anything —
not a bug, not a screenshot, not a moment a player wants to share. A seeded generator turns
randomness into **fate**: surprising in the moment, identical in the replay.

## Forked streams — many fates from one

Watch the table under the chart. The world's fate is not one stream but a tree: `fate.fork('stars')`
and `fate.fork('sigil')` each derive an independent sequence from the same seed. If the star-scribe
draws one extra number, the sigil does not change — each guild of the world reads its own thread of
fate. In the real engine this is what lets a visual-effects tweak leave the terrain untouched.

> Notice the URL as you change the seed. The whole state of this page lives there — copy the link
> and the world travels with it. No account, no save file, no server. **State in the URL is the
> humblest API there is.**

## Lift the curtain

The generator drawing this page is the engine's own: [`src/engine/rng.ts`](https://github.com/gillworks/ironsight/blob/main/src/engine/rng.ts)
— 260 lines, heavily commented, including why 64-bit arithmetic is done in 32-bit halves.
