# Netlify environment and release runbook

This runbook is the operational contract for the teaching platform. Never put a
Netlify token, account ID, site ID, database URL, connection string, or learner
record in this repository. Netlify's ignored `.netlify/` state may hold local
site linkage.

## Environment contract

| Environment | Source | Database and Blobs | Required proof |
| --- | --- | --- | --- |
| Local | working tree via `npm run netlify:dev` | Netlify Dev local database and Blob emulator; deterministic fixtures only | clean migration, unit, Function↔Database/Blob integration, forge/academy acceptance, actual-game smoke |
| Staging | `ironsight-staging`, production branch `staging` | its own Database main branch and site-scoped Blob store; synthetic data only | all routes, durable create/read, URL fallback, headers/error scan, full teaching smoke |
| Production | `ironsight`, production branch `main` | separate production Database and site-scoped Blob store | exact tested commit, migration, disposable canary, headers/log scan, rollback readiness |

Pull requests create Deploy Previews on the staging project. Production previews
are disabled or protected. No preview may read or copy production learner data.
The stable staging and production origins are non-secret environment
configuration; credentials remain platform-managed.

## Local

Use Node 22.

```sh
npm ci
npm run netlify:dev
```

In a second terminal, apply the repository migrations to the local database:

```sh
npx netlify-cli@27.0.1 database migrations apply
```

Then run:

```sh
npm run verify
IRONSIGHT_LOCAL_URL=http://127.0.0.1:8888 npm run smoke:local
npm run teach:smoke
```

`netlify dev` owns the local database lifecycle. The local database does not
autoscale or sleep and is not a load-test target. Integration tests instead use
an isolated in-memory `@netlify/database-dev` instance and fake immutable Blob
adapter; they do not need a Netlify account.

## Netlify project settings

Create exactly two projects after confirming the names are unused:

- staging: `ironsight-staging`, repository `ChaiWithJai/ironsight`, production
  branch `staging`, previews enabled;
- production: `ironsight-958` (the available explicit fallback because the
  global `ironsight` subdomain was already owned), the same repository,
  production branch `main`, previews disabled.

Set the non-secret `IRONSIGHT_NETLIFY_ROLE` site environment value to `staging`
or `production`. The deploy-preview ignore command uses that value to allow
previews only on the isolated staging project. A missing or unknown role fails
closed and cancels the preview.

For each project, provision its own Database and Blob scope. Configure Database
minimum compute 1, maximum compute 2, and inactivity sleep 5 minutes. Keep
account auto-recharge off and set a credit alert in the billing dashboard if no
safe CLI/API control is exposed.

Do not commit project IDs. Resolve them through authenticated CLI state or
environment at execution time.

## Release gates

1. A feature pull request must pass GitHub `Verify` and the staging-project
   Deploy Preview. Apply preview migrations automatically and run browser
   acceptance against its URL.
2. Merge the exact reviewed commit to `staging`. Verify the stable staging URL
   with `IRONSIGHT_STAGING_URL=https://… npm run smoke:staging`, then run the
   full teaching smoke against that origin.
3. Promote the same commit to `main`. Netlify applies repository migrations
   immediately before publish; a failure blocks the release.
4. Verify production with
   `IRONSIGHT_PRODUCTION_URL=https://… npm run smoke:production`. Canary worlds
   must use an unmistakable `CANARY` civilization name. The first slice has no
   destructive delete endpoint, so retain the tiny publication record unless a
   database administrator can remove the exact row safely.
5. Check Function and deploy logs for uncaught errors and unexpected 4xx/5xx
   responses. Record screenshots and JSON proof outside source control.

## Rollback

Use Netlify's published deploy history to identify the previous known-good
artifact before changing traffic. A publish rollback does not roll a database
back. Therefore:

- keep migrations backwards compatible with both the current and immediately
  previous application;
- use expand, migrate data, then contract in a later release;
- if a migration fails, stop publication rather than forcing it;
- if application behavior regresses, restore the prior published deploy and
  leave the compatible expanded schema in place;
- never restore a production database into staging or a public preview.

Before each production release, verify that the prior deploy is still available
and that the migration has a documented forward correction.

## Backup, restore, and RPO/RTO

Database backup/restore mechanics, RPO/RTO targets, application-rollback
compatibility, and migration forward-correction — with a rehearsed, runnable
drill (`ops/backup-restore-rehearsal.sh`) — live in
[`BACKUP_RESTORE_RUNBOOK.md`](./BACKUP_RESTORE_RUNBOOK.md). Restore and rollback
are rehearsed against **local/staging only**, never production.
