# ADR 0001: Full-stack Netlify teaching platform

- Status: accepted
- Date: 2026-07-29
- Decision owner: Jai Bhagat

## Context

IRONSIGHT already has a complete browser-native game and a URL-encoded
`WorldProfile`. The teaching transfer is stronger when a learner can create,
publish, revisit, and explain a civilization. Persistence must enhance that
experience without making a backend a prerequisite for entering the world.

The corrected historical “before” point is commit
`309d71d3fff96159fb4005ca598f337bb9f36b98`. It is the sole parent of the
original academy change. This decision does not rewrite that history.

The authenticated, read-only account check on 2026-07-29 established that the
owner account is on active credit-based Pro with 3,000 credits per billing
cycle, auto-recharge off, and Database eligibility. The repository was not
linked to Netlify, and no existing site name or repository attachment contained
`ironsight`.

## Decision

Netlify is the deployment and runtime platform.

- Netlify Functions are the only browser-to-server boundary.
- Netlify Database (managed Postgres) is the source of truth for structured,
  queryable, concurrent records: worlds, anonymous learners, course runs,
  mission attempts and evidence, reflections, and publication records.
- Netlify Blobs stores immutable, unstructured artifacts such as evidence JSON,
  screenshots, exports, and future media. It is not the progress database.
- The complete URL-encoded `WorldProfile` remains the portable, offline,
  shareable contract and graceful fallback.
- Repository migrations in `netlify/database/migrations` define the schema.
- The first slice is `POST /api/worlds` plus `GET /api/worlds/:id`, using the
  same validator as the forge and game and a server-issued anonymous identity.

## Environment isolation

Two Netlify projects prevent production learner data from entering previews:

1. `ironsight-staging` uses `staging`, owns staging Database/Blobs, contains
   synthetic data only, and hosts pull-request Deploy Previews.
2. `ironsight-958` uses `main`. The bare `ironsight` subdomain was already
   globally owned, so this explicit available fallback was selected without
   touching that site. It owns separate production Database/Blobs and blocks
   Deploy Previews.

Local development uses Netlify Dev, local Postgres-compatible Database and Blob
emulation, deterministic fixtures, and no production credentials or data.

## Cost and release guardrails

- Auto-recharge stays off; configure a credit alert in the dashboard.
- Database compute is 1–2 units and sleeps after five inactive minutes.
- Staging releases are controlled because its production branch consumes a
  production deploy.
- Migration failure blocks publish. Changes use expand/migrate/contract.

## Consequences

Learner work becomes durable and queryable without sacrificing the zero-backend
path. Two projects cost more than one, but provide stable staging, explicit data
isolation, and a safer preview boundary.
