import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResearchFetchRequest, createResearchSearchRequest } from "@naqsh/schemas";
import { createHttpResearchProvider, type HttpResearchProviderOptions } from "../src/http-research-provider.js";

/**
 * `createHttpResearchProvider` is a REAL implementation (real SSRF/DNS/
 * redirect/size/content-type guards) -- every test here injects `fetchImpl`
 * (and `lookupImpl` where relevant) as a hand-built fake, exactly like
 * `gemini-model-provider.test.ts` injects `generateContent`: no test in
 * this file makes a real network call or a real DNS query.
 */

const PUBLIC_LOOKUP: HttpResearchProviderOptions["lookupImpl"] = async () => [{ address: "93.184.216.34" }]; // a public-looking address

function textResponse(body: string, contentType = "text/plain", status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": contentType, ...headers } });
}

describe("createHttpResearchProvider: search() is honestly unavailable, never fabricated", () => {
  it("always returns a well-formed error result -- no open-web search backend is configured", async () => {
    const provider = createHttpResearchProvider();
    const result = await provider.search(createResearchSearchRequest({ query: "6061-T6 aluminum yield strength" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "provider_unavailable");
    assert.equal(result.results, null);
  });
});

describe("createHttpResearchProvider: fetch() SSRF/scheme guards -- rejected before any fetchImpl call", () => {
  const cases: Array<{ label: string; locator: string }> = [
    { label: "not a URL at all", locator: "not a url" },
    { label: "file:// scheme", locator: "file:///etc/passwd" },
    { label: "javascript: scheme", locator: "javascript:alert(1)" },
    { label: "localhost", locator: "http://localhost:3001/admin" },
    { label: "loopback IPv4", locator: "http://127.0.0.1/" },
    { label: "loopback IPv6", locator: "http://[::1]/" },
    { label: "private 10.x", locator: "http://10.0.0.5/" },
    { label: "private 192.168.x", locator: "http://192.168.1.1/" },
    { label: "private 172.16-31.x", locator: "http://172.20.0.1/" },
    { label: "link-local", locator: "http://169.254.169.254/latest/meta-data/" },
    { label: ".internal hostname", locator: "http://service.internal/" },
    { label: ".local hostname", locator: "http://printer.local/" }
  ];

  for (const { label, locator } of cases) {
    it(`rejects ${label} ("${locator}") as blocked_locator, and never calls fetchImpl`, async () => {
      let called = false;
      const provider = createHttpResearchProvider({
        fetchImpl: async () => {
          called = true;
          return textResponse("should never be reached");
        }
      });
      const result = await provider.fetch(createResearchFetchRequest({ locator }));
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "blocked_locator");
      assert.equal(called, false, "a blocked locator must be rejected before any network call is attempted");
    });
  }

  it("rejects a public-looking hostname that resolves to a private IP (DNS-rebinding guard)", async () => {
    let called = false;
    const provider = createHttpResearchProvider({
      fetchImpl: async () => {
        called = true;
        return textResponse("should never be reached");
      },
      lookupImpl: async () => [{ address: "192.168.1.50" }]
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://looks-public.example.com/doc" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "blocked_locator");
    assert.equal(called, false);
  });

  it("refuses rather than guesses when DNS resolution itself fails", async () => {
    const provider = createHttpResearchProvider({
      fetchImpl: async () => textResponse("unreachable"),
      lookupImpl: async () => {
        throw new Error("ENOTFOUND");
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://nonexistent.example.invalid/doc" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "blocked_locator");
  });
});

describe("createHttpResearchProvider: fetch() success path -- real content mapping", () => {
  it("returns a bounded excerpt with HTML stripped, a real title, and a content hash", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async () => textResponse("<html><head><title>Yield Strength Datasheet</title></head><body><script>evil()</script><p>6061-T6 has a yield strength of 276 MPa.</p></body></html>", "text/html; charset=utf-8")
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/datasheet" }));
    assert.equal(result.status, "success");
    assert.equal(result.content?.title, "Yield Strength Datasheet");
    assert.match(result.content!.excerpt, /276 MPa/);
    assert.doesNotMatch(result.content!.excerpt, /evil\(\)/, "script content must never leak into the excerpt");
    assert.doesNotMatch(result.content!.excerpt, /<[a-z]/i, "HTML tags must be stripped");
    assert.equal(typeof result.content?.contentHash, "string");
    assert.equal(result.content?.contentHash?.length, 64, "sha256 hex digest");
  });

  it("truncates an oversized excerpt to MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH rather than rejecting it", async () => {
    const longBody = "a".repeat(10_000);
    const provider = createHttpResearchProvider({ lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => textResponse(longBody, "text/plain") });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/long-doc" }));
    assert.equal(result.status, "success");
    assert.ok(result.content!.excerpt.length <= 4000);
  });

  it("re-validates a redirect target from scratch and follows it when safe", async () => {
    let calls = 0;
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async (input) => {
        calls++;
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.com/redirect-source") {
          return new Response(null, { status: 302, headers: { location: "https://example.com/final" } });
        }
        return textResponse("final content here", "text/plain");
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/redirect-source" }));
    assert.equal(result.status, "success");
    assert.equal(result.content?.locator, "https://example.com/final");
    assert.equal(calls, 2);
  });

  it("refuses to follow a redirect INTO a blocked address", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.com/redirect-to-internal") {
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
        }
        return textResponse("should never be reached");
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/redirect-to-internal" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "blocked_locator");
  });

  it("rejects a disallowed content-type (e.g. a binary download) without buffering the body", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async () => textResponse("binary-ish", "application/octet-stream")
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/file.bin" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_request");
  });

  it("enforces the response-size cap while streaming, not after buffering the whole body", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      maxResponseBytes: 10,
      fetchImpl: async () => textResponse("this body is definitely longer than ten bytes", "text/plain")
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/huge" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_request");
  });

  it("maps a non-2xx response to a real error, with rate_limit distinguished from a generic provider_error", async () => {
    const rateLimited = createHttpResearchProvider({ lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => new Response(null, { status: 429 }) });
    const rateLimitedResult = await rateLimited.fetch(createResearchFetchRequest({ locator: "https://example.com/limited" }));
    assert.equal(rateLimitedResult.error?.kind, "rate_limit");

    const notFound = createHttpResearchProvider({ lookupImpl: PUBLIC_LOOKUP, fetchImpl: async () => new Response(null, { status: 404 }) });
    const notFoundResult = await notFound.fetch(createResearchFetchRequest({ locator: "https://example.com/missing" }));
    assert.equal(notFoundResult.error?.kind, "provider_error");
  });

  it("maps a timeout (AbortError) to kind: timeout, never a generic failure", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      timeoutMs: 5,
      fetchImpl: async (_input, init) => {
        return new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
    });
    const result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/slow" }));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "timeout");
  });

  it("never throws for a genuinely broken fetchImpl -- always resolves to a structured error", async () => {
    const provider = createHttpResearchProvider({
      lookupImpl: PUBLIC_LOOKUP,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      }
    });
    let result;
    try {
      result = await provider.fetch(createResearchFetchRequest({ locator: "https://example.com/broken" }));
    } catch {
      assert.fail("fetch() must never throw/reject for an expected failure mode");
    }
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "provider_unavailable");
  });
});
