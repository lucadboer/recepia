import { loadEnv } from "../src/db/env";

// Make DATABASE_URL (and friends) available to DB-backed tests.
loadEnv();
