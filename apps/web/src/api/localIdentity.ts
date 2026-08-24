/**
 * The browser side of `apps/api/src/auth.ts`'s local-dev identity
 * abstraction: a stable, random, per-browser id sent as `x-naqsh-user` on
 * every request, so "this browser's projects" is a real, persistent
 * concept (not everyone sharing the server's single default bucket) and
 * project isolation is meaningfully exercised end to end, not just
 * theoretically enforced server-side. This is NOT authentication -- it is
 * an unsigned client-supplied string, exactly as trustworthy as any other
 * header; see auth.ts's own doc comment for what a real identity provider
 * would replace this with.
 */
const STORAGE_KEY = "naqsh.local-user-id";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

let cached: string | null = null;

export function getLocalUserId(): string {
  if (cached) return cached;
  if (typeof window === "undefined") return generateId();
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const created = generateId();
    window.localStorage.setItem(STORAGE_KEY, created);
    cached = created;
    return created;
  } catch {
    // localStorage unavailable (privacy mode, quota, disabled) -- fall back
    // to an in-memory id for this session rather than crashing every API call.
    cached = generateId();
    return cached;
  }
}
