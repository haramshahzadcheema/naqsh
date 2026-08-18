import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequirementCandidate, createWorldModelState, type Clarification, type RequirementCandidateInput, type WorldModelState } from "@naqsh/schemas";
import { createAnalyzeRequirementCompletenessTool } from "../src/analyze-requirement-completeness-tool.js";
import { createClarificationStore } from "../src/clarification-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
}

function ambiguousCandidate(overrides: Partial<RequirementCandidateInput> = {}) {
  return createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "Make the bracket strong.",
    description: "The bracket must be strong.",
    category: "load",
    interpretationStatus: "ambiguous",
    ambiguityReason: "No specific load or direction was stated.",
    ...overrides
  });
}

function specificCandidate(overrides: Partial<RequirementCandidateInput> = {}) {
  return createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "The bracket must support 500 N vertically.",
    description: "Load capacity must be at least 500 N.",
    category: "load",
    operator: "gte",
    value: 500,
    unit: "N",
    interpretationStatus: "specific",
    ...overrides
  });
}

function buildHarness() {
  const state = buildState();
  const clarificationStore = createClarificationStore();
  const registry = createToolRegistry();
  const { tool, handler } = createAnalyzeRequirementCompletenessTool(() => state, clarificationStore);
  registry.register(tool, handler);
  return { registry, state, clarificationStore };
}

describe("createAnalyzeRequirementCompletenessTool: identity and classification", () => {
  it("is classified suggest/world_model -- analyzing never mutates the World Model", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("analyze_requirement_completeness")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
  });
});

describe("createAnalyzeRequirementCompletenessTool: Test 1/7 -- complete requirement needs no clarification", () => {
  it("a specific, unambiguous candidate produces needsClarification: false and no records", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = specificCandidate();
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    assert.equal(result.status, "success");
    const output = result.output as { needsClarification: boolean; clarifications: Clarification[] };
    assert.equal(output.needsClarification, false);
    assert.deepEqual(output.clarifications, []);
    assert.equal(clarificationStore.list().length, 0);
  });
});

describe("createAnalyzeRequirementCompletenessTool: Test 2 -- ambiguous candidate produces a persisted clarification", () => {
  it("creates and persists a Clarification for the missing engineering criterion", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = ambiguousCandidate();
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    assert.equal(result.status, "success");
    const output = result.output as { needsClarification: boolean; clarifications: Clarification[] };
    assert.equal(output.needsClarification, true);
    assert.equal(output.clarifications.length, 1);
    assert.equal(output.clarifications[0]!.status, "pending");
    assert.equal(clarificationStore.list().length, 1);
  });
});

describe("createAnalyzeRequirementCompletenessTool: Test 6 -- multiple independent same-category clarifications must NOT collapse into one", () => {
  it("REGRESSION: 'make it lightweight and strong' produces TWO independent pending clarifications (both category missing_threshold), neither superseding the other", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = ambiguousCandidate({
      statementText: "Make it lightweight and strong.",
      description: "The design should be lightweight and strong.",
      category: "general",
      ambiguityReason: "No specific mass limit or load requirement was stated."
    });
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const output = result.output as { clarifications: Clarification[] };

    assert.equal(output.clarifications.length, 2, "both independent clarifications must be returned, not just one");
    assert.ok(output.clarifications.every((c) => c.status === "pending"), "neither clarification should have been superseded by the other");
    assert.equal(clarificationStore.list().length, 2);
    assert.equal(clarificationStore.list().filter((c) => c.status === "superseded").length, 0);

    const questions = output.clarifications.map((c) => c.question);
    assert.ok(questions.some((q) => /mass/i.test(q)));
    assert.ok(questions.some((q) => /load/i.test(q)));
  });

  it("re-analyzing the SAME compound candidate again reuses both existing pending clarifications -- still no duplicates, still no cross-supersession", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = ambiguousCandidate({
      statementText: "Make it lightweight and strong.",
      description: "The design should be lightweight and strong.",
      category: "general",
      ambiguityReason: "No specific mass limit or load requirement was stated."
    });
    await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const output = result.output as { clarifications: Clarification[] };

    assert.equal(output.clarifications.length, 2);
    assert.equal(clarificationStore.list().length, 2, "no new records should have been created on re-analysis");
    assert.equal(clarificationStore.list().filter((c) => c.status === "pending").length, 2);
  });
});

describe("createAnalyzeRequirementCompletenessTool: Test 13 -- duplicate clarification prevention", () => {
  it("analyzing the IDENTICAL candidate twice does not create a duplicate pending clarification", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = ambiguousCandidate();
    await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const output = result.output as { clarifications: Clarification[] };
    assert.equal(output.clarifications.length, 1);
    assert.equal(clarificationStore.list().length, 1, "no duplicate should have been created");
    assert.equal(clarificationStore.list()[0]!.status, "pending");
  });

  it("re-analyzing a DIFFERENT candidate for the same category supersedes the stale pending one instead of duplicating", async () => {
    const { registry, clarificationStore } = buildHarness();
    const first = ambiguousCandidate({ ambiguityReason: "No specific load or direction was stated." });
    await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate: first } });

    // Same candidate id conceptually re-interpreted (simulate by re-using the same requirementCandidateId
    // via a fresh candidate object carrying the same id, but a DIFFERENT statement -- forces a different question).
    const second = createRequirementCandidate({
      id: first.id,
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "Make the bracket cheap.",
      description: "The bracket must be inexpensive.",
      category: "load",
      interpretationStatus: "ambiguous",
      ambiguityReason: "No specific budget was stated."
    });
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate: second } });
    const output = result.output as { clarifications: Clarification[] };
    assert.equal(output.clarifications.length, 1);
    assert.equal(output.clarifications[0]!.status, "pending");

    const all = clarificationStore.listForCandidate(first.id);
    assert.equal(all.length, 2, "the old one should still exist, marked superseded, not deleted");
    const superseded = all.find((c) => c.status === "superseded");
    assert.ok(superseded, "the stale pending clarification should be superseded");
    assert.equal(superseded!.supersededBy, output.clarifications[0]!.id);
  });

  it("does not re-ask for an already-ANSWERED category", async () => {
    const { registry, clarificationStore } = buildHarness();
    const candidate = ambiguousCandidate();
    const { result: first } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const firstOutput = first.output as { clarifications: Clarification[] };
    clarificationStore.answer(firstOutput.clarifications[0]!.id, "500 N vertically");

    const { result: second } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const secondOutput = second.output as { clarifications: Clarification[] };
    assert.equal(secondOutput.clarifications.length, 0, "an already-answered category must not be re-asked");
  });
});

describe("createAnalyzeRequirementCompletenessTool: input validation", () => {
  it("rejects a malformed candidate", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate: { not: "a real candidate" } } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createAnalyzeRequirementCompletenessTool: purity", () => {
  it("never mutates the World Model", async () => {
    const { registry, state } = buildHarness();
    const before = JSON.stringify(state);
    await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate: ambiguousCandidate() } });
    assert.equal(JSON.stringify(state), before);
  });
});
