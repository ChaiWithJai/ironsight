Every civilization keeps a ledger — the record of its eras, written so that strangers far away can
read the same history. Below is the ledger of Harbour Reach. It looks like a document. It *is* a
document. That is the point.

## The teaching

This chapter is the **A** in JAM — and the most misunderstood letter. "APIs" does not have to mean
a server answering questions at 3 a.m. An API is an *agreement about the shape of data*. The
ledger below is a plain JSON file in the repository, and it reached your eyes without any server
computing anything:

```
src/learn/chronicle.json  --import-->  the JavaScript bundle  --CDN-->  you
        (build time)                       (deploy time)        (request time)
```

The `import` happened **at build time** — when this site was compiled, the ledger was folded into
the bundle like a fossil into rock. Toggle "show the raw ledger" and you are looking at the actual
object your browser holds in memory: same shape a server would have sent, no server anywhere.

This is the JAMStack's quiet superpower, and IRONSIGHT is its extreme case: the game makes **zero
network requests at runtime**. Weapon tables, surface hardness, bot personalities — all of it is
data with the shape of an API response, resolved before the first frame. When you do need fresher
data than build time, the same discipline holds: publish JSON as *static files* on the CDN and let
clients fetch documents, not run queries. The grandest version of that idea is a public data
commons — datasets published as plain, versioned, cacheable files that anyone can build a client
for. (That is the DharmicData thesis: knowledge as static, verifiable artifacts.)

- **Runtime API** — a chef who cooks when you order. Powerful; must be staffed forever.
- **Build-time API** — a chef who cooks at dawn and lays the table. The JAMStack default.
- **The dark pattern** — a server that renders the same page for every visitor, forever, on
  demand. That is paying a chef to microwave the same meal.

## Lift the curtain

- The ledger itself: `src/learn/chronicle.json` — and the one line that swallows it:
  `import chronicle from '../chronicle.json'`.
- The repo-wide law it lives under: the boundary CI bans `fetch(` from the entire source tree, so
  "zero requests at runtime" is not a hope — it is a rule a machine checks on every build.
