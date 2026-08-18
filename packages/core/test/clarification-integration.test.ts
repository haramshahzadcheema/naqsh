import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createRequirementCandidate,
  createWorldModelState,
  type Clarification,
  type RequirementCandidate,
  type WorldModelState
} from "@naqsh/schemas";
import { createAnalyzeRequirementCompletenessTool } from "../src/analyze-requirement-completeness-tool.js";
import { createAnswerClarificationTool } from "../src/answer-clarification-tool.js";
import { createAddRequirementTool } from "../src/add-requirement-tool.js";
import { createClarificationStore } from "../src/clarification-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";

/**
 * End-to-end Phase 19 pipeline test: ambiguous statement -> analyze ->
 * clarification -> answer -> updated candidate -> add_requirement. Proves
 * the brief's own Step 16/Invariant 2 concretely: clarification tools are
 * freely callable (mutation:"suggest", the same tier interpret_requirement
 * already uses) but NEVER reach a World Model mutation on their own --
 * only the EXISTING, unmodified, approval-gated add_requirement tool can
 * do that, and it remains exactly as gated as it was before P19 existed.
 */

function buildFakeProvider(structuredResult: Record<string, unknown>): ModelProvider {
  return {
    describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
    async generate(request) {
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
      return createModelInvocationResult({
        requestId: request.id,
        providerId: "fake",
        modelId: "fake-v1",
        status: schemaErrors.length > 0 ? "error" : "success",
        response: schemaErrors.length > 0 ? undefined : response,
        error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
        startedAt: new Date().toISOString()
      });
    }
  };
}

function buildHarness() {
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const clarificationStore = createClarificationStore();
  const provider = buildFakeProvider({
    description: "Load capacity must be at least 500 N, applied vertically.",
    category: "load",
    interpretationStatus: "specific",
    operator: "gte",
    value: 500,
    unit: "N",
    ambiguityReason: null
  });
  const registry = createToolRegistry();

  const analyze = createAnalyzeRequirementCompletenessTool(() => state, clarificationStore);
  const answer = createAnswerClarificationTool(() => state, provider, clarificationStore);
  const add = createAddRequirementTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(analyze.tool, analyze.handler);
  registry.register(answer.tool, answer.handler);
  registry.register(add.tool, add.handler);

  return { registry, history, clarificationStore, getState: () => state };
}

describe("Phase 19 pipeline: ambiguous statement -> clarification -> answer -> add_requirement", () => {
  it("the full round trip produces a real, traceable Requirement", async () => {
    const { registry, getState } = buildHarness();

    const ambiguousCandidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "Make the bracket strong.",
      description: "The bracket must be strong.",
      category: "load",
      interpretationStatus: "ambiguous",
      ambiguityReason: "No specific load or direction was stated."
    });

    const { result: analyzeResult } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate: ambiguousCandidate } });
    assert.equal(analyzeResult.status, "success");
    const analyzeOutput = analyzeResult.output as { needsClarification: boolean; clarifications: Clarification[] };
    assert.equal(analyzeOutput.needsClarification, true);
    assert.equal(analyzeOutput.clarifications.length, 1);

    const { result: answerResult } = await executeTool(registry, {
      toolName: "answer_clarification",
      input: { clarificationId: analyzeOutput.clarifications[0]!.id, answerText: "500 N vertically", modelId: "fake-v1" }
    });
    assert.equal(answerResult.status, "success");
    const answerOutput = answerResult.output as { updatedCandidate: RequirementCandidate };
    assert.equal(answerOutput.updatedCandidate.interpretationStatus, "specific");

    // add_requirement without approval is rejected -- P4 is untouched by P19.
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });
    const before = getState();
    const { result: unauthorizedAdd } = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate: answerOutput.updatedCandidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(unauthorizedAdd.status, "error");
    assert.equal(unauthorizedAdd.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);

    // With approval, it succeeds -- and the resulting Requirement traces
    // all the way back to the original statement.
    const approval = approvals.create({ toolName: "add_requirement", targetType: "requirement", targetId: null, reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const { result: approvedAdd } = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate: answerOutput.updatedCandidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(approvedAdd.status, "success");
    const added = getState().project.requirements.at(-1)!;
    assert.equal(added.value, 500);
    assert.equal(added.unit, "N");
    assert.equal(added.metadata.originalStatementText, "Make the bracket strong.");
    assert.equal(added.metadata.resolvedClarificationId, analyzeOutput.clarifications[0]!.id);
  });

  it("INVARIANT: an unresolved ambiguity (rejected answer) never reaches add_requirement as an authoritative requirement", async () => {
    const state = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const registry = createToolRegistry();
    const clarificationStore = createClarificationStore();
    const provider = buildFakeProvider({
      description: "x",
      category: "load",
      interpretationStatus: "ambiguous",
      operator: null,
      value: null,
      unit: null,
      ambiguityReason: "Still ambiguous."
    });
    const analyze = createAnalyzeRequirementCompletenessTool(() => state, clarificationStore);
    const answer = createAnswerClarificationTool(() => state, provider, clarificationStore);
    registry.register(analyze.tool, analyze.handler);
    registry.register(answer.tool, answer.handler);

    const candidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "Make the bracket strong.",
      description: "The bracket must be strong.",
      category: "load",
      interpretationStatus: "ambiguous",
      ambiguityReason: "No specific load or direction was stated."
    });
    const { result: analyzeResult } = await executeTool(registry, { toolName: "analyze_requirement_completeness", input: { candidate } });
    const output = analyzeResult.output as { clarifications: Clarification[] };
    const { result: answerResult } = await executeTool(registry, {
      toolName: "answer_clarification",
      input: { clarificationId: output.clarifications[0]!.id, answerText: "banana", modelId: "fake-v1" }
    });
    assert.equal(answerResult.status, "error");
    // No candidate was ever produced to hand to add_requirement -- there is
    // nothing "half-authoritative" sitting anywhere in this pipeline.
    assert.equal(answerResult.output, null);
  });

  it("INVARIANT: adding a new requirement never mutates any OTHER existing requirement", async () => {
    const { registry, getState } = buildHarness();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const firstCandidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "The plate must be 200 mm wide.",
      description: "Plate width must equal 200 mm.",
      category: "dimension",
      operator: "eq",
      value: 200,
      unit: "mm",
      interpretationStatus: "specific"
    });
    const approval1 = approvals.create({ toolName: "add_requirement", targetType: "requirement", targetId: null, reason: "t" });
    approvals.approve(approval1.id, "human");
    await executeTool(registry, { toolName: "add_requirement", input: { candidate: firstCandidate }, target: { entityType: "requirement", entityId: null }, authorize });
    const firstRequirement = getState().project.requirements.at(-1)!;

    const secondCandidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "The bracket must support 500 N vertically.",
      description: "Load capacity must be at least 500 N.",
      category: "load",
      operator: "gte",
      value: 500,
      unit: "N",
      interpretationStatus: "specific"
    });
    const approval2 = approvals.create({ toolName: "add_requirement", targetType: "requirement", targetId: null, reason: "t" });
    approvals.approve(approval2.id, "human");
    await executeTool(registry, { toolName: "add_requirement", input: { candidate: secondCandidate }, target: { entityType: "requirement", entityId: null }, authorize });

    const stillThere = getState().project.requirements.find((r) => r.id === firstRequirement.id);
    assert.deepEqual(stillThere, firstRequirement);
    assert.equal(getState().project.requirements.length, 2);
  });
});
