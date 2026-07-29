# ADR 0002: Privacy-safe observability for the teaching Functions

- Status: accepted
- Date: 2026-07-29
- Decision owner: Jai Bhagat

## Context

The teaching platform is a small Netlify project: two Function surfaces
(`POST /api/worlds`, `GET /api/worlds/:id`) plus a managed Postgres and an
immutable Blob store (ADR 0001). Issue #3 asks, under "production operations",
for "structured logs, error monitoring, latency/error SLOs, request
correlation, migration observability, and privacy-safe dashboards".

Before this change the Functions logged with ad-hoc `console.error` /
`console.warn` prefixed strings. That is unparseable, has no request
correlation, and — because the same code paths handle authored world text and
an anonymous learner cookie — is one careless interpolation away from writing
PII into a log the operator does not control the retention of.

Three tensions drove the decision:

1. **PII vs. usefulness.** We collect an anonymous `HttpOnly` learner cookie and
   store learner-authored civilization text. Neither belongs in logs, yet we
   still need to correlate a learner's requests to debug a broken publish.
2. **External APM vs. platform-native.** A dashboard product (Datadog, Sentry,
   Logtail) is more capable, but adds a dependency, a second data processor to
   put in the privacy policy, and an egress path for data we are trying to keep
   minimal — disproportionate for two endpoints on a credit-limited account
   with auto-recharge off.
3. **Migrations apply outside the app.** Netlify runs `netlify/database/
   migrations/*` immediately before publish (see NETLIFY_RUNBOOK). A deploy can
   therefore go green while the schema the code expects does not exist, and
   nothing in the request path would notice until the first 503.

## Decision

**Structured JSON logs to stdout/stderr, correlated by request id, read through
Netlify's own function logs and Analytics. No external APM in this slice.**

### Structured logging (`netlify/functions/lib/log.mts`)

- One JSON object per line: `ts`, `level`, `event`, `requestId`, `service`, and
  event-specific fields. Netlify's log viewer and any future log drain parse it
  without a custom rule.
- **PII is designed out.** A `sanitize` backstop redacts known-sensitive keys
  (`cookie`, `authorization`, `ip`, `profile`, `body`, …) at any depth, reduces
  `Error` to `{name, message}` (no stack, which can carry paths), truncates
  oversize strings, and caps depth/array width. Callers additionally never hand
  the logger a cookie, an IP, or authored world text.
- **Learner identity is pseudonymous.** The anonymous learner id is only ever
  logged as `pseudonym()` — a truncated SHA-256 — so two lines can be tied to
  the same learner within a retention window without the raw id ever being
  written.

### Request correlation (`requestIdFrom`)

Every request gets one id: reuse the platform/caller id (`x-nf-request-id`,
`x-request-id`, `x-correlation-id`) when it is well-formed, else mint a UUID.
Untrusted header values are shape-checked so a client cannot inject newlines or
megabytes into the logs. The id threads through the handler and the repository
(so a DB timing line shares the request's id) and is echoed back in the
`x-request-id` response header, tying a browser-side failure to a server line.

### Metrics, latency, and error SLOs

- Each request emits exactly one `request.complete` line carrying `status`,
  `outcome`, and `durationMs`; each DB and Blob operation emits a timed
  `db.*` / `blob.*` line. That is enough to compute latency percentiles and
  error rate by filtering structured logs — no separate metrics pipeline.
- **SLO (initial, revisit with real traffic):** `GET /api/worlds/:id` p95
  < 400 ms and 5xx rate < 1% rolling 24 h; `POST /api/worlds` p95 < 1200 ms
  (it does a Blob write + two DB statements). Breach is investigated from the
  `request.complete` / `db.*` lines for the offending `requestId`.
- **Dashboards:** Netlify function logs (structured, filterable by `event`,
  `requestId`, `outcome`) for behaviour, and Netlify Analytics (server-side,
  cookieless) for traffic and status-code mix. Both are privacy-safe by
  construction: server-side, no third-party processor, no PII in the payload.

### Migration observability (`lib/migrations.mts` + `health.mts`)

`GET /api/health` diffs the tables the code depends on against
`information_schema` and returns `200 ok` / `503 degraded`, naming any missing
tables and the latest migration the build was authored against. It reads no
learner data. It emits `health.check` every call and escalates to
`migration.degraded` when the schema is incomplete — turning the silent
"published but not migrated" failure into a probe the release gate and uptime
monitor can assert on.

## Consequences

- Observability ships with zero new runtime dependencies and no new data
  processor to disclose.
- Operators read behaviour from the Netlify function log (structured) and
  traffic from Netlify Analytics; `GET /api/health` is the post-deploy and
  uptime assertion.
- If traffic later justifies real percentile dashboards or alerting, the
  structured lines are already log-drain-ready — point a drain at a sink and
  build views there, without touching Function code.
- This ADR does not touch billing or auto-recharge (ADR 0001 stands): the
  manual credit alert remains the cost guardrail.
