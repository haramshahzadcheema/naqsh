import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResearchFetchRequest, createResearchSearchRequest } from "@naqsh/schemas";
import { runResearchProviderContractTests } from "@naqsh/core";
import { createMockResearchProvider } from "../src/mock-research-provider.js";

runResearchProviderContractTests("createMockResearchProvider (default responders)", () => createMockResearchProvider());

describe("createMockResearchProvider: default responders", () => {
  it("search() produces a deterministic single candidate for an unconfigured provider", async () => {
    const provider = createMockResearchProvider();
    const request = createResearchSearchRequest({ query: "6061-T6 aluminum yield strength" });
    const result = await provider.search(request);
    assert.equal(result.status, "success");
    assert.equal(result.results!.length, 1);
    assert.match(result.results![0]!.title, /6061-T6 aluminum yield strength/);
  });

  it("fetch() produces deterministic content for an unconfigured provider", async () => {
    const provider = createMockResearchProvider();
    const request = createResearchFetchRequest({ locator: "https://example.com/datasheet.pdf" });
    const result = await provider.fetch(request);
    assert.equal(result.status, "success");
    assert.equal(result.content!.locator, "https://example.com/datasheet.pdf");
  });

  it("is deterministic -- same request twice produces the same content (modulo ids/timestamps advancing on the logical clock)", async () => {
    const providerA = createMockResearchProvider();
    const providerB = createMockResearchProvider();
    const requestA = createResearchSearchRequest({ id: "req_1", query: "same query", createdAt: "2000-01-01T00:00:00.000Z" });
    const requestB = createResearchSearchRequest({ id: "req_1", query: "same query", createdAt: "2000-01-01T00:00:00.000Z" });
    const resultA = await providerA.search(requestA);
    const resultB = await providerB.search(requestB);
    assert.deepEqual(resultA, resultB);
  });
});

describe("createMockResearchProvider: custom responders", () => {
  it("respondToSearch overrides the default candidates", async () => {
    const provider = createMockResearchProvider({
      respondToSearch: () => ({
        results: [{ locator: "https://acme.example.com/x", title: "Custom Result", publisher: "Acme", sourceType: "datasheet", publishedAt: null, snippet: "custom" }]
      })
    });
    const result = await provider.search(createResearchSearchRequest({ query: "irrelevant" }));
    assert.equal(result.results![0]!.title, "Custom Result");
  });

  it("a respondToSearch that returns an explicit error produces status:'error', never a thrown exception", async () => {
    const provider = createMockResearchProvider({
      respondToSearch: () => ({ error: { kind: "rate_limit", message: "simulated rate limit" } })
    });
    const result = await provider.search(createResearchSearchRequest({ query: "irrelevant" }));
    assert.equal(result.status, "error");
    assert.equal(result.error!.kind, "rate_limit");
  });

  it("a respondToSearch that THROWS is caught and surfaced as a well-formed provider_error, never an unhandled rejection", async () => {
    const provider = createMockResearchProvider({
      respondToSearch: () => {
        throw new Error("simulated crash inside the responder");
      }
    });
    const result = await provider.search(createResearchSearchRequest({ query: "irrelevant" }));
    assert.equal(result.status, "error");
    assert.equal(result.error!.kind, "provider_error");
  });

  it("a respondToFetch that throws is caught and surfaced as a well-formed error", async () => {
    const provider = createMockResearchProvider({
      respondToFetch: () => {
        throw new Error("simulated crash");
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/x" }));
    assert.equal(result.status, "error");
    assert.equal(result.error!.kind, "provider_error");
  });
});

describe("createMockResearchProvider: SSRF / private-network protection (Test 18)", () => {
  const blockedLocators = [
    "http://localhost/secret",
    "http://127.0.0.1/secret",
    "http://127.5.5.5/secret",
    "http://0.0.0.0/secret",
    "http://10.0.0.5/internal",
    "http://192.168.1.1/router",
    "http://172.16.0.1/internal",
    "http://169.254.169.254/latest/meta-data", // cloud metadata endpoint
    "http://service.internal/secret",
    "http://box.local/secret",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "not a url at all"
  ];

  for (const locator of blockedLocators) {
    it(`blocks fetch() for "${locator}"`, async () => {
      const provider = createMockResearchProvider();
      const result = await provider.fetch(createResearchFetchRequest({ locator }));
      assert.equal(result.status, "error");
      assert.equal(result.error!.kind, "blocked_locator");
      assert.equal(result.content, null);
    });
  }

  it("does NOT block a genuine public https locator", async () => {
    const provider = createMockResearchProvider();
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/document" }));
    assert.equal(result.status, "success");
  });

  it("a custom respondToFetch is never even consulted for a blocked locator -- the block happens before the responder runs", async () => {
    let responderCalled = false;
    const provider = createMockResearchProvider({
      respondToFetch: () => {
        responderCalled = true;
        return { content: { locator: "http://127.0.0.1/x", title: "should never be reached", publisher: null, sourceType: "web_page", publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: "x", contentHash: null } };
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "http://127.0.0.1/x" }));
    assert.equal(result.status, "error");
    assert.equal(responderCalled, false);
  });
});
