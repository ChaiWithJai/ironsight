# Teaching audit: Chronicle of Harbour Reach

Owner: Jai Bhagat · DharmicData.org  
Method: CDF / Gagné data-to-wisdom pipeline  
Status: playable learning, durable publishing, and near-transfer loops implemented; moderated human
learning evidence remains

## Learner transformation

Target learner: a curious builder who may equate “static” with “passive” and “API” with “a live
application server.”

Transformation: from reading claims about JAMStack capabilities to manipulating, measuring, and
proving a deterministic civilization in a browser.

## Labeled learning objects

| Chapter | Objective (Bloom) | Observable skill | Misconception corrected | Assessment evidence |
|---|---|---|---|---|
| Seed | Explain/apply determinism (2–3) | Address a reproducible world with a seed | Static sites cannot create living systems | URL seed changes; canvases retain zero pixel difference |
| Land | Apply/analyze parameters (3–4) | Meet a terrain brief with numeric constraints | Procedural art is uncontrolled randomness | sea ≥ 0.48, octaves ≥ 6, land fraction 5–35% |
| People | Explain/apply fixed ticks (2–3) | Advance history independent of wall time | Animation time and simulation time are equivalent | learner advances to tick ≥ 60 |
| Ledger | Explain/classify contracts (2) | Connect raw JSON to a rendered interface | Every API requires a live server | learner reveals imported JSON |
| Gate | Evaluate reproducibility (5) | Run invariants and interpret proof | A visual alone proves a mechanic works | learner runs three rites; computed verdicts pass |
| Forge | Create a civilization contract (6) | Author identity, symbol, era, and place; publish a portable and durable world | Custom worlds either require a backend or cannot be revisited | 4/4 rubric, Database ID, immutable export, URL fallback, and profile consumed by the real FPS |

Prerequisite chain:

```text
seed/determinism → land/parameters → people/time → ledger/data shape → gate/reproducibility
→ forge/authorship → live game/near transfer
```

## Cognitive load

Each mission asks for one primary behavior and puts its proof beside the controls. Narrative follows
the mission, so the learner can act before reading the deeper explanation. Land is intentionally the
heaviest problem because it combines three constraints.

Estimated total load: Seed 0.45, Land 0.72, People 0.58, Ledger 0.40, Gate 0.62, Forge 0.68.
All are below the 0.90 intervention threshold.

## Gagné alignment

| Event | Claude baseline (`1097016`) | Current first loop |
|---|---|---|
| Gain attention | Strong worldbuilding and visuals | Preserved |
| Inform objectives | Chapter theme only | Observable objective and proof |
| Stimulate prior knowledge | Implicit | Still weak; add an entry diagnostic |
| Present content | Strong narrative | Preserved |
| Provide guidance | Control labels | Mission task plus constraint feedback |
| Elicit performance | Optional interaction | Required world-changing action |
| Provide feedback | Demo readouts only | Mission-specific immediate feedback |
| Assess performance | None | Deterministic evaluator per chapter |
| Enhance transfer | Links to source/game | Near transfer now requires an authored world in the real game; learner-owned deployment remains |

## Provisional quality score

This scores the design, not learner outcomes.

| Dimension | Score | Evidence / gap |
|---|---:|---|
| Objective clarity | 0.90 | six observable objectives and proof conditions |
| Prerequisite validity | 0.90 | linear dependency chain |
| Cognitive load balance | 0.84 | bounded missions; land intentionally heavier |
| Assessment alignment | 0.92 | every objective has machine-readable evidence |
| Transfer potential | 0.82 | authored durable/portable world reaches the real game; independent deployment remains unproven |
| Dignity preservation | 0.88 | specific, actionable, non-punitive feedback |
| **Weighted composite** | **0.88** | passes the 0.70 design threshold |

Deployment decision: usable as an instrumented first learning loop with monitoring. It is not yet
evidence of learning transfer.

## Completion evidence — 2026-07-29

The platform implementation is complete at all three operational layers:

- **Local:** Netlify Dev booted Vite and the `worlds.mts` Function at
  `127.0.0.1:8888`; the repository migration applied from a clean local
  Postgres-compatible database; Netlify Blobs reported sandbox mode. Contract
  tests passed 4/4, Function↔Database/Blob integration passed 3/3, all 271
  boundary checks passed, and Forge→publish→stable ID→actual game plus forced
  API-outage fallback passed.
- **Staging:** [ironsight-staging.netlify.app](https://ironsight-staging.netlify.app)
  is Git-connected to the `staging` branch with its own Database and Blob
  scope. Netlify applied the migration before publish. `/`, `/learn/`,
  `/forge/`, POST/GET world publication, immutable assets, revalidated HTML,
  stable-ID game boot, and complete-URL fallback passed. The deployed teaching
  smoke carried 4/4 authored meanings into the real game and mechanically proved
  movement, fire, and damage (15.0 m, 4 shots, 1 hit).
- **Production:** [ironsight-958.netlify.app](https://ironsight-958.netlify.app)
  is Git-connected to `main`, with a separate Database/Blob scope and production
  Deploy Previews blocked. The exact revision promoted from staging passed the
  same migration and deployed browser smoke. Its disposable `CANARY` world was
  created and read through the Function; the first slice intentionally has no
  broad destructive cleanup endpoint. Browser page/console/HTTP error
  collection was empty. A prior ready deploy still returns HTTP 200, proving a
  publish rollback candidate exists; schema rollback remains forward-only and
  backwards-compatible as documented in the runbook.

Account cost controls remained explicit: credit-based Pro, 3,000-credit cycle,
auto-recharge off, two isolated databases at 1–2 compute units with five-minute
sleep, and no credentials or project IDs committed. A dashboard credit alert is
still a human account-setting task because no safe supported CLI/API control was
available.

This is release evidence for the software and instructional instrument. It is
not evidence that a human learner completed the named-place navigation mission,
explained the concepts later, or transferred them independently; those claims
still require moderated human/video evidence.

## Highest-value next work

1. Add a two-question entry diagnostic and adapt guidance without locking content.
2. Extend the completed forge quest into far transfer: fork, edit source, and deploy a learner-owned
   static civilization.
3. Iterate the `/?teach=1` live field lab and prove the named-place
   mission with a human route rather than a teleport hook.
4. Run five moderated learner sessions and measure time-to-first-action, completion, concept
   explanation, and delayed transfer.
5. A/B mission-first ordering against Claude's demo-first ordering.
