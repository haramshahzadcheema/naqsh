import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWorldModelState,
  type ResearchFetchInvocationResult,
  type ResearchProviderDescriptor,
  type ResearchSearchInvocationResult,
  type WorldModelState
} from "@naqsh/schemas";
import { createResearchSearchTool } from "../src/research-search-tool.js";
import { createResearchFetchTool } from "../src/research-fetch-tool.js";
import { createAddSourceTool } from "../src/add-source-tool.js";
import { createAddEvidenceTool } from "../src/add-evidence-tool.js";
import { createChangeHistory } from "../src/change-history.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { ResearchProvider } from "../src/research-provider.js";

/** A minimal, hand-built fake `ResearchProvider` -- `packages/core` has no
 * dependency on `@naqsh/adapters` (enforced in repo-boundaries.test.ts),
 * matching `create-environment-object-tool.test.ts`'s identical
 * "test-local fake, not the real package" precedent. Not deterministic-
 * clock-based like the real mock (no need here -- these tests only check
 * tool-boundary behavior, never provider content determinism). */
interface FakeResearchProviderOptions {
  respondToSearch?: (query: string) => { results: ResearchSearchInvocationResult["results"] } | { error: NonNullable<ResearchSearchInvocationResult["error"]> };
  respondToFetch?: (locator: string) => { content: NonNullable<ResearchFetchInvocationResult["content"]> } | { error: NonNullable<ResearchFetchInvocationResult["error"]> };
}

function buildFakeResearchProvider(options: FakeResearchProviderOptions = {}): ResearchProvider {
  const descriptor: ResearchProviderDescriptor = { providerId: "fake", name: "Fake Research Provider", version: "0.0.1", metadata: {} };
  const now = () => new Date().toISOString();

  return {
    describe: () => descriptor,
    async search(request) {
      const startedAt = now();
      const outcome = options.respondToSearch
        ? options.respondToSearch(request.query)
        : { results: [{ locator: null, title: `Result for: ${request.query}`, publisher: null, sourceType: "web_page" as const, publishedAt: null, snippet: `snippet for ${request.query}` }] };
      if ("error" in outcome) {
        return { id: `researchsearchinv_${Math.random()}`, requestId: request.id, providerId: descriptor.providerId, status: "error", results: null, error: outcome.error, startedAt, completedAt: now(), metadata: {} };
      }
      return { id: `researchsearchinv_${Math.random()}`, requestId: request.id, providerId: descriptor.providerId, status: "success", results: outcome.results, error: null, startedAt, completedAt: now(), metadata: {} };
    },
    async fetch(request) {
      const startedAt = now();
      const outcome = options.respondToFetch
        ? options.respondToFetch(request.locator)
        : { content: { locator: request.locator, title: `Content for ${request.locator}`, publisher: null, sourceType: "web_page" as const, publishedAt: null, retrievedAt: now(), excerpt: `excerpt for ${request.locator}`, contentHash: null } };
      if ("error" in outcome) {
        return { id: `researchfetchinv_${Math.random()}`, requestId: request.id, providerId: descriptor.providerId, status: "error", content: null, error: outcome.error, startedAt, completedAt: now(), metadata: {} };
      }
      return { id: `researchfetchinv_${Math.random()}`, requestId: request.id, providerId: descriptor.providerId, status: "success", content: outcome.content, error: null, startedAt, completedAt: now(), metadata: {} };
    }
  };
}

function buildHarness(providerOptions: FakeResearchProviderOptions = {}) {
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const provider = buildFakeResearchProvider(providerOptions);
  const search = createResearchSearchTool(provider);
  const fetch = createResearchFetchTool(provider);
  const addSource = createAddSourceTool(() => state, (next) => { state = next; }, history);
  const addEvidence = createAddEvidenceTool(() => state, (next) => { state = next; }, history);
  registry.register(search.tool, search.handler);
  registry.register(fetch.tool, fetch.handler);
  registry.register(addSource.tool, addSource.handler);
  registry.register(addEvidence.tool, addEvidence.handler);
  return { registry, history, getState: () => state };
}

describe("research_search / research_fetch: identity and classification", () => {
  it("both are classified suggest/research -- an external side effect, but never a World Model write", () => {
    const { registry } = buildHarness();
    const search = registry.getByName("research_search")!;
    const fetch = registry.getByName("research_fetch")!;
    assert.equal(search.mutation, "suggest");
    assert.equal(search.target, "research");
    assert.equal(fetch.mutation, "suggest");
    assert.equal(fetch.target, "research");
  });
});

describe("Test 2: mock provider search (via research_search tool)", () => {
  it("returns candidate sources for a query, never a Source", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "6061-T6 aluminum yield strength" } });
    assert.equal(result.status, "success");
    const output = result.output as { results: unknown[] };
    assert.equal(output.results.length, 1);
    // A tool that only "suggests" never mutates WorldModelState.
    assert.deepEqual(getState(), before);
  });

  it("rejects a missing query", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "research_search", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("surfaces a provider error as execution_failure", async () => {
    const { registry } = buildHarness({ respondToSearch: () => ({ error: { kind: "provider_unavailable", message: "simulated outage" } }) });
    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });
});

describe("Test 3: mock provider fetch (via research_fetch tool)", () => {
  it("returns bounded content for a locator", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "research_fetch", input: { locator: "https://example.com/datasheet.pdf" } });
    assert.equal(result.status, "success");
    const output = result.output as { content: { locator: string } };
    assert.equal(output.content.locator, "https://example.com/datasheet.pdf");
    assert.deepEqual(getState(), before);
  });

  it("rejects a missing locator", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "research_fetch", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("surfaces whatever error kind a provider reports for a locator it chooses to block (SSRF/private-network protection itself is a PROVIDER responsibility, exhaustively covered by packages/adapters/test/mock-research-provider.test.ts's 13 blocked-locator cases -- Test 18)", async () => {
    const { registry } = buildHarness({ respondToFetch: () => ({ error: { kind: "blocked_locator", message: "blocked" } }) });
    const { result } = await executeTool(registry, { toolName: "research_fetch", input: { locator: "http://127.0.0.1/secret" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /blocked/);
  });
});

describe("add_source: identity, classification, and successful acceptance", () => {
  it("is classified mutate/world_model", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("add_source")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "world_model");
  });

  it("Test 5: adds a source, preserving source metadata (title/publisher/locator/sourceType)", async () => {
    const { registry, getState, history } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "add_source",
      input: { locator: "https://acme.example.com/datasheet.pdf", title: "6061-T6 Datasheet", publisher: "Acme Metals", sourceType: "datasheet" }
    });
    assert.equal(result.status, "success");
    const added = getState().project.sources.at(-1)!;
    assert.equal(added.title, "6061-T6 Datasheet");
    assert.equal(added.publisher, "Acme Metals");
    assert.equal(added.locator, "https://acme.example.com/datasheet.pdf");
    assert.equal(added.sourceType, "datasheet");
    assert.equal(history.list().length, 1);
    assert.equal(history.list()[0]!.transitionKind, "add_source");
  });

  it("rejects a missing title", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_source", input: { sourceType: "datasheet" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });

  it("rejects an invalid sourceType", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "not_a_real_type" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });

  it("defaults provenance to 'research' when not supplied", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "web_page" } });
    assert.equal(getState().project.sources.at(-1)!.source, "research");
  });

  it("REGRESSION: a human-provided citation is recorded with provenance:'human', not silently stamped 'research' (brief Section 18 -- user-provided sources must be traceable AS user-provided)", async () => {
    const { registry, getState } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "add_source",
      input: { title: "Handwritten datasheet citation", sourceType: "user_provided", provenance: "human" }
    });
    assert.equal(result.status, "success");
    assert.equal(getState().project.sources.at(-1)!.source, "human");
  });

  it("rejects an invalid provenance value", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "web_page", provenance: "not_a_real_source" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });
});

describe("add_evidence: Test 6/Test 10: evidence creation + provenance", () => {
  it("adds evidence referencing an existing source, with research provenance", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "6061-T6 Datasheet", sourceType: "datasheet" } });
    const source = getState().project.sources.at(-1)!;

    const { result } = await executeTool(registry, {
      toolName: "add_evidence",
      input: { sourceId: source.id, claim: "6061-T6 aluminum has a yield strength of approximately 276 MPa.", excerpt: "Typical yield strength: 276 MPa." }
    });
    assert.equal(result.status, "success");
    const evidence = getState().project.researchEvidence.at(-1)!;
    assert.equal(evidence.sourceId, source.id);
    assert.equal(evidence.claim, "6061-T6 aluminum has a yield strength of approximately 276 MPa.");
    assert.equal(evidence.source, "research");
  });

  it("Test 15: rejects an evidence record referencing a source that does not exist in the project", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_evidence", input: { sourceId: "src_does_not_exist", claim: "some claim" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /unknown_source/);
    assert.deepEqual(getState(), before);
  });

  it("rejects an empty claim", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "web_page" } });
    const source = getState().project.sources.at(-1)!;
    const { result } = await executeTool(registry, { toolName: "add_evidence", input: { sourceId: source.id, claim: "" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("REGRESSION: a human-provided claim is recorded with provenance:'human', not silently stamped 'research'", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "user_provided", provenance: "human" } });
    const source = getState().project.sources.at(-1)!;
    const { result } = await executeTool(registry, {
      toolName: "add_evidence",
      input: { sourceId: source.id, claim: "Stated by the engineer directly, not researched.", provenance: "human" }
    });
    assert.equal(result.status, "success");
    assert.equal(getState().project.researchEvidence.at(-1)!.source, "human");
  });

  it("rejects an invalid provenance value", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "x", sourceType: "web_page" } });
    const source = getState().project.sources.at(-1)!;
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_evidence", input: { sourceId: source.id, claim: "x", provenance: "not_a_real_source" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
  });
});

describe("Test 7/8/9: evidence -> claim -> requirement/decision traceability (reuses the EXISTING add_relationship transition, P8 -- no dedicated tool wraps it yet, so this exercises the same updateWorldModel path add_relationship's own transitions.test.ts coverage does)", () => {
  it("evidence supporting a requirement is expressed as a real, queryable EntityRelationship", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "6061-T6 Datasheet", sourceType: "datasheet" } });
    const source = getState().project.sources.at(-1)!;
    await executeTool(registry, { toolName: "add_evidence", input: { sourceId: source.id, claim: "Yield strength ~276 MPa" } });
    const evidence = getState().project.researchEvidence.at(-1)!;

    const { updateWorldModel } = await import("../src/index.js");
    const withRequirement = updateWorldModel(getState(), {
      kind: "add_requirement",
      requirement: { description: "Must support 500 N", category: "load", value: 500, unit: "N" }
    });
    const requirement = withRequirement.project.requirements.at(-1)!;
    const linked = updateWorldModel(withRequirement, {
      kind: "add_relationship",
      relationship: { type: "supports", sourceType: "research_evidence", sourceId: evidence.id, targetType: "requirement", targetId: requirement.id }
    });

    const relationship = linked.project.relationships.at(-1)!;
    assert.equal(relationship.sourceType, "research_evidence");
    assert.equal(relationship.sourceId, evidence.id);
    assert.equal(relationship.targetType, "requirement");
    assert.equal(relationship.targetId, requirement.id);
  });

  it("evidence supporting a decision is expressed the same way -- 'why does NAQSH believe this?' is answerable by walking relationships", async () => {
    const { registry, getState } = buildHarness();
    await executeTool(registry, { toolName: "add_source", input: { title: "6061-T6 Datasheet", sourceType: "datasheet" } });
    const source = getState().project.sources.at(-1)!;
    await executeTool(registry, { toolName: "add_evidence", input: { sourceId: source.id, claim: "Yield strength ~276 MPa, sufficient for the 500 N load." } });
    const evidence = getState().project.researchEvidence.at(-1)!;

    const { updateWorldModel } = await import("../src/index.js");
    const withDecision = updateWorldModel(getState(), {
      kind: "add_decision",
      decision: { statement: "Use 6061-T6 aluminum", reason: "Meets required strength and is readily available." }
    });
    const decision = withDecision.project.decisions.at(-1)!;
    const linked = updateWorldModel(withDecision, {
      kind: "add_relationship",
      relationship: { type: "supports", sourceType: "research_evidence", sourceId: evidence.id, targetType: "decision", targetId: decision.id }
    });

    const relationship = linked.project.relationships.at(-1)!;
    assert.equal(relationship.sourceId, evidence.id);
    assert.equal(relationship.targetId, decision.id);
    // The chain is fully walkable from the decision back to the source:
    // decision <- (relationship) <- evidence -> sourceId -> source.
    const evidenceRecord = linked.project.researchEvidence.find((e) => e.id === relationship.sourceId)!;
    const sourceRecord = linked.project.sources.find((s) => s.id === evidenceRecord.sourceId)!;
    assert.equal(sourceRecord.id, source.id);
  });
});

describe("Test 12/13: Phase 4 permission boundary applies to add_source/add_evidence exactly like add_requirement", () => {
  it("unauthorized add_source is rejected with policy_rejected and mutates nothing", async () => {
    const { registry, getState } = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "add_source",
      input: { title: "x", sourceType: "web_page" },
      target: { entityType: "source", entityId: null },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });

  it("approved add_source executes for real", async () => {
    const { registry, getState } = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "add_source", targetType: "source", targetId: null, reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "add_source",
      input: { title: "x", sourceType: "web_page" },
      target: { entityType: "source", entityId: null },
      authorize
    });
    assert.equal(result.status, "success");
    assert.equal(getState().project.sources.length, 1);
  });

  it("research_search requires no approval at a suggest-permitting autonomy level (it is external retrieval, not a World Model write)", async () => {
    const { registry } = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "suggest", approvals, autonomyGrants });

    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "x" }, authorize });
    assert.equal(result.status, "success");
  });

  it("research_search is blocked below the suggest autonomy level (internal reasoning vs external request distinction, brief Section 15)", async () => {
    const { registry } = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "observe", approvals, autonomyGrants });

    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "x" }, authorize });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
  });
});

describe("Test 14: provider failure never crashes the tool boundary", () => {
  it("a search responder that throws surfaces execution_failure via research_search", async () => {
    const { registry } = buildHarness({
      respondToSearch: () => {
        throw new Error("simulated provider crash");
      }
    });
    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });
});

describe("Test 16: oversized/untrusted external content is rejected before it can flow through the tool boundary", () => {
  it("a provider that returns an oversized snippet is rejected by the tool handler's own re-validation of the provider envelope -- research_search NEVER reports this as success", async () => {
    const { registry } = buildHarness({
      respondToSearch: () => ({
        results: [{ locator: null, title: "x", publisher: null, sourceType: "web_page", publishedAt: null, snippet: "x".repeat(10000) }]
      })
    });
    const { result } = await executeTool(registry, { toolName: "research_search", input: { query: "x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /malformed result/);
  });

  it("a provider that returns oversized fetch content is likewise rejected, never surfaced as success", async () => {
    const { registry } = buildHarness({
      respondToFetch: () => ({
        content: { locator: "https://example.com/x", title: "x", publisher: null, sourceType: "web_page", publishedAt: null, retrievedAt: new Date().toISOString(), excerpt: "x".repeat(10000), contentHash: null }
      })
    });
    const { result } = await executeTool(registry, { toolName: "research_fetch", input: { locator: "https://example.com/x" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.match(result.error!.message, /malformed result/);
  });
});
