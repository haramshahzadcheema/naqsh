import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResearchFetchRequest, createResearchSearchRequest, type ResearchProviderDescriptor } from "@naqsh/schemas";
import { createCachingResearchProvider } from "../src/research-cache.js";
import type { ResearchProvider } from "../src/research-provider.js";

function buildCountingProvider(): { provider: ResearchProvider; searchCalls: () => number; fetchCalls: () => number } {
  const descriptor: ResearchProviderDescriptor = { providerId: "counting", name: "Counting Provider", version: "0.0.1", metadata: {} };
  let searchCalls = 0;
  let fetchCalls = 0;
  const provider: ResearchProvider = {
    describe: () => descriptor,
    async search(request) {
      searchCalls += 1;
      return {
        id: `inv_${searchCalls}`,
        requestId: request.id,
        providerId: descriptor.providerId,
        status: "success",
        results: [{ locator: null, title: `Result #${searchCalls}`, publisher: null, sourceType: "web_page", publishedAt: null, snippet: "x" }],
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        metadata: {}
      };
    },
    async fetch(request) {
      fetchCalls += 1;
      return {
        id: `fetchinv_${fetchCalls}`,
        requestId: request.id,
        providerId: descriptor.providerId,
        status: "success",
        content: { locator: request.locator, title: `Content #${fetchCalls}`, publisher: null, sourceType: "web_page", publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: "x", contentHash: null },
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        metadata: {}
      };
    }
  };
  return { provider, searchCalls: () => searchCalls, fetchCalls: () => fetchCalls };
}

describe("Test 19: research cache correctness", () => {
  it("a repeated identical search is served from cache -- the underlying provider is called only once", async () => {
    const { provider, searchCalls } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);

    const first = await cached.search(createResearchSearchRequest({ query: "6061-T6 yield strength" }));
    const second = await cached.search(createResearchSearchRequest({ query: "6061-T6 yield strength" }));

    assert.equal(searchCalls(), 1, "the underlying provider must only be called once for identical requests");
    assert.equal(first.results![0]!.title, "Result #1");
    assert.equal(second.results![0]!.title, "Result #1", "the cached (original) content is returned, not a fresh call's content");
  });

  it("a different query is NOT served from cache", async () => {
    const { provider, searchCalls } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);

    await cached.search(createResearchSearchRequest({ query: "query A" }));
    await cached.search(createResearchSearchRequest({ query: "query B" }));

    assert.equal(searchCalls(), 2);
  });

  it("a repeated identical fetch is served from cache", async () => {
    const { provider, fetchCalls } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);

    await cached.fetch(createResearchFetchRequest({ locator: "https://example.com/x" }));
    await cached.fetch(createResearchFetchRequest({ locator: "https://example.com/x" }));

    assert.equal(fetchCalls(), 1);
  });

  it("provenance is preserved: a cache hit records servedFromCache/originallyRetrievedAt/reusedAt, a cache miss records servedFromCache:false", async () => {
    const { provider } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);

    const miss = await cached.search(createResearchSearchRequest({ query: "x" }));
    const missCache = miss.metadata.cache as { servedFromCache: boolean; originallyRetrievedAt: string; reusedAt: string | null };
    assert.equal(missCache.servedFromCache, false);
    assert.equal(missCache.reusedAt, null);
    assert.equal(missCache.originallyRetrievedAt, miss.completedAt);

    const hit = await cached.search(createResearchSearchRequest({ query: "x" }));
    const hitCache = hit.metadata.cache as { servedFromCache: boolean; originallyRetrievedAt: string; reusedAt: string | null };
    assert.equal(hitCache.servedFromCache, true);
    assert.equal(hitCache.originallyRetrievedAt, missCache.originallyRetrievedAt, "a cache hit must report WHEN the data was ORIGINALLY retrieved, not now");
    assert.ok(hitCache.reusedAt, "a cache hit must report WHEN it was reused");
  });

  it("a cache hit still gets its own fresh id and requestId -- it genuinely IS a new invocation from the caller's point of view", async () => {
    const { provider } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);

    const requestA = createResearchSearchRequest({ query: "x" });
    const requestB = createResearchSearchRequest({ query: "x" });
    const first = await cached.search(requestA);
    const second = await cached.search(requestB);

    assert.notEqual(first.id, second.id);
    assert.equal(first.requestId, requestA.id);
    assert.equal(second.requestId, requestB.id);
  });

  it("does NOT cache a provider failure -- a retry after an error genuinely retries", async () => {
    const descriptor: ResearchProviderDescriptor = { providerId: "flaky", name: "Flaky Provider", version: "0.0.1", metadata: {} };
    let calls = 0;
    const flaky: ResearchProvider = {
      describe: () => descriptor,
      async search(request) {
        calls += 1;
        if (calls === 1) {
          return { id: "inv_1", requestId: request.id, providerId: descriptor.providerId, status: "error", results: null, error: { kind: "rate_limit", message: "try again" }, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), metadata: {} };
        }
        return { id: "inv_2", requestId: request.id, providerId: descriptor.providerId, status: "success", results: [{ locator: null, title: "ok", publisher: null, sourceType: "web_page", publishedAt: null, snippet: "x" }], error: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), metadata: {} };
      },
      async fetch(request) {
        return { id: "fetchinv_1", requestId: request.id, providerId: descriptor.providerId, status: "success", content: { locator: request.locator, title: "x", publisher: null, sourceType: "web_page", publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: "x", contentHash: null }, error: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), metadata: {} };
      }
    };
    const cached = createCachingResearchProvider(flaky);

    const first = await cached.search(createResearchSearchRequest({ query: "x" }));
    assert.equal(first.status, "error");
    const second = await cached.search(createResearchSearchRequest({ query: "x" }));
    assert.equal(second.status, "success");
    assert.equal(calls, 2, "an errored call must not be cached -- the retry must reach the provider again");
  });

  it("the caching decorator's own result still passes the schema's own validation (metadata.cache is JSON-safe)", async () => {
    const { provider } = buildCountingProvider();
    const cached = createCachingResearchProvider(provider);
    const { assertResearchSearchInvocationResult } = await import("@naqsh/schemas");
    const result = await cached.search(createResearchSearchRequest({ query: "x" }));
    assert.doesNotThrow(() => assertResearchSearchInvocationResult(result));
  });
});
