import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live (network) tests are out of the default suite — run via `pnpm test:live`.
    exclude: [...configDefaults.exclude, "tests/live/**"],
    setupFiles: ["tests/setup.ts"],
    // DB-backed tests share one Postgres; run files serially and tests
    // non-concurrently so they don't clobber each other's rows.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      // src/ and the evaluation harness library — not the .sql migrations (the v8 remapper would try
      // to parse them) and not the CLI entrypoint (exercised by `pnpm evals:fake` in CI).
      include: ["src/**/*.ts", "evals/lib/**/*.ts"],
      exclude: [
        "src/server.ts", // process entrypoint — smoke-tested via `pnpm start` + SIGTERM, not unit-testable
        "src/db/seed.ts", // dev-only CLI
        "src/telemetry/register.ts", // process bootstrap loaded with --import; exercised by perf.yml (spans checked in Jaeger)
        "src/cli/retention-purge.ts", // thin CLI over purgeInactive (tested); arg parsing is unit-tested
        "src/adapters/calendar/google-calendar.ts", // live-only adapter (tests/live, needs credentials)
      ],
      reporter: ["text-summary", "json-summary", "lcov"],
      // Thresholds are the measured baseline minus a small margin (see CONTRIBUTING.md); ratchet up,
      // never down. CI fails below them.
      thresholds: { lines: 93, statements: 92, functions: 90, branches: 86 },
    },
  },
});
