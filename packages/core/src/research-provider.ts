import type {
  ResearchFetchInvocationResult,
  ResearchFetchRequest,
  ResearchProviderDescriptor,
  ResearchSearchInvocationResult,
  ResearchSearchRequest
} from "@naqsh/schemas";

/**
 * The ONE way anything in this repo is allowed to reach an external
 * knowledge source (P21). Lives in core, not a provider package, for the
 * EXACT same reason `ModelProvider` (P7) and `EnvironmentAdapter` (P5) do:
 * core CONSUMES this abstraction and must be able to name the type without
 * depending on a concrete search engine, HTTP client, or scraping library.
 * The mock implementation (used by every test in this repo) lives in
 * `@naqsh/adapters`, strictly "below" this boundary and depending ON core/
 * schemas, never the reverse -- enforced as a repo-boundaries regression
 * test, exactly like the environment-adapter and model-provider boundaries.
 *
 * P21 brief Section 10's own instruction: "The core should not depend
 * directly on a particular search engine / website / HTTP library /
 * browser / vendor." This interface is that boundary. No concrete provider
 * implementation ships in this phase beyond the deterministic mock -- see
 * `packages/adapters/src/mock-research-provider.ts`'s own doc comment for
 * why a REAL live-web provider is deliberately out of scope for P21 (brief
 * Section 11: "Do NOT build a web-scraping monster").
 *
 * Two operations, matching the brief's own conceptual split (Section 3/9):
 *   `search()` -- "what sources might answer this query" -- returns
 *                 lightweight CANDIDATES (title/publisher/type/snippet),
 *                 never full content. Nothing returned by `search()` is
 *                 trustworthy enough to cite yet.
 *   `fetch()`  -- "get the actual (bounded) content for ONE specific
 *                 locator" -- the only operation that reaches for real
 *                 content, and even then returns a BOUNDED excerpt, never
 *                 an unbounded document (see `ResearchFetchContent.excerpt`'s
 *                 own doc comment in research-types.ts).
 * Neither method ever returns a `Source`/`ResearchEvidence` directly --
 * those are World Model entities, minted only by `add_source`/`add_evidence`
 * (core tools) after a human/agent explicitly accepts a candidate. A
 * `ResearchProvider` implementation has no path to `WorldModelState`, no
 * `ToolRegistry` reference, and no authority to decide anything is true.
 *
 * Never throws for an EXPECTED failure (provider down, rate-limited,
 * malformed upstream result, blocked locator) -- the same discipline
 * `ModelProvider.generate()`/`EnvironmentAdapter`'s own operations already
 * established: a caller branches on `result.status`, never wraps every
 * call in try/catch. `describe()` is the one synchronous, static exception.
 *
 * Authorization boundary: this interface has no concept of `AutonomyLevel`/
 * `Approval`/`AutonomyGrant`, and no implementation may import P4's
 * authorization machinery (enforced in repo-boundaries.test.ts) -- a
 * research provider is a dumb request/response mechanism, never a policy
 * decision point. Permission is enforced one layer up, by the
 * `research_search`/`research_fetch` TOOLS (P3/P4), exactly like every
 * other external side effect in this codebase.
 */
export interface ResearchProvider {
  /** Static identity + capabilities. Cannot fail. */
  describe(): ResearchProviderDescriptor;

  /** Find candidate sources for a query. Returns lightweight metadata + a
   * bounded snippet per candidate -- never full content, never something
   * directly usable as `ResearchEvidence`. */
  search(request: ResearchSearchRequest): Promise<ResearchSearchInvocationResult>;

  /** Retrieve bounded content for ONE specific locator (typically one
   * `ResearchSourceCandidate.locator` a caller decided is worth pursuing
   * further). */
  fetch(request: ResearchFetchRequest): Promise<ResearchFetchInvocationResult>;
}
