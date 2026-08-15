import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProposal, deserializeProposal, serializeProposal, WorldModelValidationError, type ProposalInput } from "../src/index.js";

function buildInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "planstep_1",
    objectiveSummary: "Reduce mass by 20%.",
    toolName: "modify_object",
    toolTarget: "world_model",
    rationale: "Selected material meets the mass requirement.",
    expectedEffect: "The bracket's material property is updated to aluminum 6061.",
    ...overrides
  };
}

describe("Proposal: creation and validation", () => {
  it("creates a proposal with sane defaults", () => {
    const proposal = createProposal(buildInput());
    assert.match(proposal.id, /^proposal_/);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.version, 1);
    assert.equal(proposal.supersedesProposalId, null);
    assert.equal(proposal.source, "agent");
    assert.equal(proposal.target, null);
    assert.deepEqual(proposal.input, {});
    assert.deepEqual(proposal.relevantRequirementIds, []);
    assert.deepEqual(proposal.relevantConstraintIds, []);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createProposal(buildInput({ status: "executing" as never })), /invalid proposal.status/);
  });

  it("rejects an invalid toolTarget", () => {
    assert.throws(() => createProposal(buildInput({ toolTarget: "freecad" as never })), /invalid proposal.toolTarget/);
  });

  it("rejects an empty toolName", () => {
    assert.throws(() => createProposal(buildInput({ toolName: "" })), /proposal.toolName is required/);
  });

  it("rejects an empty rationale", () => {
    assert.throws(() => createProposal(buildInput({ rationale: "" })), /proposal.rationale is required/);
  });

  it("rejects a whitespace-only rationale", () => {
    assert.throws(() => createProposal(buildInput({ rationale: "   " })), /proposal.rationale is required/);
  });

  it("rejects an empty expectedEffect", () => {
    assert.throws(() => createProposal(buildInput({ expectedEffect: "" })), /proposal.expectedEffect is required/);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createProposal(buildInput({ projectVersion: 0 })), /proposal.projectVersion must be a positive integer/);
  });

  it("rejects a missing projectId", () => {
    assert.throws(() => createProposal(buildInput({ projectId: "" })), /proposal.projectId is required/);
  });

  it("rejects a missing planId", () => {
    assert.throws(() => createProposal(buildInput({ planId: "" })), /proposal.planId is required/);
  });

  it("rejects a missing planStepId", () => {
    assert.throws(() => createProposal(buildInput({ planStepId: "" })), /proposal.planStepId is required/);
  });

  it("REGRESSION: two independently created proposals never share an id", () => {
    const first = createProposal(buildInput());
    const second = createProposal(buildInput());
    assert.notEqual(first.id, second.id);
  });

  it("rejects a non-JSON-safe input value", () => {
    assert.throws(
      () => createProposal(buildInput({ input: { fn: () => {} } as never })),
      WorldModelValidationError
    );
  });

  it("rejects a non-JSON-safe metadata value", () => {
    assert.throws(
      () => createProposal(buildInput({ metadata: { fn: () => {} } as never })),
      WorldModelValidationError
    );
  });

  it("accepts a null target (e.g. a proposal that would CREATE a new entity with no id yet)", () => {
    const proposal = createProposal(buildInput({ target: null }));
    assert.equal(proposal.target, null);
  });

  it("accepts a real target and validates it via the reused ChangeTarget shape", () => {
    const proposal = createProposal(buildInput({ target: { entityType: "object", entityId: "obj_1" } }));
    assert.deepEqual(proposal.target, { entityType: "object", entityId: "obj_1" });
  });

  it("rejects a malformed target", () => {
    assert.throws(
      () => createProposal(buildInput({ target: { entityType: "" } as never })),
      /change target.entityType is required/
    );
  });

  it("carries real structured input through unchanged", () => {
    const proposal = createProposal(buildInput({ input: { propertyKey: "material", value: "aluminum_6061" } }));
    assert.deepEqual(proposal.input, { propertyKey: "material", value: "aluminum_6061" });
  });

  it("preserves relevant requirement/constraint ids for traceability", () => {
    const proposal = createProposal(buildInput({ relevantRequirementIds: ["req_1"], relevantConstraintIds: ["con_1"] }));
    assert.deepEqual(proposal.relevantRequirementIds, ["req_1"]);
    assert.deepEqual(proposal.relevantConstraintIds, ["con_1"]);
  });

  it("REGRESSION: freezes the returned proposal, including nested input/target/arrays", () => {
    const proposal = createProposal(
      buildInput({ input: { key: "value" }, target: { entityType: "object", entityId: "obj_1" }, relevantRequirementIds: ["req_1"] })
    );
    assert.throws(() => {
      (proposal as { status: string }).status = "executed";
    }, TypeError);
    assert.throws(() => {
      (proposal.input as Record<string, unknown>).key = "MUTATED";
    }, TypeError);
    assert.throws(() => {
      (proposal.target as { entityId: string }).entityId = "MUTATED";
    }, TypeError);
    assert.throws(() => {
      (proposal.relevantRequirementIds as string[]).push("req_2");
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const proposal = createProposal(
      buildInput({
        input: { propertyKey: "material", value: "aluminum_6061" },
        target: { entityType: "object", entityId: "obj_1" },
        relevantRequirementIds: ["req_1"],
        relevantConstraintIds: ["con_1"]
      })
    );
    const roundTripped = JSON.parse(JSON.stringify(proposal));
    assert.deepEqual(roundTripped, proposal);
  });

  it("REGRESSION: serializeProposal/deserializeProposal round-trip with full fidelity and re-validate on the way back in", () => {
    const proposal = createProposal(
      buildInput({
        input: { propertyKey: "material", value: "aluminum_6061" },
        target: { entityType: "object", entityId: "obj_1" }
      })
    );
    const serialized = serializeProposal(proposal);
    assert.equal(typeof serialized, "string");
    const deserialized = deserializeProposal(serialized);
    assert.deepEqual(deserialized, proposal);
  });

  it("deserializeProposal rejects a malformed serialized proposal rather than silently accepting it", () => {
    assert.throws(() => deserializeProposal(JSON.stringify({ not: "a proposal" })), WorldModelValidationError);
    assert.throws(() => deserializeProposal(""), WorldModelValidationError);
  });

  it("deserializeProposal accepts (and preserves) an unknown extra field -- the established project-wide convention every assert* function already follows, not a P10-specific relaxation", () => {
    // Matches assertPlan/assertObservationResult/every other hand-written
    // validator in this file: none of them reject an object for having an
    // extra key beyond what's checked, unlike ToolValueSchema's
    // additionalProperties:false (a SEPARATE validation system for tool
    // boundaries). Forward-compatible by design: adding a new optional
    // field to Proposal later must not make old serialized data invalid.
    const proposal = createProposal(buildInput());
    const withExtraField = JSON.stringify({ ...proposal, futureField: "reserved for a later phase" });
    const deserialized = deserializeProposal(withExtraField);
    assert.equal((deserialized as unknown as { futureField: string }).futureField, "reserved for a later phase");
  });
});
