/** Load .env into process.env if present (Node 20.12+). Optional — env may already be set. */
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file; rely on the ambient environment
  }
}
