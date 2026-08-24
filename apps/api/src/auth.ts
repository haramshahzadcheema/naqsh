import type { Request } from "express";

/**
 * A real, structured identity abstraction -- not full production
 * authentication (there is no login flow, no session store, no password
 * or token issuance anywhere in this environment), but a genuine code
 * path every route actually goes through, so project ownership/isolation
 * is enforced TODAY rather than deferred. A real identity provider (a
 * session cookie verified server-side, a JWT, an OAuth flow) would
 * replace only this file's internals -- every call site already reads
 * identity through `getAuthContext`, never a raw header/cookie of its
 * own, so swapping the implementation never requires touching a route.
 *
 * `x-naqsh-user`, when present, selects which of several LOCAL dev
 * identities a request acts as (useful for exercising project isolation
 * in tests/manual QA without real accounts). It is NOT authentication:
 * it is an unsigned, unverified client-supplied string, exactly as
 * trustworthy as any other request header -- never rely on it to gate
 * anything beyond "which local-dev bucket does this request's data land
 * in." A production deployment must replace `getAuthContext` with one
 * that verifies a real credential and REJECTS an unauthenticated
 * request outright, rather than falling back to a shared default.
 */
export interface AuthContext {
  userId: string;
}

export const LOCAL_DEV_USER_ID = "local-dev-user";

const MAX_USER_ID_LENGTH = 200;

export function getAuthContext(req: Request): AuthContext {
  const header = req.header("x-naqsh-user");
  const userId = typeof header === "string" && header.trim().length > 0 ? header.trim().slice(0, MAX_USER_ID_LENGTH) : LOCAL_DEV_USER_ID;
  return { userId };
}
