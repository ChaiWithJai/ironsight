The land was a function of *where*. The people are a function of *when*.

Twelve wanderers step onto the terrain you shaped in Chapter II — same seed, same coastlines.
Each carries its own forked thread of fate. Each season they look around, prefer the fertile
lowlands near the water, and walk. When a wanderer finds land good enough, they stop, and a town
is born — named, as everything here is named, by the seed.

## The teaching

This demo adds the third ingredient of living worlds: **time as a sequence of discrete ticks.**
The simulation does not know what a millisecond is. It knows *tick 481*. Press **advance a
season** and exactly twenty ticks elapse; press it again and the same twenty follow. History here
is `state = f(seed, tick)` — pause it, replay it, scrub it. (The screenshot tests for this very
page exploit exactly that: they render tick 240 and compare pixels.)

Wall-clock time — `Date.now()`, "how long did that frame take?" — is **banned from the engine's
simulation** by CI, because a world that reads the clock plays differently on a fast machine than
a slow one, and can never be replayed at all. The fixed tick is what makes a browser game fair,
and what makes it *testable*.

The second idea is bigger than it looks. In IRONSIGHT, bots do not have their own movement code.
A bot's brain produces a `PlayerIntent` — *the identical data structure the human's mouse and
keyboard produce* — and the same laws of motion consume both. Character, in a well-built world,
is not a special case. It is the same physics wearing a different will. The wanderers below work
the same way: one rule of walking; twelve threads of fate deciding where to point it.

> Symbols, characters, time and places — notice the order this academy taught them in. Fate
> (the seed), then places (the land), then characters (the people), and their history is written
> into the ledger you will read in Chapter IV. That is worldbuilding as a curriculum: each layer
> is one pure function deeper.

## Lift the curtain

- The real brains: `src/ai/brain.ts` (utility scoring), `src/ai/intent.ts` (thought → intent).
- The law that only one lane may turn intent into motion: `docs/ARCHITECTURE.md` §3.4.
- The fixed-tick loop with its integer-microsecond accumulator: `src/engine/loop.ts`.
