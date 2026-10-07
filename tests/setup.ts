import { loadEnv } from "../src/db/env";

// Make DATABASE_URL (and friends) available to DB-backed tests.
loadEnv();
// Structured logs are noise in test output; tests that assert on logs capture them explicitly.
process.env.LOG_LEVEL ??= "silent";
