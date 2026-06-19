# Contributing

## Toolchain

- **Package manager: pnpm** (pinned via Corepack — see the `packageManager` field in `package.json`). Enable once with `corepack enable`.
- **Node 20+**. TypeScript scripts run via **tsx**; tests via **Vitest**.
- **Postgres** for local dev/tests: `pnpm db:up` (Docker Compose, `recepia-pg` on host port **5434** — 5432/5433 are used by other local projects).

## Dependency policy (READ BEFORE ADDING DEPS)

The goal is to **always be on the latest, vulnerability-free versions** — never hand-pin stale versions in `package.json`.

1. **Add/update with the package manager, not by hand.** Let pnpm resolve the latest:
   ```bash
   pnpm add <pkg>            # runtime dependency, latest
   pnpm add -D <pkg>         # dev dependency, latest
   pnpm up --latest          # bump everything to latest within policy
   pnpm outdated             # see what's behind
   ```
   Do **not** type a version range directly into `package.json` and hope — that is how versions go stale.

2. **Vulnerability gate — required before merging a dependency change:**
   ```bash
   pnpm audit               # must report no HIGH or CRITICAL advisories
   ```
   If a HIGH/CRITICAL is found: upgrade past it, replace the package, or (last resort) document an accepted exception with rationale.

3. **Supply-chain controls stay ON (configured in `pnpm-workspace.yaml`):**
   - **Build scripts are blocked by default.** Only explicitly approved packages may run install scripts (`allowBuilds`). Today: `esbuild` only (needed by tsx/vitest).
   - **Minimum release age.** Brand-new releases are held back briefly to dodge the fresh-compromise window. Allowing a very recent version requires an explicit `minimumReleaseAgeExclude` entry + a note (see `pg@8.22.0`).

4. **HTTPS registry only.** The project `.npmrc` forces `https://registry.npmjs.org/`. (The machine's global `~/.npmrc` currently uses insecure `http://` — fix it globally with `npm config set registry https://registry.npmjs.org/`.)

## Workflow (Spec Driven Development)

This project is built with the GitHub Spec Kit. Every feature starts from a spec under `specs/NNN-feature/`. Flow: `/speckit.specify` → `/speckit.clarify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`. See [CLAUDE.md](CLAUDE.md) and the [constitution](.specify/memory/constitution.md).

## Quality gates

```bash
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check
pnpm test                 # full Vitest suite (unit + integration + concurrency)
```

The concurrency test (no overbooking under simultaneous holds) is a non-negotiable gate and must stay green.
