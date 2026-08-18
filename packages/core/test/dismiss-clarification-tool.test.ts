import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClarification, createRequirementCandidate, type Clarification } from "@naqsh/schemas";
import { createDismissClarificationTool } from "../src/dismiss-clarification-tool.js";
import { createClarificationStore } from "../src/clarification-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function seedPendingClarification(clarificationStore: ReturnType<typeof createClarificationStore>) {
  const candidate = createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "Make the bracket strong.",
    description: "The bracket must be strong.",
    category: "load",
    interpretationStatus: "ambiguous",
    ambiguityReason: "No specific load or direction was stated."
  });
  const clarification = createClarification({
    projectId: "proj_1",
    requirementCandidateId: candidate.id,
    candidateSnapshot: candidate,
    question: "What load must it withstand, and in which direction?",
    reason: "No specific load or direction was stated.",
    category: "missing_threshold",
    affectedFields: ["value", "operator"]
  });
  clarificationStore.save(clarification);
  return clarification;
}

function buildHarness() {
  const clarificationStore = createClarificationStore();
  const registry = createToolRegistry();
  const { tool, handler } = createDismissClarificationTool(clarificationStore);
  registry.register(tool, handler);
  return { registry, clarificationStore };
}

describe("createDismissClarificationTool: identity and classification", () => {
  it("is classified suggest/world_model", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("dismiss_clarification")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
  });
});

describe("createDismissClarificationTool: dismissal", () => {
  it("transitions a pending clarification to dismissed, distinct from answered", async () => {
    const { registry, clarificationStore } = buildHarness();
    const clarification = seedPendingClarification(clarificationStore);
    const { result } = await executeTool(registry, { toolName: "dismiss_clarification", input: { clarificationId: clarification.id, reason: "not needed" } });
    assert.equal(result.status, "success");
    const output = result.output as { clarification: Clarification };
    assert.equal(output.clarification.status, "dismissed");
    assert.equal(output.clarification.answerText, null);
  });

  it("rejects dismissing an unknown clarificationId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "dismiss_clarification", input: { clarificationId: "clarify_missing" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects dismissing an already-dismissed clarification", async () => {
    const { registry, clarificationStore } = buildHarness();
    const clarification = seedPendingClarification(clarificationStore);
    await executeTool(registry, { toolName: "dismiss_clarification", input: { clarificationId: clarification.id } });
    const { result } = await executeTool(registry, { toolName: "dismiss_clarification", input: { clarificationId: clarification.id } });
    assert.equal(result.status, "error");
  });

  it("rejects a missing clarificationId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "dismiss_clarification", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});
