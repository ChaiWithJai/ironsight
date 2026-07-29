# IRONSIGHT Performance & Capacity Matrix

This document records the environment and capacity support matrix for IRONSIGHT across different workloads: repository setup, CI/build, local development, API, and browser runtime.

**Status:** Provisional guidance based on a single baseline machine (2026-07-29). These are starting guardrails, not yet validated SLOs across device populations.

---

## Tested Baseline Machine

- **CPU:** Apple M4 Pro, 12 logical CPUs, 3.5–4.0 GiB
- **RAM:** 24 GiB system memory
- **OS:** macOS 26.5 (arm64)
- **Storage:** NVMe SSD
- **Node:** 22.23.1
- **Browsers:** Chrome 151 (interactive + headless/SwiftShaker), Safari (documented as slower)
- **Profiled Commit:** `382ebabe684b18171e2d2b04a0dff51614c63891`

---

## Environment Support Matrix

### Validated (Tested on Baseline)

| Dimension | Tested | Notes |
|-----------|--------|-------|
| **OS** | macOS arm64 (M4 Pro) | Primary development target; Linux x64 validation pending |
| **Browser** | Chrome 151 | Interactive (Apple Metal) and headless (SwiftShaker) paths tested |
| **GPU** | Apple Metal (M4), Software (SwiftShaker) | Hardware rendering strongly preferred; software path viable for CI |
| **CPU Cores** | 12 logical (M-class) | Sufficient for all local workloads; minimum thresholds TBD per OS |
| **System RAM** | 24 GiB | Peak RSS observed ~650 MiB for Netlify stack |

### Provisional Guidance (Not Yet Tested)

| Target | CPUs | RAM | Notes | Status |
|--------|------|-----|-------|--------|
| **CI/build only** | 2 vCPU | 2 GiB | `npm ci` + `npm run build` | Untested; based on observed ~381 MiB peak install, ~626 MiB build |
| **Full local Netlify stack** | 4+ logical | 8 GiB system | Includes CLI, Vite dev server, emulated DB/Blob | Untested; observed ~693 MiB combined steady-state |
| **Browser acceptance (full game, headless)** | 4+ logical | 4 GiB free | WebGL2 required; hardware GPU recommended; software rendering needs 120 s ready budget | Untested; baseline headless took 87.46 s with SwiftShaker |
| **End-client (player)** | Any modern system | 2 GiB free | Desktop browser, keyboard/mouse, pointer lock | Untested; desktop/laptop only; mobile not validated |

### Out-of-Scope (No Planned Support)

| Target | Rationale |
|--------|-----------|
| **Mobile/touch input** | Pointer lock, keyboard controls, WebGL pipeline not designed for touch; no mobile game UI |
| **Low-memory systems (<2 GiB)** | Game heap measured ~342 MiB cold; streaming/loader infrastructure not implemented |
| **Safari (player)** | Documented as slower in initial profiling; not primary target; bugs not prioritized unless blocking 90%+ market |
| **IE11 or ES5 targets** | Requires Rapier, Three.js, and Vite ecosystem not available |

---

## Capacity Matrix by Workload

### Repository & Dependencies

| Workload | Wall Time | Peak RSS | Disk | Notes |
|----------|-----------|----------|------|-------|
| Fresh `git clone` (depth 1) | N/A | N/A | 8.7 MiB total (2.6 MiB `.git`) | 355 source files excl. deps |
| `npm ci --ignore-scripts` | 1.74 s | 381 MiB | 189 MiB `node_modules` / 8,705 files | 108 packages; lock graph: 158 entries |

### Build & Verify

| Workload | Wall Time | Peak RSS | Notes |
|----------|-----------|----------|-------|
| `npm run build` (Vite) | 2.80 s | 626 MiB | 1.77 s Vite time; 284 transformed modules; output 4.5 MiB |
| `npm run verify` (types + checks + tests) | 6.97 s | 611 MiB | 271 boundary checks; 7 tests; includes full build |
| Local migration (one repository operation) | 2.12 s | 241 MiB | IndexedDB bake cold-start; not CI-bound |

### Local Development (Netlify Dev)

| Workload | Wall Time | Peak RSS | Notes |
|----------|-----------|----------|-------|
| Session ready (observed) | ~6 s | 647 MiB (Netlify CLI) | Combined ~693 MiB CLI + Vite steady-state |
| Vite alone (hot reload capable) | ~176 ms | Per Vite docs | Included in above |

### Production Artifacts

| Asset | Raw Size | Compressed (observed) | Notes |
|-------|----------|----------------------|-------|
| `main-*.js` | 3.86 MiB | 1.40 MiB (gzip) | Primary game bundle |
| `three-*.js` | 584 KiB | 148 KiB | Three.js dependency |
| `learn-*.js` | 37 KiB | 15.1 KiB | Academy module (lazy-loaded) |
| `forge-*.js` | 6.0 KiB | 2.4 KiB | Forge module (lazy-loaded) |
| `og.jpg` | 166 KiB | Not loaded by game | Social preview only |

Game navigation loaded 5 resources: ~1.45 MiB transferred / 4.45 MiB decoded total.

### End-Client Game Runtime

#### Interactive Chrome (M4 Pro, Apple Metal, Quality: ULTRA)

| Metric | Measured |
|--------|----------|
| **Ready time (first boot to `[boot] ready`)** | ~15 s |
| **Geometry attachments** | 241/244 destructible (active) |
| **Batch draws** | 11 |
| **Triangles** | 52,859 (from merged streams) |
| **Shader permutations** | 48/192 allocated at boot |
| **Console errors** | 0 |
| **Warnings** | 4 (deprecated init call, 3 collider-only cranes, `sidearm` fallback) |

#### Headless Chrome (SwiftShader, Tier: HIGH, Standard Bake, Zero Workers)

| Metric | Measured |
|--------|----------|
| **Navigation load** | 2.57 s |
| **First Contentful Paint (FCP)** | 3.62 s |
| **Ready time** | 87.46 s |
| **Peak JS heap** | 342 MiB |
| **Frame time (120-frame sample, offscreen)** | 8.3 ms median / 9.7 ms p95 / 10.3 ms max |
| **Failed HTTP responses** | 0 |
| **Console errors** | 0 |

**Note:** Headless/SwiftShader timing is directional only—software rendering is not representative of visible-client FPS. The 15 s (hardware) vs 87 s (software) spread highlights that procedural bake (not HTML/asset delivery) dominates time-to-game.

### API Baseline (Staging & Production)

| Path | Latency | Notes |
|------|---------|-------|
| Local world POST | 146 ms | Zero-distance reference |
| Local world GET | 96–110 ms | Warm cache |
| Staging world POST (DB + Blob export) | 1.15 s | Includes immutable Blob export |
| Staging world GET (first) | 205 ms | Cold |
| Staging world GET (warm) | 76–84 ms | Cache hit |
| Production invalid-ID Function (initial) | 1.03 s | Cold start |
| Production invalid-ID Function (warm) | 152–248 ms | Subsequent calls |
| Production HTML TTFB | 147–218 ms | Sampled; revalidate header set |
| Production `main-*.js` TTFB (warm) | 89–121 ms | Hashed assets cached 1 year |
| Production `main-*.js` transfer | 0.78–1.95 s | For 1.40 MiB compressed; connection-dependent |

---

## Current Machine/Runtime Contract

IRONSIGHT requires:

- **Node 22** for build and deployment
- **WebGL2** for the game (validated on hardware metal and software rendering)
- **IndexedDB** for serializable bake job state
- **OfflineAudioContext** during bake initialization
- **Lazy AudioContext** after user interaction
- **Pointer lock** for mouse-based play
- **Optional gamepad input** (standard mapping)

Quality automatically degrades based on:
- WebGL capability detection
- Renderer class (hardware vs. software)
- GPU texture limits
- Chromium `deviceMemory` (when available)

---

## Provisional Performance Budgets

These are starting guardrails pending device-matrix validation. Replace with measured p75/p95 values once you have cross-device data.

| Budget | Target | Notes |
|--------|--------|-------|
| `/learn/` + `/forge/` FCP (p75) | ≤ 1.5 s | Route-specific JS regression max 10% |
| Warm API GET (p95) | ≤ 250 ms | Excludes intentional 4xx |
| Cold/sleeping API (p95) | ≤ 1.5 s | Includes cold-start and wake overhead |
| API error rate | < 1% | Excluding intentional 4xx |
| Game ready (cold, hardware, p75) | ≤ 25 s | Baseline: 15 s on M4 Pro |
| Game ready (warm cache, p75) | ≤ 10 s | Not yet measured |
| Game ready (headless/software, p75) | ≤ 120 s | Baseline: 87.46 s on M4 Pro with SwiftShaker |
| Post-ready JS heap | ≤ 512 MiB | Baseline: 342 MiB headless |
| Sustained heap growth (30-min soak) | None | No leaks detected in baseline run |
| Build wall time | < 60 s | Baseline: 2.80 s Vite on M4 Pro |
| Build peak RSS | < 2 GiB | Baseline: 626 MiB on M4 Pro |

---

## Validation Roadmap

### Near Term (Required Before Capacity Guarantees)

- [ ] **Linux x64 CI:** Test `npm ci` and `npm run build` on 2/4/8 vCPUs and 2/4 GiB RAM
- [ ] **macOS x64:** Validate on Intel x64 hardware (not just arm64)
- [ ] **Browser coverage:** Test Chrome, Edge, Firefox, Safari across discrete GPU, integrated GPU, and Apple Silicon
- [ ] **Headless automation:** Measure cold vs. warm bake separately; validate SwiftShaker assumptions
- [ ] **API load testing:** Run staging concurrency tests with synthetic data only; verify rate limiting and Blob throughput

### Medium Term (SLO Credibility)

- [ ] **30-minute soak tests:** Capture JS heap, GC, frame-time distribution, and leak detection across devices
- [ ] **Cold/warm IndexedDB bake:** Separate cache-hit and cache-miss timings
- [ ] **Per-step bake profiling:** Reduce critical-path work, serialization, readbacks, and shader compilation stalls
- [ ] **Navigation Timing + Core Web Vitals:** Measure p75/p95 for `/learn/` and `/forge/` across regions
- [ ] **Production observability:** Tile staging/production comparisons to exact commits; publish per-release artifacts

### Long Term (Support Matrix Completion)

- [ ] **Mobile assessment:** Decide touch/responsive policy; test if prioritizing (or explicitly deprioritizing)
- [ ] **Accessibility + viewport matrix:** Define supported viewport/input combinations; document fallbacks
- [ ] **Database SLOs:** Establish alarms and dashboards; verify 1–2 compute units for Netlify Database
- [ ] **Cost transparency:** Monitor Blob export throughput and function costs before raising auto-recharge

---

## Known Limitations

1. **Single baseline machine:** M4 Pro may not represent Intel, AMD, or integrated GPU behavior
2. **Network sampling:** Observed latencies are single-location samples, not geographically distributed p95s
3. **No mobile validation:** Touch, viewport, accessibility, and responsive design not yet tested
4. **Headless FPS directional only:** Software-rendered frame times do not predict visible-client performance
5. **Staging-only data:** No production gameplay soak or learner-scale API testing yet
6. **No cost/compute profiling:** Netlify Database and Blob storage costs not tracked per workload
7. **Safari partially documented:** Documented as slower but not actively debugged or optimized

---

## How to Measure Locally

See [issue #2](https://github.com/ChaiWithJai/ironsight/issues/2) for the full profiling method. Quick start:

```bash
# Build and verify (includes types, checks, tests)
npm run verify

# Profile install + build
time npm ci --ignore-scripts && time npm run build

# Start local stack
netlify dev

# Headless game ready (SwiftShaker)
npm run test:headless

# Interactive debugging
npm run dev  # Vite dev server
# Open http://localhost:5173 in Chrome with DevTools Performance tab
```

---

## References

- [Issue #2: Performance Baseline & Capacity Guidance](https://github.com/ChaiWithJai/ironsight/issues/2)
- [Proposed SLO Budgets](https://github.com/ChaiWithJai/ironsight/issues/2#proposed-performance-budgets-to-ratify-with-device-data)
- Production: https://ironsight-958.netlify.app
- Staging: https://ironsight-staging.netlify.app
