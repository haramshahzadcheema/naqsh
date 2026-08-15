import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProposal, type ProposalInput } from "@naqsh/schemas";
import { requestProposalApproval } from "../src/proposal-approval.js";
import { createApprovalStore } from "../src/approval-store.js";

function buildProposal(overrides: Partial<ProposalInput> = {}) {
  return createProposal({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "planstep_1",
    objectiveSummary: "Reduce mass by 20%.",
    toolName: "modify_object",
    toolTarget: "world_model",
    input: { objectId: "obj_1", propertyKey: "material", value: "aluminum_6061" },
    target: { entityType: "object", entityId: "obj_1" },
    rationale: "Aluminum satisfies the mass requirement.",
    expectedEffect: "The bracket's material property updates to aluminum 6061.",
    ...overrides
  });
}

describe("requestProposalApproval", () => {
  it("creates a pending Approval tied to the exact proposal via proposalId", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal();
    const approval = requestProposalApproval(approvals, proposal);
    assert.equal(approval.status, "pending");
    assert.equal(approval.proposalId, proposal.id);
  });

  it("derives toolName/targetType/targetId from the proposal, not from caller-repeated values", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal();
    const approval = requestProposalApproval(approvals, proposal);
    assert.equal(approval.toolName, proposal.toolName);
    assert.equal(approval.targetType, proposal.target?.entityType);
    assert.equal(approval.targetId, proposal.target?.entityId);
  });

  it("defaults reason to the proposal's own rationale when no explicit reason is given", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal({ rationale: "Because the mass budget requires it." });
    const approval = requestProposalApproval(approvals, proposal);
    assert.equal(approval.reason, "Because the mass budget requires it.");
  });

  it("honors an explicit reason override", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal();
    const approval = requestProposalApproval(approvals, proposal, { reason: "Custom review note." });
    assert.equal(approval.reason, "Custom review note.");
  });

  it("handles a null target (a CREATE-flavored proposal) by requesting an unscoped-target approval", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal({ target: null, toolName: "create_object" });
    const approval = requestProposalApproval(approvals, proposal);
    assert.equal(approval.targetType, null);
    assert.equal(approval.targetId, null);
  });

  it("REGRESSION: two proposals naming the same tool+target produce two DISTINCT approvals, each tied to its own proposalId -- toolName+target alone cannot disambiguate them", () => {
    const approvals = createApprovalStore();
    const first = buildProposal();
    const second = buildProposal();
    assert.notEqual(first.id, second.id);
    const firstApproval = requestProposalApproval(approvals, first);
    const secondApproval = requestProposalApproval(approvals, second);
    assert.notEqual(firstApproval.id, secondApproval.id);
    assert.equal(firstApproval.proposalId, first.id);
    assert.equal(secondApproval.proposalId, second.id);
  });

  it("the created approval is retrievable from the same store by id", () => {
    const approvals = createApprovalStore();
    const proposal = buildProposal();
    const approval = requestProposalApproval(approvals, proposal);
    assert.equal(approvals.getById(approval.id)?.id, approval.id);
  });
});
