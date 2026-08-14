/**
 * Minimal deterministic id/clock generators, scoped to this package.
 * Deliberately NOT imported from @naqsh/adapters (which has its own,
 * environment-flavored version): a model-provider package depending on the
 * environment-adapter package for an unrelated utility would be a strange,
 * unjustified cross-dependency between two sibling "concrete
 * implementation" packages, and P7 must not touch P6 to get this. A dozen
 * lines duplicated here is cheaper than that coupling.
 */

export function createDeterministicIdGenerator(): (prefix: string) => string {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, "0")}`;
  };
}

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
