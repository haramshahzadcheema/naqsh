import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createWorldModelState, WorldModelValidationError, type CandidateInput, type WorldModelState } from "@naqsh/schemas";
import { compareCandidates } from "../src/candidate-comparison.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { recordTransition } from "../src/record-transition.js";
import { createChangeHistory } from "../src/change-history.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    hypothesis: "h",
    rationale: "r",
    ...overrides
  };
}

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
}

describe("compareCandidates: guards", () => {
  it("rejects an empty candidate list", () => {
    assert.throws(() => compareCandidates([], buildState()), WorldModelValidationError);
  });

  it("rejects candidates that don't all share the same (planId, planStepId)", () => {
    const a = createCandidate(candidateInput({ planStepId: "step_1" }));
    const b = createCandidate(candidateInput({ planStepId: "step_2" }));
    assert.throws(() => compareCandidates([a, b], buildState()), WorldModelValidationError);
  });
});

describe("compareCandidates: structural comparison, no scoring", () => {
  it("returns one entry per candidate with its own hypothesis/rationale/status/references", () => {
    const a = createCandidate(candidateInput({ hypothesis: "A: solid plate", relevantRequirementIds: [] }));
    const b = createCandidate(candidateInput({ hypothesis: "B: ribbed plate", relevantRequirementIds: [] }));

    const result = compareCandidates([a, b], buildState());

    assert.equal(result.planId, "plan_1");
    assert.equal(result.planStepId, "step_1");
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0]!.candidateId, a.id);
    assert.equal(result.candidates[0]!.hypothesis, "A: solid plate");
    assert.equal(result.candidates[1]!.candidateId, b.id);
    assert.equal(result.candidates[1]!.hypothesis, "B: ribbed plate");
  });

  it("never adds a score/rank/winner field -- the result carries only the documented, factual keys", () => {
    const a = createCandidate(candidateInput());
    const result = compareCandidates([a], buildState());
    const entryKeys = Object.keys(result.candidates[0]!);
    for (const forbidden of ["score", "rank", "winner", "best", "optimal", "recommended"]) {
      assert.ok(!entryKeys.includes(forbidden), `comparison entry must never carry a "${forbidden}" field`);
    }
  });

  it("a candidate with no experiments yet compares cleanly with an empty experiments array", () => {
    const a = createCandidate(candidateInput());
    const result = compareCandidates([a], buildState());
    assert.deepEqual(result.candidates[0]!.experiments, []);
  });

  it("surfaces each candidate's OWN experiments only, keyed by Experiment.candidateId", () => {
    const a = createCandidate(candidateInput());
    const b = createCandidate(candidateInput());
    const history = createChangeHistory();
    let state = buildState();
    ({ state } = recordTransition(history, state, { kind: "add_experiment", experiment: { objective: "o", hypothesis: "h", candidateId: a.id, status: "complete" } }));
    ({ state } = recordTransition(history, state, { kind: "add_experiment", experiment: { objective: "o", hypothesis: "h", candidateId: b.id, status: "failed" } }));

    const result = compareCandidates([a, b], state);
    const entryA = result.candidates.find((entry) => entry.candidateId === a.id)!;
    const entryB = result.candidates.find((entry) => entry.candidateId === b.id)!;
    assert.equal(entryA.experiments.length, 1);
    assert.equal(entryA.experiments[0]!.status, "complete");
    assert.equal(entryB.experiments.length, 1);
    assert.equal(entryB.experiments[0]!.status, "failed");
  });

  it("resolves each experiment's verificationResultIds into check summaries when a VerificationResultStore is supplied", () => {
    const a = createCandidate(candidateInput());
    const history = createChangeHistory();
    let state = buildState();
    ({ state } = recordTransition(history, state, { kind: "add_experiment", experiment: { objective: "o", hypothesis: "h", candidateId: a.id, status: "complete" } }));
    const experiment = state.project.experiments[0]!;

    const verificationResultStore = createVerificationResultStore();
    const verificationResult = {
      id: "vr_1",
      checkId: "check_1",
      checkKind: "object_exists" as const,
      status: "pass" as const,
      reasonKind: "satisfied" as const,
      message: "ok",
      expected: null,
      actual: null,
      evidence: null,
      projectId: "proj_1",
      projectVersion: 1,
      environmentKind: null,
      documentName: null,
      evaluatedAt: new Date().toISOString(),
      metadata: {}
    };
    verificationResultStore.save(verificationResult);
    ({ state } = recordTransition(history, state, { kind: "update_experiment", experimentId: experiment.id, patch: { verificationResultIds: ["vr_1"] } }));

    const result = compareCandidates([a], state, verificationResultStore);
    assert.equal(result.candidates[0]!.experiments[0]!.checks.length, 1);
    assert.equal(result.candidates[0]!.experiments[0]!.checks[0]!.status, "pass");
    assert.equal(result.candidates[0]!.experiments[0]!.checks[0]!.checkId, "check_1");
  });

  it("omits a verificationResultId that doesn't resolve in the store, rather than throwing", () => {
    const a = createCandidate(candidateInput());
    const history = createChangeHistory();
    let state = buildState();
    ({ state } = recordTransition(history, state, { kind: "add_experiment", experiment: { objective: "o", hypothesis: "h", candidateId: a.id, status: "complete" } }));
    const experiment = state.project.experiments[0]!;
    ({ state } = recordTransition(history, state, { kind: "update_experiment", experimentId: experiment.id, patch: { verificationResultIds: ["vr_missing"] } }));

    const result = compareCandidates([a], state, createVerificationResultStore());
    assert.deepEqual(result.candidates[0]!.experiments[0]!.checks, []);
  });

  it("is pure -- never mutates the candidates or the state", () => {
    const a = createCandidate(candidateInput());
    const state = buildState();
    const beforeCandidate = JSON.stringify(a);
    const beforeState = JSON.stringify(state);
    compareCandidates([a], state);
    assert.equal(JSON.stringify(a), beforeCandidate);
    assert.equal(JSON.stringify(state), beforeState);
  });
});
