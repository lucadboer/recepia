const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Scripts that TRUNCATE tables (perf smoke, eval harness) refuse to run against a database
 * that is not local, unless `<allowEnvVar>=1` says it is disposable. CI databases are local
 * services, so there is no CI-specific bypass (an exported CI=true must not widen the hole).
 */
export function assertDisposableDatabase(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  allowEnvVar = "PERF_ALLOW_TRUNCATE",
  what = "the perf smoke",
): void {
  if (env[allowEnvVar] === "1") return;
  let host = "";
  try {
    host = new URL(databaseUrl ?? "").hostname;
  } catch {
    host = "";
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `refusing to TRUNCATE tables on non-local database host "${host || "?"}" — ${what} wipes data; set ${allowEnvVar}=1 only for a disposable database`,
    );
  }
}
