import { createId, type ResearchFetchRequest, type ResearchFetchInvocationResult, type ResearchSearchInvocationResult, type ResearchSearchRequest } from "@naqsh/schemas";
import type { ResearchProvider } from "./research-provider.js";

/**
 * A small, deterministic CACHING DECORATOR around a `ResearchProvider`
 * (P21 brief Section 20). Deliberately a decorator, not a change to the
 * `ResearchProvider` interface or any concrete implementation: any
 * provider (the mock today, a real one later) can be wrapped, and a
 * caller who wants no caching simply doesn't wrap it -- "keep providers
 * replaceable" (brief Section 29) applies to caching too.
 *
 * NOT a distributed cache (brief: "do not build a distributed cache
 * system") -- a single in-memory `Map`, scoped to whatever created it
 * (typically one process/session), cleared on process exit. Cache keys
 * consider exactly the inputs that determine a result: provider id +
 * query (or locator) + the other request parameters that could change the
 * answer (`maxResults`/`preferredSourceTypes` for search) -- matching the
 * brief's own "provider, query/request, source locator" guidance.
 *
 * Caching NEVER destroys provenance (brief: "A cached result must still
 * tell the system: when it was originally retrieved, when it was reused,
 * where it came from"). Every returned result carries a `cache` block in
 * its `metadata` (the existing, already-JSON-validated extension point
 * every entity/result already has -- no schema change needed):
 *   { servedFromCache, originallyRetrievedAt, reusedAt }
 * A cache HIT still gets a fresh `id` (this genuinely IS a new invocation
 * from the caller's point of view) but reuses the ORIGINAL `results`/
 * `content` and preserves the ORIGINAL `startedAt`/`completedAt` from
 * when the data was actually retrieved -- a cache hit must never claim it
 * just performed a fresh external call.
 */

interface CacheEntry<T> {
  result: T;
  originallyRetrievedAt: string;
}

export interface ResearchCacheOptions {
  now?: () => string;
}

function searchCacheKey(providerId: string, request: ResearchSearchRequest): string {
  return `search:${providerId}:${request.query}:${request.maxResults}:${[...request.preferredSourceTypes].sort().join(",")}`;
}

function fetchCacheKey(providerId: string, request: ResearchFetchRequest): string {
  return `fetch:${providerId}:${request.locator}`;
}

function withCacheMetadata<T extends { metadata: Record<string, unknown> }>(result: T, servedFromCache: boolean, originallyRetrievedAt: string, now: string): T {
  return { ...result, metadata: { ...result.metadata, cache: { servedFromCache, originallyRetrievedAt, reusedAt: servedFromCache ? now : null } } };
}

export function createCachingResearchProvider(provider: ResearchProvider, options: ResearchCacheOptions = {}): ResearchProvider {
  const now = options.now ?? (() => new Date().toISOString());
  const searchCache = new Map<string, CacheEntry<ResearchSearchInvocationResult>>();
  const fetchCache = new Map<string, CacheEntry<ResearchFetchInvocationResult>>();

  return {
    describe: () => provider.describe(),

    async search(request) {
      const providerId = provider.describe().providerId;
      const key = searchCacheKey(providerId, request);
      const cached = searchCache.get(key);
      if (cached) {
        return withCacheMetadata({ ...cached.result, id: createId("researchsearchinv"), requestId: request.id }, true, cached.originallyRetrievedAt, now());
      }
      const result = await provider.search(request);
      // Only a genuine SUCCESS is worth caching -- caching a transient
      // provider failure (rate limit, timeout) would make it sticky,
      // which is exactly backwards for an error a retry might resolve.
      if (result.status === "success") {
        searchCache.set(key, { result, originallyRetrievedAt: result.completedAt });
        return withCacheMetadata(result, false, result.completedAt, now());
      }
      return result;
    },

    async fetch(request) {
      const providerId = provider.describe().providerId;
      const key = fetchCacheKey(providerId, request);
      const cached = fetchCache.get(key);
      if (cached) {
        return withCacheMetadata({ ...cached.result, id: createId("researchfetchinv"), requestId: request.id }, true, cached.originallyRetrievedAt, now());
      }
      const result = await provider.fetch(request);
      if (result.status === "success") {
        fetchCache.set(key, { result, originallyRetrievedAt: result.completedAt });
        return withCacheMetadata(result, false, result.completedAt, now());
      }
      return result;
    }
  };
}
