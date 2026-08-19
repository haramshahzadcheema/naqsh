import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidateMetricValue,
  createOptimizationConstraint,
  createOptimizationObjective,
  createOptimizationProblem,
  createOptimizationResult,
  deserializeCandidateMetricValue,
  deserializeOptimizationProblem,
  deserializeOptimizationResult,
  serializeCandidateMetricValue,
  serializeOptimizationProblem,
  serializeOptimizationResult,
  WorldModelValidationError,
  type CandidateEvaluation,
  type CandidateMetricValueInput,
  type OptimizationConstraintInput,
  type OptimizationObjectiveInput,
  type OptimizationProblemInput,
  type OptimizationResultInput
} from "../src/index.js";

function objectiveInput(overrides: Partial<OptimizationObjectiveInput> = {}): OptimizationObjectiveInput {
  return { metricKey: "mass", description: "Minimize mass.", direction: "minimize", ...overrides };
}

function constraintInput(overrides: Partial<OptimizationConstraintInput> = {}): OptimizationConstraintInput {
  return { metricKey: "mass", description: "Mass must not exceed 10kg.", operator: "lte", threshold: 10, ...overrides };
}

function metricValueInput(overrides: Partial<CandidateMetricValueInput> = {}): CandidateMetricValueInput {
  return { candidateId: "cand_1", metricKey: "mass", provenanceKind: "declared", status: "estimated", value: 9.4, ...overrides };
}

function problemInput(overrides: Partial<OptimizationProblemInput> = {}): OptimizationProblemInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    candidateIds: ["cand_1", "cand_2"],
    objectives: [objectiveInput()],
    ...overrides
  };
}

describe("OptimizationObjective", () => {
  it("creates a valid objective with defaults", () => {
    const objective = createOptimizationObjective(objectiveInput());
    assert.equal(objective.direction, "minimize");
    assert.equal(objective.unit, null);
    assert.equal(objective.requirementId, null);
    assert.equal(objective.weight, null);
  });

  it("rejects an invalid direction", () => {
    assert.throws(() => createOptimizationObjective(objectiveInput({ direction: "bigger" as never })), WorldModelValidationError);
  });

  it("rejects a negative weight", () => {
    assert.throws(() => createOptimizationObjective(objectiveInput({ weight: -1 })), WorldModelValidationError);
  });

  it("rejects a NaN/Infinity weight", () => {
    assert.throws(() => createOptimizationObjective(objectiveInput({ weight: Number.NaN })), WorldModelValidationError);
    assert.throws(() => createOptimizationObjective(objectiveInput({ weight: Number.POSITIVE_INFINITY })), WorldModelValidationError);
  });

  it("rejects an empty metricKey", () => {
    assert.throws(() => createOptimizationObjective(objectiveInput({ metricKey: "" })), WorldModelValidationError);
  });

  it("accepts an explicit weight of 0 -- deliberately zeroed out, not the same as unset", () => {
    const objective = createOptimizationObjective(objectiveInput({ weight: 0 }));
    assert.equal(objective.weight, 0);
  });
});

describe("OptimizationConstraint", () => {
  it("creates a valid constraint reusing NumericComparisonOperator", () => {
    const constraint = createOptimizationConstraint(constraintInput());
    assert.equal(constraint.operator, "lte");
    assert.equal(constraint.threshold, 10);
  });

  it("rejects an invalid operator", () => {
    assert.throws(() => createOptimizationConstraint(constraintInput({ operator: "between" as never })), WorldModelValidationError);
  });

  it("rejects a non-finite threshold", () => {
    assert.throws(() => createOptimizationConstraint(constraintInput({ threshold: Number.NaN })), WorldModelValidationError);
  });
});

describe("CandidateMetricValue: status/provenanceKind/value consistency (the core integrity rule)", () => {
  it("accepts a measured value backed by a verification result", () => {
    const metric = createCandidateMetricValue(
      metricValueInput({ status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_1", value: 487 })
    );
    assert.equal(metric.status, "measured");
    assert.equal(metric.verificationResultId, "vr_1");
  });

  it("rejects status 'measured' with provenanceKind 'declared' -- a model estimate can never masquerade as measured", () => {
    assert.throws(
      () => createCandidateMetricValue(metricValueInput({ status: "measured", provenanceKind: "declared", value: 500 })),
      WorldModelValidationError
    );
  });

  it("rejects status 'measured' with no verificationResultId", () => {
    assert.throws(
      () => createCandidateMetricValue(metricValueInput({ status: "measured", provenanceKind: "verification_result", value: 500 })),
      WorldModelValidationError
    );
  });

  it("accepts status 'estimated' with provenanceKind 'declared'", () => {
    const metric = createCandidateMetricValue(metricValueInput({ status: "estimated", provenanceKind: "declared", value: 500 }));
    assert.equal(metric.status, "estimated");
  });

  it("accepts status 'estimated' with provenanceKind 'research_evidence'", () => {
    const metric = createCandidateMetricValue(
      metricValueInput({ status: "estimated", provenanceKind: "research_evidence", researchEvidenceId: "evid_1", value: 500 })
    );
    assert.equal(metric.provenanceKind, "research_evidence");
  });

  it("rejects provenanceKind 'research_evidence' with no researchEvidenceId", () => {
    assert.throws(
      () => createCandidateMetricValue(metricValueInput({ status: "estimated", provenanceKind: "research_evidence", value: 500 })),
      WorldModelValidationError
    );
  });

  it("rejects provenanceKind 'declared' carrying a dangling verificationResultId", () => {
    assert.throws(
      () => createCandidateMetricValue(metricValueInput({ status: "estimated", provenanceKind: "declared", verificationResultId: "vr_1", value: 500 })),
      WorldModelValidationError
    );
  });

  it("accepts status 'unavailable' with a null value", () => {
    const metric = createCandidateMetricValue(metricValueInput({ status: "unavailable", provenanceKind: "declared", value: null }));
    assert.equal(metric.value, null);
  });

  it("rejects status 'unavailable' with a non-null value -- 'missing' can never carry a fabricated number", () => {
    assert.throws(() => createCandidateMetricValue(metricValueInput({ status: "unavailable", provenanceKind: "declared", value: 5 })), WorldModelValidationError);
  });

  it("rejects NaN/Infinity as a value", () => {
    assert.throws(() => createCandidateMetricValue(metricValueInput({ value: Number.NaN })), WorldModelValidationError);
    assert.throws(() => createCandidateMetricValue(metricValueInput({ value: Number.POSITIVE_INFINITY })), WorldModelValidationError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const metric = createCandidateMetricValue(metricValueInput());
    const restored = deserializeCandidateMetricValue(serializeCandidateMetricValue(metric));
    assert.deepEqual(restored, metric);
  });
});

describe("OptimizationProblem", () => {
  it("creates a valid problem with nested objectives/constraints built through their own factories", () => {
    const problem = createOptimizationProblem(problemInput({ constraints: [constraintInput()] }));
    assert.equal(problem.objectives.length, 1);
    assert.equal(problem.constraints.length, 1);
    assert.equal(problem.normalizationMethod, "min_max");
  });

  it("rejects an empty candidateIds array", () => {
    assert.throws(() => createOptimizationProblem(problemInput({ candidateIds: [] })), WorldModelValidationError);
  });

  it("rejects an empty objectives array -- an optimization problem with nothing to optimize is not well-formed", () => {
    assert.throws(() => createOptimizationProblem(problemInput({ objectives: [] })), WorldModelValidationError);
  });

  it("defaults constraints to an empty array", () => {
    const problem = createOptimizationProblem(problemInput());
    assert.deepEqual(problem.constraints, []);
  });

  it("round-trips through JSON with full fidelity", () => {
    const problem = createOptimizationProblem(problemInput({ constraints: [constraintInput()] }));
    const restored = deserializeOptimizationProblem(serializeOptimizationProblem(problem));
    assert.deepEqual(restored, problem);
  });
});

describe("OptimizationResult", () => {
  function evaluation(overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation {
    return {
      candidateId: "cand_1",
      feasibility: "feasible",
      dataCompleteness: "complete",
      metrics: [{ metricKey: "mass", status: "measured", value: 9, unit: "kg", provenanceKind: "verification_result", metricValueId: "metricvalue_1" }],
      constraintResults: [],
      paretoEligible: true,
      weightedScore: null,
      ...overrides
    };
  }

  function resultInput(overrides: Partial<OptimizationResultInput> = {}): OptimizationResultInput {
    return {
      problemId: "optproblem_1",
      projectId: "proj_1",
      projectVersion: 1,
      candidateEvaluations: [evaluation()],
      paretoOptimalCandidateIds: ["cand_1"],
      dominatedCandidateIds: [],
      infeasibleCandidateIds: [],
      unknownFeasibilityCandidateIds: [],
      incompleteDataCandidateIds: [],
      dominance: [],
      ...overrides
    };
  }

  it("creates a valid result with defaults", () => {
    const result = createOptimizationResult(resultInput());
    assert.equal(result.algorithm, "pareto-dominance-v1");
    assert.equal(result.source, "system");
  });

  it("never carries a score/rank/winner field -- only the documented, factual keys", () => {
    const result = createOptimizationResult(resultInput());
    const keys = Object.keys(result);
    for (const forbidden of ["bestCandidateId", "winner", "recommendation", "rank"]) {
      assert.ok(!keys.includes(forbidden), `OptimizationResult must never carry a "${forbidden}" field`);
    }
  });

  it("rejects a dominance relation with no comparison where the dominator is strictly better", () => {
    assert.throws(
      () =>
        createOptimizationResult(
          resultInput({
            dominance: [
              {
                dominatorCandidateId: "cand_1",
                dominatedCandidateId: "cand_2",
                comparisons: [
                  { metricKey: "mass", direction: "minimize", dominatorValue: 9, dominatedValue: 9, dominatorAtLeastAsGood: true, dominatorStrictlyBetter: false }
                ]
              }
            ]
          })
        ),
      WorldModelValidationError
    );
  });

  it("rejects a dominance relation where the dominator is NOT at least as good on every comparison", () => {
    assert.throws(
      () =>
        createOptimizationResult(
          resultInput({
            dominance: [
              {
                dominatorCandidateId: "cand_1",
                dominatedCandidateId: "cand_2",
                comparisons: [
                  { metricKey: "mass", direction: "minimize", dominatorValue: 9, dominatedValue: 8, dominatorAtLeastAsGood: false, dominatorStrictlyBetter: false },
                  { metricKey: "cost", direction: "minimize", dominatorValue: 500, dominatedValue: 800, dominatorAtLeastAsGood: true, dominatorStrictlyBetter: true }
                ]
              }
            ]
          })
        ),
      WorldModelValidationError
    );
  });

  it("round-trips through JSON with full fidelity", () => {
    const result = createOptimizationResult(resultInput());
    const restored = deserializeOptimizationResult(serializeOptimizationResult(result));
    assert.deepEqual(restored, result);
  });
});
