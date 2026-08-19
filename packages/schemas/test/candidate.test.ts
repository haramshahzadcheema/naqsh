import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createExperiment,
  deserializeCandidate,
  serializeCandidate,
  WorldModelValidationError,
  type CandidateInput,
  type ExperimentInput
} from "../src/index.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    hypothesis: "A ribbed aluminum bracket meets the 500 N load at lower mass than a solid plate.",
    rationale: "Ribbing is a standard mass-reduction technique for bending loads.",
    ...overrides
  };
}

describe("Candidate: creation and validation", () => {
  it("creates a valid candidate with defaults", () => {
    const candidate = createCandidate(candidateInput());
    assert.equal(candidate.status, "proposed");
    assert.equal(candidate.source, "agent");
    assert.equal(candidate.planStepId, null);
    assert.equal(candidate.designSpecificationId, null);
    assert.equal(candidate.proposalId, null);
    assert.equal(candidate.parentCandidateId, null);
    assert.deepEqual(candidate.relevantRequirementIds, []);
    assert.deepEqual(candidate.relevantConstraintIds, []);
    assert.deepEqual(candidate.relevantResearchEvidenceIds, []);
    assert.deepEqual(candidate.assumptionIds, []);
    assert.ok(candidate.id.length > 0);
  });

  it("is frozen (immutable) after creation", () => {
    const candidate = createCandidate(candidateInput());
    assert.throws(() => {
      (candidate as { hypothesis: string }).hypothesis = "tampered";
    });
  });

  it("rejects an empty hypothesis", () => {
    assert.throws(() => createCandidate(candidateInput({ hypothesis: "" })), WorldModelValidationError);
  });

  it("rejects an empty rationale", () => {
    assert.throws(() => createCandidate(candidateInput({ rationale: "" })), WorldModelValidationError);
  });

  it("rejects a missing planId", () => {
    assert.throws(() => createCandidate({ ...candidateInput(), planId: "" }), WorldModelValidationError);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createCandidate({ ...candidateInput(), status: "optimal" as never }), WorldModelValidationError);
  });

  it("accepts a fully-populated candidate referencing a plan step, design, proposal, requirements, constraints, evidence, assumptions, and a parent candidate", () => {
    const candidate = createCandidate(
      candidateInput({
        planStepId: "step_1",
        designSpecificationId: "design_1",
        proposalId: "proposal_1",
        relevantRequirementIds: ["req_1"],
        relevantConstraintIds: ["con_1"],
        relevantResearchEvidenceIds: ["evid_1"],
        assumptionIds: ["assum_1"],
        parentCandidateId: "candidate_0"
      })
    );
    assert.equal(candidate.planStepId, "step_1");
    assert.equal(candidate.designSpecificationId, "design_1");
    assert.equal(candidate.proposalId, "proposal_1");
    assert.deepEqual(candidate.relevantRequirementIds, ["req_1"]);
    assert.equal(candidate.parentCandidateId, "candidate_0");
  });

  it("serialization round-trips", () => {
    const candidate = createCandidate(candidateInput());
    const restored = deserializeCandidate(serializeCandidate(candidate));
    assert.deepEqual(restored, candidate);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeCandidate("{not json"), SyntaxError);
  });

  it("rejects a well-formed but invalid object on deserialize", () => {
    assert.throws(() => deserializeCandidate(JSON.stringify({ not: "a candidate" })), WorldModelValidationError);
  });
});

describe("Experiment: P22 additive extension (candidateId/buildResultId/verificationResultIds/checkpointBeforeId/checkpointAfterId)", () => {
  function experimentInput(overrides: Partial<ExperimentInput> = {}): ExperimentInput {
    return { objective: "Test candidate A", hypothesis: "It will pass check X.", ...overrides };
  }

  it("defaults all five new fields to null/[] -- fully backward compatible with P1-P21 usage", () => {
    const experiment = createExperiment(experimentInput());
    assert.equal(experiment.candidateId, null);
    assert.equal(experiment.buildResultId, null);
    assert.deepEqual(experiment.verificationResultIds, []);
    assert.equal(experiment.checkpointBeforeId, null);
    assert.equal(experiment.checkpointAfterId, null);
  });

  it("accepts real values for all five new fields", () => {
    const experiment = createExperiment(
      experimentInput({
        candidateId: "candidate_1",
        buildResultId: "build_1",
        verificationResultIds: ["verif_1", "verif_2"],
        checkpointBeforeId: "chk_before",
        checkpointAfterId: "chk_after"
      })
    );
    assert.equal(experiment.candidateId, "candidate_1");
    assert.equal(experiment.buildResultId, "build_1");
    assert.deepEqual(experiment.verificationResultIds, ["verif_1", "verif_2"]);
    assert.equal(experiment.checkpointBeforeId, "chk_before");
    assert.equal(experiment.checkpointAfterId, "chk_after");
  });

  it("rejects a non-string-array verificationResultIds", () => {
    assert.throws(() => createExperiment(experimentInput({ verificationResultIds: [123] as never })), WorldModelValidationError);
  });

  it("an old-style experiment (P1-P21, no new fields ever set) still validates and serializes correctly", () => {
    const experiment = createExperiment({ objective: "legacy experiment", hypothesis: "x", status: "complete", result: { ok: true }, conclusion: "worked" });
    assert.equal(experiment.candidateId, null);
    assert.equal(experiment.status, "complete");
  });
});
