import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequirementCandidate, createWorldModelState, type RequirementCandidateInput, type WorldModelState } from "@naqsh/schemas";
import { createAddRequirementTool } from "../src/add-requirement-tool.js";
import { createChangeHistory } from "../src/change-history.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function specificCandidateInput(overrides: Partial<RequirementCandidateInput> = {}): RequirementCandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "The bracket must support 500 N.",
    description: "Load capacity must be at least 500 N.",
    category: "load",
    operator: "gte",
    value: 500,
    unit: "N",
    interpretationStatus: "specific",
    ...overrides
  };
}

function buildHarness() {
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const registry = createToolRegistry();
  const { tool, handler } = createAddRequirementTool(
    () => state,
    (next) => {
      state = next;
    },
    history
  );
  registry.register(tool, handler);
  return { registry, history, getState: () => state };
}

describe("createAddRequirementTool: identity and classification", () => {
  it("is classified mutate/world_model -- adding a requirement is a real mutation, gated by approval", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("add_requirement")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "world_model");
  });
});

describe("createAddRequirementTool: successful acceptance", () => {
  it("adds a specific candidate to the World Model through the existing add_requirement transition", async () => {
    const { registry, getState, history } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    const before = getState().project.requirements.length;
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    assert.equal(result.status, "success");
    assert.equal(getState().project.requirements.length, before + 1);
    const added = getState().project.requirements.at(-1)!;
    assert.equal(added.description, candidate.description);
    assert.equal(added.category, "load");
    assert.equal(added.value, 500);
    assert.equal(added.unit, "N");
    // Recorded as a real, audited Change -- never a silent push.
    assert.equal(history.list().length, 1);
    assert.equal(history.list()[0]!.transitionKind, "add_requirement");
  });

  it("preserves traceability: operator/statementText/requirementCandidateId land in the accepted Requirement's metadata", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    const added = getState().project.requirements.at(-1)!;
    assert.equal(added.metadata.requirementCandidateId, candidate.id);
    assert.equal(added.metadata.statementText, "The bracket must support 500 N.");
    assert.equal(added.metadata.operator, "gte");
  });

  it("accepts a qualitative specific candidate (no operator/value/unit)", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(
      specificCandidateInput({ description: "Must be easy to manufacture.", category: "manufacturability", operator: null, value: null, unit: null })
    );
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    assert.equal(result.status, "success");
    const added = getState().project.requirements.at(-1)!;
    assert.equal(added.value, null);
    assert.equal(added.unit, null);
  });
});

describe("createAddRequirementTool: ambiguous candidates are never accepted", () => {
  it("rejects an ambiguous candidate outright -- never invents a value to accept it", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate({
      projectId: "proj_1",
      projectVersion: 1,
      statementText: "Make it lightweight.",
      description: "Should be lightweight.",
      category: "mass",
      interpretationStatus: "ambiguous",
      ambiguityReason: "No specific mass target was stated."
    });
    const before = getState().project.requirements.length;
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /ambiguous_candidate/);
    assert.equal(getState().project.requirements.length, before);
  });
});

describe("createAddRequirementTool: duplicate submission is not corruption", () => {
  it("accepting the same candidate twice creates two independent Requirements, corrupts no ids, and leaves prior requirements untouched", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    const firstAdded = getState().project.requirements.at(-1)!;

    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    assert.equal(result.status, "success");

    const requirements = getState().project.requirements;
    assert.equal(requirements.length, 2);
    assert.notEqual(requirements[0]!.id, requirements[1]!.id);
    assert.deepEqual(requirements[0], firstAdded);
    assert.equal(requirements[1]!.metadata.requirementCandidateId, candidate.id);
  });
});

describe("createAddRequirementTool: cross-project isolation", () => {
  it("rejects a candidate belonging to a different project", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput({ projectId: "proj_OTHER" }));
    const before = getState().project.requirements.length;
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /cross_project_forbidden/);
    assert.equal(getState().project.requirements.length, before);
  });
});

describe("createAddRequirementTool: input validation", () => {
  it("REGRESSION: malformed structured output (e.g. a hallucinating or malicious model response) cannot mutate the World Model", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: { candidate: { not: "a real candidate" } } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.deepEqual(getState(), before);
    assert.equal(getState().project.requirements.length, 0);
  });

  it("rejects a missing candidate and mutates nothing", async () => {
    const { registry, getState } = buildHarness();
    const before = getState();
    const { result } = await executeTool(registry, { toolName: "add_requirement", input: {} });
    assert.equal(result.status, "error");
    assert.deepEqual(getState(), before);
  });
});

describe("createAddRequirementTool: Phase 4 permission boundary is not weakened just because the input originated from text", () => {
  it("unauthorized (no approval, no autonomy grant) is rejected with policy_rejected and mutates nothing", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const before = getState();
    const { result } = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.deepEqual(getState(), before);
  });

  it("unapproved (pending) is rejected", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    approvals.create({ toolName: "add_requirement", targetType: "requirement", targetId: null, reason: "test" });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(getState().project.requirements.length, 0);
  });

  it("approved executes for real", async () => {
    const { registry, getState } = buildHarness();
    const candidate = createRequirementCandidate(specificCandidateInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "add_requirement", targetType: "requirement", targetId: null, reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "add_requirement",
      input: { candidate },
      target: { entityType: "requirement", entityId: null },
      authorize
    });
    assert.equal(result.status, "success");
    assert.equal(getState().project.requirements.length, 1);
  });
});
