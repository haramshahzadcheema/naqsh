import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  createId,
  createResearchFetchContent,
  createResearchFetchInvocationResult,
  createResearchProviderDescriptor,
  createResearchSearchInvocationResult,
  MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH,
  type ResearchFetchInvocationResult,
  type ResearchFetchRequest,
  type ResearchProviderError,
  type ResearchSearchInvocationResult,
  type ResearchSearchRequest
} from "@naqsh/schemas";
import type { ResearchProvider } from "@naqsh/core";

/**
 * A REAL `ResearchProvider` (P21's boundary, unmodified) -- the one this
 * repository was missing entirely: `mock-research-provider.ts`'s own doc
 * comment explains why P21 shipped no live implementation, but the
 * NEXT-MAJOR-PHASE brief asks specifically for a genuine, SSRF-hardened
 * fetch of a SPECIFIC locator (never a fabricated one), while leaving
 * open-web SEARCH honestly unavailable until a real search-engine API key
 * is configured -- see `search()` below.
 *
 * Security posture (Part 30/21 of the brief):
 *   - scheme allowlist (http/https only)
 *   - private/loopback/link-local/reserved IPv4+IPv6 ranges blocked, both
 *     for a literal IP locator AND for a resolved hostname (best-effort
 *     DNS-rebinding guard -- see `resolvesToBlockedAddress`'s own doc
 *     comment for the honest limit of what this can guarantee without
 *     socket-level control over which resolved address `fetch()` connects
 *     to)
 *   - every redirect hop is re-validated from scratch against the SAME
 *     checks (never followed blindly)
 *   - a hard response-size cap, enforced while streaming (never buffers
 *     an unbounded body before checking)
 *   - a content-type allowlist (text-ish documents only)
 *   - a request timeout
 *   - the returned excerpt is bounded to
 *     `MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH`, exactly like the mock
 *     provider's contract already requires
 *
 * External fetched content is DATA, never instructions: this file returns
 * plain `ResearchFetchContent` (title/excerpt/hash) — nothing here ever
 * evaluates, executes, or treats fetched text as anything other than a
 * string to bound and hand back. Prompt-injection resistance is the
 * caller's concern (the model only ever sees this excerpt as inert
 * `ModelRequest` context, never as an instruction channel) — unchanged by
 * this file.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000; // 2 MB
const MAX_REDIRECTS = 5;
const ALLOWED_CONTENT_TYPE_PATTERNS = [/^text\//i, /^application\/json/i, /^application\/xml/i, /^application\/xhtml\+xml/i];
const USER_AGENT = "NaqshResearchBot/1.0 (+server-side fetch; single-locator only, no crawling)";

function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    if (ip === "0.0.0.0") return true;
    if (/^127\./.test(ip)) return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
    if (/^169\.254\./.test(ip)) return true;
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true; // unique local (fc00::/7)
    if (lower.startsWith("::ffff:")) {
      const embedded = lower.slice("::ffff:".length);
      if (isIP(embedded) === 4) return isPrivateOrReservedIp(embedded);
    }
    return false;
  }
  return true; // not a recognizable IP literal at all -- refuse rather than guess
}

function blockedByShape(locator: string): { blocked: true; reason: string } | { blocked: false; url: URL } {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    return { blocked: true, reason: `"${locator}" is not a valid URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { blocked: true, reason: `unsupported scheme "${url.protocol}" -- only http/https are fetchable` };
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return { blocked: true, reason: "localhost is not fetchable" };
  if (host.endsWith(".internal") || host.endsWith(".local")) return { blocked: true, reason: `internal/local hostname "${host}" is not fetchable` };
  if (isIP(host) && isPrivateOrReservedIp(host)) return { blocked: true, reason: `"${host}" is a private/reserved IP address` };
  return { blocked: false, url };
}

/**
 * Best-effort DNS-rebinding guard: a PUBLIC-looking hostname can still
 * resolve to a private IP. Resolves the hostname and re-checks every
 * returned address. HONEST LIMIT: Node's global `fetch()` does its own
 * DNS resolution internally, and this file has no way to force it to
 * connect to the SPECIFIC address already validated here (that requires a
 * custom low-level Agent/dispatcher this implementation does not attempt)
 * -- so there remains a narrow TOCTOU window if an attacker's DNS server
 * changes the answer between this check and `fetch()`'s own resolution a
 * moment later. This narrows the attack surface; it does not eliminate it.
 */
type LookupImpl = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupImpl = (hostname) => lookup(hostname, { all: true });

async function resolvesToBlockedAddress(hostname: string, lookupImpl: LookupImpl): Promise<boolean> {
  if (isIP(hostname)) return isPrivateOrReservedIp(hostname);
  try {
    const records = await lookupImpl(hostname);
    return records.some((record) => isPrivateOrReservedIp(record.address));
  } catch {
    return true; // DNS failure -- refuse rather than guess what it would have resolved to
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(body: string, isHtml: boolean, fallback: string): string {
  if (isHtml) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const raw = match?.[1]?.replace(/\s+/g, " ").trim();
    if (raw) return raw.slice(0, 300);
  }
  return fallback;
}

interface FetchedDocument {
  body: string;
  contentType: string;
  finalUrl: string;
}

type FetchOutcome = { status: "success"; document: FetchedDocument } | { status: "error"; error: ResearchProviderError };

export interface HttpResearchProviderOptions {
  providerId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Injectable seam for tests -- defaults to the real global `fetch()`.
   * Same discipline as `GeminiModelProviderDependencies.generateContent`:
   * production code never passes this. */
  fetchImpl?: typeof fetch;
  /** Injectable seam for tests -- defaults to a real `dns.lookup`. Never
   * passed in production; lets a test exercise the DNS-rebinding guard
   * (and every other code path) without making a real DNS query. */
  lookupImpl?: LookupImpl;
  generateId?: (prefix: string) => string;
  now?: () => string;
}

async function fetchWithGuards(
  startLocator: string,
  options: Required<Pick<HttpResearchProviderOptions, "timeoutMs" | "maxResponseBytes" | "fetchImpl">> & { lookupImpl: LookupImpl }
): Promise<FetchOutcome> {
  let currentLocator = startLocator;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const shape = blockedByShape(currentLocator);
    if (shape.blocked) return { status: "error", error: { kind: "blocked_locator", message: shape.reason } };

    if (await resolvesToBlockedAddress(shape.url.hostname, options.lookupImpl)) {
      return { status: "error", error: { kind: "blocked_locator", message: `"${shape.url.hostname}" resolves to a private/reserved address` } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await options.fetchImpl(shape.url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1" } });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "error", error: { kind: "timeout", message: `Request to "${currentLocator}" timed out after ${options.timeoutMs}ms` } };
      }
      return { status: "error", error: { kind: "provider_unavailable", message: error instanceof Error ? error.message : String(error) } };
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { status: "error", error: { kind: "provider_error", message: `Redirect from "${currentLocator}" had no Location header` } };
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, shape.url);
      } catch {
        return { status: "error", error: { kind: "malformed_result", message: `Redirect target "${location}" from "${currentLocator}" is not a valid URL` } };
      }
      currentLocator = nextUrl.toString();
      continue;
    }

    if (!response.ok) {
      const kind = response.status === 429 ? "rate_limit" : "provider_error";
      return { status: "error", error: { kind, message: `"${currentLocator}" responded with HTTP ${response.status}` } };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!ALLOWED_CONTENT_TYPE_PATTERNS.some((pattern) => pattern.test(contentType))) {
      return { status: "error", error: { kind: "invalid_request", message: `Content-Type "${contentType || "(none)"}" from "${currentLocator}" is not a supported document type` } };
    }

    if (!response.body) {
      return { status: "error", error: { kind: "malformed_result", message: `"${currentLocator}" returned no body` } };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > options.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        return { status: "error", error: { kind: "invalid_request", message: `Response from "${currentLocator}" exceeded the ${options.maxResponseBytes}-byte fetch limit` } };
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
    return { status: "success", document: { body, contentType, finalUrl: currentLocator } };
  }

  return { status: "error", error: { kind: "provider_error", message: `Too many redirects fetching "${startLocator}"` } };
}

export function createHttpResearchProvider(options: HttpResearchProviderOptions = {}): ResearchProvider {
  const providerId = options.providerId ?? "http-research";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const generateId = options.generateId ?? ((prefix: string) => createId(prefix));
  const now = options.now ?? (() => new Date().toISOString());

  const descriptor = createResearchProviderDescriptor({
    providerId,
    name: "HTTP Research Provider (single-locator fetch, no search backend)",
    version: "0.1.0"
  });

  return {
    describe: () => descriptor,

    async search(request: ResearchSearchRequest): Promise<ResearchSearchInvocationResult> {
      const startedAt = now();
      // No open-web search backend is configured on this server (that
      // would need a real search-engine API key) -- an HONEST
      // "unavailable," never fabricated candidates. A real search API can
      // be wired in later behind this SAME ResearchProvider interface.
      return createResearchSearchInvocationResult({
        id: generateId("researchsearchinv"),
        requestId: request.id,
        providerId,
        status: "error",
        error: { kind: "provider_unavailable", message: "Open-web search is not configured on this server. Fetch a specific URL instead of searching." },
        startedAt,
        completedAt: now()
      });
    },

    async fetch(request: ResearchFetchRequest): Promise<ResearchFetchInvocationResult> {
      const startedAt = now();
      const outcome = await fetchWithGuards(request.locator, { timeoutMs, maxResponseBytes, fetchImpl, lookupImpl });
      if (outcome.status === "error") {
        return createResearchFetchInvocationResult({
          id: generateId("researchfetchinv"),
          requestId: request.id,
          providerId,
          status: "error",
          error: outcome.error,
          startedAt,
          completedAt: now()
        });
      }

      const { body, contentType, finalUrl } = outcome.document;
      const isHtml = /html/i.test(contentType);
      const excerpt = (isHtml ? stripHtml(body) : body).slice(0, MAX_RESEARCH_EVIDENCE_EXCERPT_LENGTH);
      const title = extractTitle(body, isHtml, finalUrl);
      const contentHash = createHash("sha256").update(body).digest("hex");

      try {
        const content = createResearchFetchContent({
          locator: finalUrl,
          title,
          sourceType: "web_page",
          publisher: null,
          publishedAt: null,
          retrievedAt: now(),
          excerpt,
          contentHash
        });
        return createResearchFetchInvocationResult({
          id: generateId("researchfetchinv"),
          requestId: request.id,
          providerId,
          status: "success",
          content,
          startedAt,
          completedAt: now()
        });
      } catch (error) {
        return createResearchFetchInvocationResult({
          id: generateId("researchfetchinv"),
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
