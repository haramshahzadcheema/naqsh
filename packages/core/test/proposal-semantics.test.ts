import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlan, createProposal, createTool, type Plan, type ProposalInput } from "@naqsh/schemas";
import { createToolRegistry } from "../src/tool-registry.js";
import { validateProposalSemantics, type ProposalSemanticIssueCode } from "../src/proposal-semantics.js";

function richPlan(): Plan {
  return createPlan({
    projectId: "proj_1",
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Reduce mass by 20%.",
    steps: [
      {
        id: "planstep_1",
        title: "Select material",
        description: "x",
        purpose: "unblock geometry",
        relevantRequirementIds: ["req_mass"],
        relevantConstraintIds: ["con_material"],
        relevantObjectIds: ["obj_bracket"],
        relevantDecisionIds: ["dec_material"]
      }
    ]
  });
}

function buildProposalInput(plan: Plan, overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    projectId: plan.projectId,
    projectVersion: plan.projectVersion,
    planId: plan.id,
    planStepId: plan.steps[0]!.id,
    objectiveSummary: plan.objectiveSummary,
    toolName: "modify_object",
    toolTarget: "world_model",
    rationale: "Aluminum satisfies the mass requirement.",
    expectedEffect: "The bracket's material property updates to aluminum 6061.",
    ...overrides
  };
}

function issueCodes(issues: { code: ProposalSemanticIssueCode }[]): ProposalSemanticIssueCode[] {
  return issues.map((issue) => issue.code);
}

describe("validateProposalSemantics: a well-formed proposal produces no issues", () => {
  it("accepts a proposal whose references are all real", () => {
    const plan = richPlan();
    const proposal = createProposal(
      buildProposalInput(plan, {
        relevantRequirementIds: ["req_mass"],
        relevantConstraintIds: ["con_material"],
        target: { entityType: "object", entityId: "obj_bracket" }
      })
    );
    assert.deepEqual(validateProposalSemantics(proposal, plan), []);
  });

  it("accepts a proposal with a null target (e.g. proposing to CREATE something new)", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { target: null }));
    assert.deepEqual(validateProposalSemantics(proposal, plan), []);
  });
});

describe("validateProposalSemantics: traceability to plan/plan step", () => {
  it("rejects a proposal for a different plan", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { planId: "plan_other" }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["plan_mismatch"]);
  });

  it("rejects a proposal for a different project than its plan", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { projectId: "proj_other" }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["project_mismatch"]);
  });

  it("rejects a proposal referencing a plan step that does not exist in the plan", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { planStepId: "planstep_ghost" }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["unknown_plan_step"]);
  });
});

describe("validateProposalSemantics: hallucinated references are rejected", () => {
  it("rejects a requirement id the originating plan step never cited", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { relevantRequirementIds: ["req_made_up"] }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["unknown_requirement_reference"]);
  });

  it("rejects a constraint id the originating plan step never cited", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { relevantConstraintIds: ["con_made_up"] }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["unknown_constraint_reference"]);
  });

  it("rejects a target entityId the originating plan step never cited", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { target: { entityType: "object", entityId: "obj_made_up" } }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan)), ["unknown_target_reference"]);
  });

  it("does not flag a target entityType it has no plan-step field to cross-check (e.g. a future environment-specific resource type)", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { target: { entityType: "freecad_object", entityId: "anything" } }));
    assert.deepEqual(validateProposalSemantics(proposal, plan), []);
  });
});

describe("validateProposalSemantics: tool cross-checking (only when a registry is supplied)", () => {
  it("skips tool validation entirely when no registry is given", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { toolName: "totally_unregistered_tool" }));
    assert.deepEqual(validateProposalSemantics(proposal, plan), []);
  });

  it("rejects a toolName that is not registered, when a registry is supplied", () => {
    const plan = richPlan();
    const proposal = createProposal(buildProposalInput(plan, { toolName: "totally_unregistered_tool" }));
    const registry = createToolRegistry();
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan, registry)), ["unknown_tool"]);
  });

  it("accepts a registered tool with schema-valid input", () => {
    const plan = richPlan();
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );
    const proposal = createProposal(buildProposalInput(plan, { input: { objectId: "obj_bracket" } }));
    assert.deepEqual(validateProposalSemantics(proposal, plan, registry), []);
  });

  it("REGRESSION: rejects input that does not match the registered tool's own inputSchema", () => {
    const plan = richPlan();
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_object",
        target: "world_model",
        mutation: "mutate",
        inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );
    const proposal = createProposal(buildProposalInput(plan, { input: { wrongField: 123 } }));
    assert.deepEqual(issueCodes(validateProposalSemantics(proposal, plan, registry)), ["invalid_tool_input"]);
  });
});
