import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertResearchFetchInvocationResult,
  assertResearchProviderDescriptor,
  assertResearchSearchInvocationResult,
  createResearchFetchRequest,
  createResearchSearchRequest
} from "@naqsh/schemas";
import type { ResearchProvider } from "./research-provider.js";

/**
 * THE reusable contract-test suite for `ResearchProvider` (mirrors
 * `runModelProviderContractTests`/`runEnvironmentAdapterContractTests`'s
 * exact "call once with a factory, register a describe/it tree" shape).
 * Only ONE implementation exists in this phase (the deterministic mock,
 * `@naqsh/adapters`'s `createMockResearchProvider`) -- this suite still
 * earns its place because it is exactly what a FUTURE real provider (a
 * genuine search API, added behind this same interface without touching
 * core) would need to prove it honors the same "never throw for an
 * expected failure, always return a well-formed, self-consistent result"
 * discipline the mock is held to today, matching the exact reasoning
 * `model-provider-contract.ts`'s own doc comment already gives for why it
 * exists ahead of a second `ModelProvider` implementation.
 *
 * Deliberately does NOT assert on the CONTENT of search/fetch results
 * (which candidates, what text) -- that is provider-specific and cannot be
 * forced deterministically from a generic suite. What it verifies is
 * structural: results are well-formed per their own schema validators,
 * ids/timestamps behave, and a request for a private/loopback locator (if
 * the provider chooses to reject one) still returns a well-formed error,
 * never an unhandled exception.
 */
export function runResearchProviderContractTests(label: string, createProvider: () => ResearchProvider | Promise<ResearchProvider>): void {
  describe(`ResearchProvider contract: ${label}`, () => {
    it("describe() returns a valid, self-consistent descriptor", async () => {
      const provider = await createProvider();
      const descriptor = provider.describe();
      assertResearchProviderDescriptor(descriptor);
      assert.equal(descriptor.providerId.length > 0, true);
    });

    it("search() with a minimal query never throws and returns a well-formed result", async () => {
      const provider = await createProvider();
      const request = createResearchSearchRequest({ query: "contract probe query" });

      let result;
      try {
        result = await provider.search(request);
      } catch {
        assert.fail("ResearchProvider.search() must never throw/reject for an expected failure mode");
      }
      assertResearchSearchInvocationResult(result);
      assert.equal(result.requestId, request.id);
      assert.equal(result.providerId, provider.describe().providerId);
      assert.ok(result.completedAt >= result.startedAt, "completedAt must not precede startedAt");
      assert.equal(result.status === "success", result.results !== null);
      assert.equal(result.status === "error", result.error !== null);
    });

    it("search() honors maxResults -- never returns more candidates than requested", async () => {
      const provider = await createProvider();
      const request = createResearchSearchRequest({ query: "contract probe query", maxResults: 1 });
      const result = await provider.search(request);
      assertResearchSearchInvocationResult(result);
      if (result.status === "success") {
        assert.ok(result.results!.length <= 1, "search() must never return more candidates than maxResults");
      }
    });

    it("fetch() with a well-formed, public locator never throws and returns a well-formed result", async () => {
      const provider = await createProvider();
      const request = createResearchFetchRequest({ locator: "https://contract-probe.example.com/document" });

      let result;
      try {
        result = await provider.fetch(request);
      } catch {
        assert.fail("ResearchProvider.fetch() must never throw/reject for an expected failure mode");
      }
      assertResearchFetchInvocationResult(result);
      assert.equal(result.requestId, request.id);
      assert.equal(result.status === "success", result.content !== null);
      assert.equal(result.status === "error", result.error !== null);
    });

    it("fetch() with a private/loopback locator never throws -- either rejects it (blocked_locator) or returns well-formed content, never an unhandled exception", async () => {
      const provider = await createProvider();
      const request = createResearchFetchRequest({ locator: "http://127.0.0.1/internal" });

      let result;
      try {
        result = await provider.fetch(request);
      } catch {
        assert.fail("ResearchProvider.fetch() must never throw/reject, even for a locator it chooses to block");
      }
      assertResearchFetchInvocationResult(result);
    });
  });
}
