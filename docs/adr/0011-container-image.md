# ADR 0011 — Container image: tsc build, distroless runtime, scanned and smoke-tested in CI

- Status: accepted (2026-10-08)

## Context
The service ran only through `tsx` from source. A deployable artifact must be small, reproducible,
run as non-root, carry no development tooling, and be scanned for known vulnerabilities before it
is published. Several files are read at runtime relative to the code (SQL migrations, the versioned
prompt, the pricing table, `package.json`).

## Decision
- **Build with `tsc`** (`tsconfig.build.json` → `dist/`). Relative imports in `src` carry their
  `.ts` extension (enforced by Biome's `useImportExtensions` for `src/**`) and
  `rewriteRelativeImportExtensions` turns them into `.js` on emit — plain Node ESM, no bundler, no
  `tsx` at runtime. A bundle was rejected: it breaks the relative asset paths and would load the
  telemetry bootstrap twice.
- **Multi-stage Dockerfile**: `node:24-trixie-slim` builds (pnpm via Corepack, store cache mount,
  frozen lockfile); a separate stage installs production dependencies only (`--prod
  --ignore-scripts`, hoisted `node_modules`); the runtime is `gcr.io/distroless/nodejs24-debian13`
  as `nonroot`, both bases pinned by digest. The repository layout is preserved in the image, so
  runtime file reads are unchanged. No shell in the runtime: the `HEALTHCHECK` is a one-line Node
  `fetch` of `/healthz`. Migrations are a one-off command (`src/db/migrate.js`); compose runs them
  before the app.
- **`@googleapis/calendar` instead of `googleapis`** — the same `calendar_v3` client without every
  other Google API (production dependencies 314 MB → ~70 MB; image 457 MB → 212 MB). Validated with
  the live Calendar test.
- **CI (`docker.yml`)**: Trivy on the repository (dependencies, secrets, misconfiguration) and on
  the image, failing on fixable HIGH/CRITICAL findings and uploading SARIF to the Security tab; a
  build with the GitHub Actions cache; a smoke test that migrates a Postgres service and probes
  `/healthz` and `/readyz` on the running image as `nonroot`; on `main`, a push to
  `ghcr.io/lucadboer/recepia` (commit-sha and `latest` tags) with an SBOM and provenance. A weekly
  run rescans for newly published vulnerabilities; Dependabot watches the pinned base images.
- A `.dockerignore` allowlist keeps `.env`, `secrets/`, tests and reports out of the build context.

## Consequences
- Local development keeps `pnpm start` (tsx); the image runs the compiled output.
- New source files must import relative modules with their extension (the linter fixes it).
- No deployment target is chosen yet (owner decision 2026-10-08): the image is the deliverable.
