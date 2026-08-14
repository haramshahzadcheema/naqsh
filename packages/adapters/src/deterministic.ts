/**
 * Deterministic replacements for @naqsh/schemas' `createId`/`toIsoTimestamp`
 * defaults (which use `randomUUID()` and wall-clock `new Date()`). P6's
 * mock environment needs "same initial state + same operations + same
 * inputs => same result" to hold exactly, including ids and timestamps --
 * useful for reproducible tests and, later, deterministic replay (P24).
 *
 * Each factory returns a fresh, independent generator with its own private
 * counter/clock state, so two mock environments built from two separate
 * calls never share state -- calling the factory twice and feeding both
 * results the same sequence of operations produces IDENTICAL output.
 */

/** Per-prefix incrementing counter, e.g. `envobj_0001`, `envobj_0002`. */
export function createDeterministicIdGenerator(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, "0")}`;
  };
}

/** A logical clock: starts at `startIso` and advances by `stepMs` on every
 * call, so successive timestamps are always strictly increasing without
 * ever touching the real wall clock. */
export function createDeterministicClock(
  startIso: string = "2000-01-01T00:00:00.000Z",
  stepMs: number = 1000
): () => string {
  let currentMs = new Date(startIso).getTime();
  if (Number.isNaN(currentMs)) {
    throw new Error(`createDeterministicClock: "${startIso}" is not a valid ISO timestamp`);
  }
  return () => {
    const iso = new Date(currentMs).toISOString();
    currentMs += stepMs;
    return iso;
  };
}
