/**
 * Startup configuration: reads environment variables ONCE, validates them,
 * and fails loudly (throws, before the server ever binds a port) when a
 * production deployment is missing something a real deployment cannot
 * safely run without. Development/test never trip these checks -- the
 * same permissive defaults this codebase already documented stay exactly
 * as permissive as before for local work, matching this repo's existing
 * "local development identity" scope (see auth.ts's own doc comment).
 *
 * Nothing here silently falls back to an insecure default IN PRODUCTION.
 * `NODE_ENV=production` with `NAQSH_ALLOWED_ORIGIN` unset is a
 * configuration error, not "allow every origin and hope for the best."
 */

export type NaqshEnvironment = "development" | "test" | "production";

export function resolveEnvironment(raw: string | undefined): NaqshEnvironment {
  if (raw === "production" || raw === "test") return raw;
  return "development";
}

export interface ResolvedCorsConfig {
  /** `undefined` means "no allowlist" -- `cors()` reflects every request's
   * Origin back (permissive), which is only ever reachable outside
   * production. */
  allowedOrigins: string[] | undefined;
}

/**
 * Throws a real `Error` (never a console warning that's easy to miss) when
 * `environment === "production"` and no non-empty `NAQSH_ALLOWED_ORIGIN`
 * was configured -- the ONE thing standing between "the API server only
 * answers browsers this deployment actually trusts" and "any website can
 * make credentialed-looking requests against it." Development and test
 * both keep the pre-existing permissive-by-default behavior, matching
 * this codebase's already-documented local-dev scope.
 */
export function resolveCorsConfig(environment: NaqshEnvironment, rawAllowedOrigin: string | undefined): ResolvedCorsConfig {
  const allowedOrigins = rawAllowedOrigin
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (environment === "production" && (!allowedOrigins || allowedOrigins.length === 0)) {
    throw new Error(
      "NAQSH_ALLOWED_ORIGIN must be set to a comma-separated list of trusted origins when NODE_ENV=production -- " +
        "refusing to start with CORS open to every origin in a production deployment. Set NAQSH_ALLOWED_ORIGIN " +
        "(e.g. \"https://app.example.com\") or run with NODE_ENV unset/development for local work."
    );
  }

  return { allowedOrigins: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : undefined };
}
