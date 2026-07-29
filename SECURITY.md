# Security Policy

IRONSIGHT is a browser-native game and a small teaching site (`/learn/`, `/forge/`) backed by a
handful of Netlify Functions (`netlify/functions/`) that talk to Netlify Database and Netlify
Blobs. There is no production PII collection today beyond an anonymous, server-issued session
cookie — see `docs/OWNERSHIP.md` and issue #3 for the current threat-model gaps that are still
open work.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately to **jai.ghodwala@gmail.com** with:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal repro is ideal).
- Any proof-of-concept code, request/response captures, or affected URLs.

You should receive an acknowledgement within **3 business days**. We'll follow up with a
triage decision (accepted/declined, severity, target fix window) as soon as we've reproduced
the report, and credit reporters in the release notes unless you ask us not to.

If GitHub's private vulnerability reporting is enabled for this repository, you may use that
instead: `Security` tab → `Report a vulnerability`.

## Scope

In scope:

- The deployed game, academy, and forge (Netlify + Vercel static hosting).
- `netlify/functions/**` (currently `worlds.mts` — `POST/GET /api/worlds`).
- Client-side code in `src/**` that ships to the browser.
- CI/CD configuration (`.github/workflows/**`, `netlify.toml`, `vercel.json`).

Out of scope:

- Denial-of-service / load testing against the shared free-tier deployment.
- Social engineering, physical security, or third-party services (GitHub, Netlify, Vercel
  themselves) — report those to the vendor directly.
- Findings that require a compromised developer machine or CI secret to exploit.

## Supported versions

This is a single-branch project (`main`) with no maintained release lines. Security fixes land
on `main` and roll out on the next deploy; there is no backport policy.

## Dependency scanning

- Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm and GitHub Actions updates.
- CI (`.github/workflows/verify.yml`, `dependency-audit` job) runs `npm audit --audit-level=high`
  on every PR and push to `main`/`staging`.

## Hardening already in place

- Content-Security-Policy, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Referrer-Policy`,
  `Permissions-Policy`, and `X-Content-Type-Options: nosniff` are set repo-wide in `netlify.toml`
  and mirrored in `vercel.json`.
- The client ships zero binary art assets and makes zero runtime `fetch`/XHR calls today —
  `tools/check-boundaries.mjs` bans `fetch(` from all of `src/`, so the attack surface for
  client-side data exfiltration is currently limited to what a compromised third-party script
  (there are none — no CDN scripts, no analytics) could do.
- Session identity is an anonymous, `HttpOnly`, `SameSite=Lax`, `Secure` (on HTTPS) cookie —
  see `netlify/functions/worlds.mts`.
