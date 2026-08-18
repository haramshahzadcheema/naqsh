import {
  createResearchFetchContent,
  createResearchFetchInvocationResult,
  createResearchProviderDescriptor,
  createResearchSearchInvocationResult,
  createResearchSourceCandidate,
  type ResearchFetchContent,
  type ResearchFetchInvocationResult,
  type ResearchFetchRequest,
  type ResearchProviderError,
  type ResearchSearchInvocationResult,
  type ResearchSearchRequest,
  type ResearchSourceCandidate
} from "@naqsh/schemas";
import type { ResearchProvider } from "@naqsh/core";
import { createDeterministicClock, createDeterministicIdGenerator } from "./deterministic.js";

/**
 * A deterministic, network-free `ResearchProvider` (P21 brief Section 26:
 * "Do NOT rely on live web access for the core test suite. Create
 * deterministic mock ResearchProvider implementations."). No HTTP client,
 * no search-engine SDK, no `node:http`/`node:https`/`fetch()` call anywhere
 * in this file -- confirmed by the repo-boundaries P21 guard block, the
 * same "grep for the dangerous thing AND read the file" discipline every
 * prior phase's security sweep used.
 *
 * DELIBERATELY the only `ResearchProvider` implementation shipped in P21.
 * The brief's own Section 11 ("Do NOT build a web-scraping monster") and
 * Section 2's exclusion list ("general-purpose search infrastructure")
 * make a REAL live-web provider explicitly out of scope this phase --
 * unlike P7 (which shipped both a mock AND a real Gemini adapter) and P12
 * (mock AND real FreeCAD), P21 has no concrete external system it is
 * asked to integrate with, and building one speculatively would be
 * exactly the kind of "prepare for it" overreach the P21 brief's own
 * Section 2 warns against. A real provider (e.g. wrapping a specific
 * search API) can be added later behind this SAME `ResearchProvider`
 * interface without touching core, tools, or the World Model -- that is
 * the entire point of the boundary.
 *
 * SSRF / private-network protection (P21 brief Section 21) is enforced
 * HERE, at the one place a locator is ever "fetched" -- `isBlockedLocator`
 * rejects localhost, loopback, private/link-local IP ranges, and non-http(s)
 * schemes before any content is ever synthesized for a locator, exactly
 * the posture a REAL provider wrapping a real HTTP client would need. This
 * mock has no actual network stack to protect, but implementing (and
 * testing) the check now means a future real provider has a proven,
 * already-tested contract to satisfy, not a security control invented
 * from scratch under deadline pressure later.
 */

const SEARCH_RESULT_PREFIX = "researchsearchinv";
const FETCH_RESULT_PREFIX = "researchfetchinv";

export type MockResearchSearchOutcome = { results: ResearchSourceCandidate[] } | { error: ResearchProviderError };
export type MockResearchFetchOutcome = { content: ResearchFetchContent } | { error: ResearchProviderError };

export type MockResearchSearchResponder = (request: ResearchSearchRequest) => MockResearchSearchOutcome;
export type MockResearchFetchResponder = (request: ResearchFetchRequest) => MockResearchFetchOutcome;

export interface MockResearchProviderOptions {
  providerId?: string;
  /** Called once per `search()` call. Defaults to a simple, deterministic
   * single-candidate rule (see `defaultSearchResponder`) -- not a search
   * engine. Tests that need specific candidates should supply their own. */
  respondToSearch?: MockResearchSearchResponder;
  /** Called once per `fetch()` call, ONLY when the locator passes the
   * SSRF/blocked-locator check -- a responder never sees a blocked
   * locator, so it cannot accidentally override that protection. */
  respondToFetch?: MockResearchFetchResponder;
  generateId?: (prefix: string) => string;
  now?: () => string;
}

/** Loopback/private/link-local hosts and non-http(s) schemes -- never
 * fetched, even by a mock. A REAL provider would need the equivalent
 * (plus DNS-rebinding/redirect re-checks, which are that provider's own
 * responsibility -- this mock never redirects). Deliberately simple
 * string/regex checks, not a full URL-parsing security library: P21 does
 * not ship a real fetcher, so this exists to PROVE the contract, not to be
 * a production-grade SSRF filter. */
function isBlockedLocator(locator: string): boolean {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return true; // not even a valid URL -- never fetchable
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host)) return true; // 127.0.0.0/8
  if (/^10\./.test(host)) return true; // 10.0.0.0/8
  if (/^192\.168\./.test(host)) return true; // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true; // 172.16.0.0/12
  if (/^169\.254\./.test(host)) return true; // link-local
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  return false;
}

function defaultSearchResponder(request: ResearchSearchRequest): MockResearchSearchOutcome {
  return {
    results: [
      createResearchSourceCandidate({
        locator: `https://mock-research.example.com/search?q=${encodeURIComponent(request.query)}`,
        title: `Result for: ${request.query}`,
        sourceType: request.preferredSourceTypes[0] ?? "web_page",
        snippet: `A deterministic mock search result for the query "${request.query}".`
      })
    ]
  };
}

function defaultFetchResponder(request: ResearchFetchRequest, now: () => string): MockResearchFetchOutcome {
  return {
    content: createResearchFetchContent({
      locator: request.locator,
      title: `Content for ${request.locator}`,
      sourceType: "web_page",
      retrievedAt: now(),
      excerpt: `A deterministic mock excerpt retrieved for "${request.locator}".`
    })
  };
}

/**
 * `generate()`-equivalent boundary: never throws for an expected failure
 * (a `respond*` callback throwing, or explicitly returning `{error}`) --
 * both become a structured `status: "error"` result, the same "never
 * throw" discipline `createMockModelProvider` already established.
 */
export function createMockResearchProvider(options: MockResearchProviderOptions = {}): ResearchProvider {
  const providerId = options.providerId ?? "mock-research";
  const respondToSearch = options.respondToSearch ?? defaultSearchResponder;
  const respondToFetch = options.respondToFetch ?? ((request: ResearchFetchRequest) => defaultFetchResponder(request, now));
  const generateId = options.generateId ?? createDeterministicIdGenerator();
  const now = options.now ?? createDeterministicClock();

  const descriptor = createResearchProviderDescriptor({ providerId, name: "Mock Research Provider", version: "0.0.1" });

  return {
    describe: () => descriptor,

    async search(request: ResearchSearchRequest): Promise<ResearchSearchInvocationResult> {
      const startedAt = now();
      let outcome: MockResearchSearchOutcome;
      try {
        outcome = respondToSearch(request);
      } catch (error) {
        return createResearchSearchInvocationResult({
          id: generateId(SEARCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: { kind: "provider_error", message: error instanceof Error ? error.message : String(error) },
          startedAt,
          completedAt: now()
        });
      }
      if ("error" in outcome) {
        return createResearchSearchInvocationResult({
          id: generateId(SEARCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: outcome.error,
          startedAt,
          completedAt: now()
        });
      }
      try {
        return createResearchSearchInvocationResult({
          id: generateId(SEARCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "success",
          results: outcome.results.slice(0, request.maxResults),
          startedAt,
          completedAt: now()
        });
      } catch (error) {
        return createResearchSearchInvocationResult({
          id: generateId(SEARCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: { kind: "malformed_result", message: error instanceof Error ? error.message : String(error) },
          startedAt,
          completedAt: now()
        });
      }
    },

    async fetch(request: ResearchFetchRequest): Promise<ResearchFetchInvocationResult> {
      const startedAt = now();
      if (isBlockedLocator(request.locator)) {
        return createResearchFetchInvocationResult({
          id: generateId(FETCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: { kind: "blocked_locator", message: `Locator "${request.locator}" is not fetchable (private/loopback network or unsupported scheme)` },
          startedAt,
          completedAt: now()
        });
      }
      let outcome: MockResearchFetchOutcome;
      try {
        outcome = respondToFetch(request);
      } catch (error) {
        return createResearchFetchInvocationResult({
          id: generateId(FETCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: { kind: "provider_error", message: error instanceof Error ? error.message : String(error) },
          startedAt,
          completedAt: now()
        });
      }
      if ("error" in outcome) {
        return createResearchFetchInvocationResult({
          id: generateId(FETCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: outcome.error,
          startedAt,
          completedAt: now()
        });
      }
      try {
        return createResearchFetchInvocationResult({
          id: generateId(FETCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "success",
          content: outcome.content,
          startedAt,
          completedAt: now()
        });
      } catch (error) {
        return createResearchFetchInvocationResult({
          id: generateId(FETCH_RESULT_PREFIX),
          requestId: request.id,
          providerId,
          status: "error",
          error: { kind: "malformed_result", message: error instanceof Error ? error.message : String(error) },
          startedAt,
          completedAt: now()
        });
      }
    }
  };
}
