# PRIVACY.md — data classification, consent, and education-safety policy

**Owner:** Jai Bhagat · DharmicData.org
**Applies to:** the IRONSIGHT teaching platform (`/learn/`, `/forge/`, the live-field teaching
overlay, and the Netlify Functions + Database + Blobs persistence slice).
**Status:** policy of record. It must be true *before* the first human learner evidence is
collected (issue #3, "P0 — production operations, security, and governance"). Where a policy
implies code that does not exist yet, it is called out as a **follow-up** in §9 rather than
claimed as shipped.

Companion document: retention periods and the export/deletion mechanics live in
[`docs/DATA_RETENTION.md`](./DATA_RETENTION.md).

---

## 1. Design stance (the short version)

IRONSIGHT is an **anonymous-first educational product**. The whole architecture is built to make
data minimal by construction, and this policy keeps it that way. Five commitments govern every
decision below:

1. **Anonymous-first.** No account, no email, no name, no login is required to enter a world,
   complete missions, or publish a civilization. The only identifier is a server-issued opaque
   UUID (§3).
2. **Minimal collection.** We store only what the learner authored and the evidence needed to
   assess and durably return their own learning. We do not collect what we do not need.
3. **No tracking, no ads, no third-party sale or sharing.** There is exactly one cookie and it is
   strictly functional (§4). No analytics SDK, no advertising identifiers, no data brokers.
4. **Short retention with explicit export and delete.** Everything expires on a schedule
   ([`DATA_RETENTION.md`](./DATA_RETENTION.md)); a learner can export or delete their own data.
5. **Safe for education and for minors by posture, not by promise.** Because the collection
   surface is already tiny and pseudonymous, the platform can satisfy COPPA / FERPA / GDPR-K
   expectations largely by *not collecting* the things those regimes protect (§7).

The engine invariants make this cheap to honor: zero runtime network requests in the game bundle,
build-time data, and a portable `WorldProfile` that already round-trips entirely through a URL. A
learner who never touches the durable API leaves **no server-side record at all** — the URL
fallback is the privacy-preserving default.

---

## 2. What the product actually stores

This inventory is derived from the real schema
(`netlify/database/migrations/20260729134500_teaching_platform.sql`), the worlds Function
(`netlify/functions/worlds.mts`), and the `WorldProfile` contract
(`src/engine/world-profile.ts`). It is authoritative; keep it in sync when the schema changes.

### 2.1 Server-side (Netlify Database — Postgres)

| Store | Fields | What it is |
|---|---|---|
| `anonymous_learners` | `id` (UUID), `created_at`, `last_seen_at` | The pseudonymous identity. No name, email, IP, or device fingerprint is stored in this row. |
| `worlds` | `profile` (JSONB), `civilization`, `sigil`, `era`, `alpha_name`, `bravo_name`, `charlie_name`, `artifact_blob_key`, `creator_id`, `created_at` | The learner-authored civilization. All human-meaningful fields are **learner free text**. |
| `course_runs` | `learner_id`, `world_id`, `course_version`, `status`, `started_at`, `completed_at` | Progress through the academy. Timestamps + status only. |
| `mission_attempts` | `run_id`, `mission_id`, `attempt_number`, `evidence` (JSONB), `passed`, `artifact_blob_key` | Assessment record. `evidence` is machine-generated (seeds, tick counts, control paths). |
| `reflections` | `run_id`, `prompt_id`, `response` (free text), `rubric` (JSONB) | Learner-written explanations. **Highest-sensitivity field** — see §5. |
| `publications` | `world_id`, `learner_id`, `stable_path`, `deploy_url`, `status` | The public, intentional publication of a world to a stable URL. |

### 2.2 Blobs (immutable)

Immutable artifact exports keyed from the `artifact_blob_key` columns: the world export JSON and,
once the P0 evidence items land, replay JSON and screenshots for mission attempts. Blobs are
**append-only and immutable** by design — deletion is a scoped delete of the key, never an
in-place edit.

### 2.3 Client-side (the learner's own browser)

| Store | Contents |
|---|---|
| One functional cookie | `ironsight_learner` = the learner UUID (§4). |
| `localStorage` | Academy / live-field progress before durable sync. Never leaves the device unless the learner publishes. Cleared by clearing site data. |
| The URL | A complete `WorldProfile` is encodable in `URLSearchParams`. This is state the learner holds and shares deliberately. |

### 2.4 What we deliberately do **not** collect

No name, email, phone, mailing address, date of birth, age, gender, school name, government ID,
photo, precise geolocation, IP address stored to a learner record, device fingerprint,
cross-site identifier, biometric data, or payment data. No third-party analytics, advertising,
social, or session-replay scripts. IP addresses are visible transiently to the platform/CDN for
rate limiting and abuse defense (§4) but are **not written to a learner record**.

---

## 3. Data classification

Every field above is assigned one class. Handling rules follow the class.

| Class | Definition | Fields | Handling |
|---|---|---|---|
| **C0 — Public by intent** | The learner deliberately made this public. | `publications.stable_path`, `deploy_url`, and the `worlds` row backing a published world. | Servable publicly. Still deletable/withdrawable (§6). |
| **C1 — Pseudonymous identifier** | Links records to one anonymous learner; not identifying on its own. | `anonymous_learners.id` and every `*_id` / `learner_id` / `creator_id` foreign key; the cookie value. | Never exposed to other learners. Never joined to any external identity. |
| **C2 — Learner-authored free text** | Human-written, low-structure, and therefore *capable of containing* PII the learner chose to type. | `worlds.civilization/sigil/era/*_name` and `profile`; `reflections.response`. | Size-limited; not sent to any third-party processor; treated as potentially sensitive; covered by export and delete. |
| **C3 — Machine-generated evidence** | Deterministic assessment artifacts. Low intrinsic sensitivity but tied to a learner via C1. | `mission_attempts.evidence`, `passed`; `course_runs` status/timestamps; Blob replay/screenshots. | Retained on the assessment schedule; exportable; deleted with the learner. |
| **C4 — Operational / transient** | Needed to run and defend the service; not a learner record. | Request IP + user agent in ephemeral platform logs; rate-limit counters; error logs. | Short-lived, privacy-scrubbed, never joined back to C1. See §8. |

**The rule for C2:** because free-text fields can contain anything a learner types, we (a) cap
their length at the Function boundary, (b) never route them to a third-party model or analytics
service, (c) surface a plain-language notice at the point of entry that says "don't put your real
name, email, or anything private here — this may be published," and (d) include them in both
export and deletion. This is the honest way to handle fields we cannot fully control.

---

## 4. Cookies and the single functional identifier

There is **one** cookie:

```
ironsight_learner = <learner UUID>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure
```

- **Purpose:** strictly functional — it lets a returning learner find the worlds and runs they
  created. It is *not* an analytics or advertising cookie, so it does not require a consent banner
  under ePrivacy/GDPR; it is the "strictly necessary" class.
- **Properties:** `HttpOnly` (not readable by page scripts), `SameSite=Lax` (CSRF resistance),
  `Secure` on HTTPS, opaque UUID value (no embedded data), one-year max age.
- **Server-issued.** The value is a random v4 UUID minted by the Function on first publish; the
  learner supplies nothing.
- **IP addresses** are seen transiently by the CDN/Function for the declared rate limit
  (`aggregateBy: ['domain','ip']`, 12 requests / 60 s) and platform abuse defense. They are **not
  persisted to a learner record** and are C4 operational data (§8).

Loss of the cookie means loss of continuity, by design: there is no recovery mechanism that could
re-link an anonymous learner, because we hold nothing else about them. This is a deliberate
privacy/robustness trade documented for issue #3 "Identity and continuity."

---

## 5. Consent and notice

Because collection is minimal, functional-only, and anonymous, consent is handled by **notice +
affirmative action**, not a cookie wall:

1. **Zero-collection default.** Playing, learning, and building a world touches no server. A
   learner can complete the entire academy and carry their world in the URL without ever creating
   a server record. Nothing to consent to because nothing is collected.
2. **Consent at the point of persistence.** The first action that writes durable data — publishing
   a world, or (once shipped) starting a synced course run — is the consent moment. Before that
   action, the UI must present a short, plain-language notice: what is stored, that it is
   anonymous, that free-text may become public, how long it is kept, and how to export or delete
   it. Proceeding is the affirmative act. *(Follow-up: this notice gate is not yet implemented —
   §9.)*
3. **Point-of-entry warnings on C2 fields** (§3) so a learner never types a real name or email
   into a field that may be published.
4. **No dark patterns.** Decline is always as easy as accept: declining simply keeps the learner
   on the URL-only path with full functionality.
5. **Research/study consent is separate and explicit.** The moderated learner sessions and
   recall/transfer measurements in issue #3 ("Prove learning") require their own written, informed
   consent (and, for minors, guardian/school consent per §7) obtained out-of-band. Automated
   screenshots are software evidence, not human-subject data; observing a human is.

---

## 6. Learner rights: access, export, and deletion

Every learner may, scoped to their own `ironsight_learner` cookie:

- **Access / export** a machine-readable (JSON) bundle of everything tied to their learner UUID:
  their worlds, course runs, mission attempts, reflections, publications, and references to their
  Blob artifacts.
- **Delete** all of the above. Deletion removes the learner row and cascades to their runs,
  attempts, and reflections, and scoped-deletes their Blob artifacts.
- **Withdraw a publication.** Because a publication is a *stable public URL* that others may have
  linked, withdrawal moves it to `status = 'withdrawn'` and stops serving the content while
  preserving the URL's non-existence semantics (a clean "withdrawn" state, not a dangling link).
  The learner-authored C2 content behind a withdrawn publication is purged, not merely hidden.

The stable-URL contract and the right-to-delete are reconciled as: **the URL may persist as a
tombstone, but the learner's C2/C3 data behind it does not.** Deleting data never silently breaks
someone else's bookmark into a confusing state; it resolves to an explicit withdrawn response.

The concrete request paths, response shapes, and the retention/purge schedule are specified in
[`docs/DATA_RETENTION.md`](./DATA_RETENTION.md). The endpoints themselves are a **follow-up**
(§9) — today the platform is create/read only.

---

## 7. Children and education-safety policy

IRONSIGHT is a general-audience educational tool that is **not directed at children under 13** and
does not knowingly collect personal information from them. Because it is nonetheless likely to be
used in classrooms and by minors, it adopts a protective posture aligned with **COPPA (US),
FERPA (US), and GDPR "GDPR-K" Article 8 (EU)** — and satisfies most of it structurally:

- **No age or identity collection.** We never ask for age, birth date, name, email, or school. We
  therefore do not build behavioral profiles of anyone, minor or adult.
- **No behavioral advertising, ever.** No ad networks, no third-party trackers, no data sale or
  sharing. This is the single largest COPPA/education risk and the platform simply does not have
  the surface.
- **Data minimization as the compliance mechanism.** The only learner data is a pseudonymous UUID
  plus learner-authored educational content and machine assessment evidence. There is no PII to
  mishandle unless a learner types it into a C2 field — which the §3/§5 warnings and length caps
  actively discourage.
- **School / teacher as controller in cohort use.** When a school or teacher deploys IRONSIGHT to
  a class, the school is the data controller and may consent on students' behalf under COPPA's
  school-consent exception and FERPA's school-official framework. In that mode: no direct-to-child
  PII collection, no disclosure of student content outside the cohort, teacher/admin views are
  authorization-gated server-side, and staging/preview environments never read production learner
  data (already the operational rule — `docs/NETLIFY_RUNBOOK.md`).
- **Free-text moderation and safety.** C2 fields are length-capped and must be covered by an abuse
  / harmful-content policy before any public discoverability feature ships (issue #3, "Publication
  lifecycle" — discoverability and moderation are explicitly undecided; **default private** until
  decided).
- **If a request to collect PII from a known child arrives, the answer is no** — the product is
  designed so that verifiable parental consent is never required because child PII is never
  collected. If a future feature would change that, it must not ship until COPPA verifiable
  parental consent (or the school-consent exception) is implemented and documented here.
- **Deletion on request** is available to a learner, a guardian, or a school administrator acting
  for a student, via the mechanisms in §6.

**Bright line:** no feature may introduce collection of a minor's directly identifying
information, cross-site tracking, or third-party ad/analytics tags. Any change that would is a
policy change requiring an explicit ADR and an update to this document, not a code review comment.

---

## 8. Operational data, logs, and security

- **Logs (C4).** Function and platform logs may transiently contain IP, user agent, and request
  metadata for debugging, rate limiting, and abuse defense. They are short-lived, are not joined
  to learner records, and must be privacy-scrubbed before appearing in any dashboard (issue #3,
  "privacy-safe dashboards"). No C2 free text is logged.
- **Environment isolation.** Local, staging, and production use separate databases and Blob
  scopes; no preview or staging environment may read or copy production learner data
  (`docs/NETLIFY_RUNBOOK.md`). This is a privacy control, not only an ops convenience.
- **No secrets or learner records in the repo.** Per the runbook, tokens, connection strings, and
  learner data never enter source control.
- **Transport & storage.** All durable traffic is HTTPS; the session cookie is `Secure` +
  `HttpOnly`; responses carrying learner data use `cache-control: private, no-store`
  (already enforced in `worlds.mts`).
- **Security contact.** A documented security/privacy contact and the CSP / Referrer-Policy /
  Permissions-Policy headers are tracked under issue #3 "production operations, security, and
  governance." This document names privacy@dharmicdata.org as the intended intake address once
  confirmed; update on confirmation.

---

## 9. Follow-up code work (noted, not built here)

This is a docs deliverable. The following concrete changes are required to make every policy above
fully operational. Each maps to an existing issue #3 checkbox; none is invented scope.

1. **Learner export endpoint** — cookie-scoped `GET` returning the JSON bundle in §6.
   *(issue #3: "Add learner export/download for their world, run, evidence, and reflections.")*
2. **Learner deletion + publication withdraw endpoints** — cookie-scoped delete with cascade and
   Blob scoped-delete; `withdraw` transition on `publications`.
   *(issue #3: "Add withdraw/unpublish and exact-target deletion/retention workflows with audit
   records.")*
3. **Consent/notice gate** before the first durable write, and point-of-entry warnings on C2
   fields. *(issue #3: "consent behavior"; "privacy … policies before collecting evidence.")*
4. **Retention purge job** — a scheduled Function enforcing the schedule in
   `DATA_RETENTION.md`. *(issue #3: "retention workflows"; see also "safe disposal of
   staging/canary/test records.")*
5. **C2 content limits + moderation policy** wired before any public discoverability.
   *(issue #3: "moderation, abuse reporting, public/private defaults.")*
6. **Privacy-scrubbed observability** for logs/dashboards. *(issue #3: "privacy-safe dashboards.")*

Until these ship, the platform must remain in its current create/read, publish-only posture, and
**must not begin collecting moderated-session human evidence**, because the export/delete/consent
guarantees this policy makes are not yet enforceable in code.

---

## 10. Change control

This document and `docs/DATA_RETENTION.md` are the privacy policy of record. Any change to the
data inventory (§2), the classification (§3), the single-cookie rule (§4), or the children policy
(§7) requires an ADR under `docs/adr/` and a matching edit here in the same change. When the
schema in `netlify/database/migrations/` changes, §2 must change with it in the same pull request.
