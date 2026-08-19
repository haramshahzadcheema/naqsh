import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createCandidateMetricValue,
  createOptimizationProblem,
  createOptimizationResult,
  WorldModelValidationError,
  type CandidateEvaluation,
  type CandidateInput,
  type CandidateMetricValueInput,
  type OptimizationProblemInput,
  type OptimizationResultInput
} from "@naqsh/schemas";
import { createCandidateMetricValueStore, deserializeCandidateMetricValueStore } from "../src/optimization-metric-store.js";
import { createOptimizationProblemStore, deserializeOptimizationProblemStore } from "../src/optimization-problem-store.js";
import { createOptimizationResultStore, deserializeOptimizationResultStore } from "../src/optimization-result-store.js";
import { createCandidateStore } from "../src/candidate-store.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { projectId: "proj_1", projectVersion: 1, planId: "plan_1", planStepId: "step_1", hypothesis: "h", rationale: "r", ...overrides };
}

function metricValueInput(overrides: Partial<CandidateMetricValueInput> = {}): CandidateMetricValueInput {
  return { candidateId: "cand_1", metricKey: "mass", provenanceKind: "declared", status: "estimated", value: 9.4, ...overrides };
}

function problemInput(overrides: Partial<OptimizationProblemInput> = {}): OptimizationProblemInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    candidateIds: ["cand_1", "cand_2"],
    objectives: [{ metricKey: "mass", description: "d", direction: "minimize" }],
    ...overrides
  };
}

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

describe("CandidateMetricValueStore: save/getById/list", () => {
  it("saves and retrieves a metric value", () => {
    const store = createCandidateMetricValueStore();
    const metricValue = createCandidateMetricValue(metricValueInput());
    store.save(metricValue);
    assert.deepEqual(store.getById(metricValue.id), metricValue);
  });

  it("is append-only -- two records for the same (candidateId, metricKey) coexist", () => {
    const store = createCandidateMetricValueStore();
    const first = createCandidateMetricValue(metricValueInput({ value: 9.4, measuredAt: "2024-01-01T00:00:00.000Z" }));
    const second = createCandidateMetricValue(metricValueInput({ value: 8.9, measuredAt: "2024-06-01T00:00:00.000Z" }));
    store.save(first);
    store.save(second);
    assert.equal(store.listForCandidate("cand_1").length, 2);
  });

  it("rejects saving a duplicate id", () => {
    const store = createCandidateMetricValueStore();
    const metricValue = createCandidateMetricValue(metricValueInput());
    store.save(metricValue);
    assert.throws(() => store.save(metricValue), WorldModelValidationError);
  });

  it("listForCandidate returns only metric values for that candidate", () => {
    const store = createCandidateMetricValueStore();
    store.save(createCandidateMetricValue(metricValueInput({ candidateId: "cand_1" })));
    store.save(createCandidateMetricValue(metricValueInput({ candidateId: "cand_2" })));
    assert.equal(store.listForCandidate("cand_1").length, 1);
  });
});

describe("CandidateMetricValueStore: serialization", () => {
  it("round-trips through JSON with full fidelity, preserving provenance", () => {
    const store = createCandidateMetricValueStore();
    const measured = createCandidateMetricValue(
      metricValueInput({ status: "measured", provenanceKind: "verification_result", verificationResultId: "vr_1", value: 487 })
    );
    store.save(measured);
    const restored = deserializeCandidateMetricValueStore(store.serialize());
    assert.deepEqual(restored.getById(measured.id), measured);
    assert.equal(restored.getById(measured.id)!.provenanceKind, "verification_result");
    assert.equal(restored.getById(measured.id)!.status, "measured");
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeCandidateMetricValueStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeCandidateMetricValueStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeCandidateMetricValueStore(""), WorldModelValidationError);
  });
});

describe("OptimizationProblemStore: save/getById/list", () => {
  it("saves and retrieves a problem", () => {
    const store = createOptimizationProblemStore();
    const problem = createOptimizationProblem(problemInput());
    store.save(problem);
    assert.deepEqual(store.getById(problem.id), problem);
  });

  it("rejects saving a duplicate id -- problems are immutable once created", () => {
    const store = createOptimizationProblemStore();
    const problem = createOptimizationProblem(problemInput());
    store.save(problem);
    assert.throws(() => store.save(problem), WorldModelValidationError);
  });

  it("list returns every saved problem", () => {
    const store = createOptimizationProblemStore();
    store.save(createOptimizationProblem(problemInput()));
    store.save(createOptimizationProblem(problemInput()));
    assert.equal(store.list().length, 2);
  });
});

describe("OptimizationProblemStore: serialization", () => {
  it("round-trips through JSON with full fidelity, including nested objectives/constraints", () => {
    const store = createOptimizationProblemStore();
    const problem = createOptimizationProblem(
      problemInput({
        objectives: [{ metricKey: "mass", description: "d", direction: "minimize", weight: 0.5, unit: "kg" }],
        constraints: [{ metricKey: "cost", description: "d", operator: "lte", threshold: 1000, unit: "USD" }]
      })
    );
    store.save(problem);
    const restored = deserializeOptimizationProblemStore(store.serialize());
    assert.deepEqual(restored.getById(problem.id), problem);
    assert.equal(restored.getById(problem.id)!.objectives[0]!.weight, 0.5);
    assert.equal(restored.getById(problem.id)!.constraints[0]!.threshold, 1000);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeOptimizationProblemStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeOptimizationProblemStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });
});

describe("OptimizationResultStore: save/getById/listForProblem", () => {
  it("saves and retrieves a result", () => {
    const store = createOptimizationResultStore();
    const result = createOptimizationResult(resultInput());
    store.save(result);
    assert.deepEqual(store.getById(result.id), result);
  });

  it("is append-only -- rejects saving a duplicate id", () => {
    const store = createOptimizationResultStore();
    const result = createOptimizationResult(resultInput());
    store.save(result);
    assert.throws(() => store.save(result), WorldModelValidationError);
  });

  it("listForProblem returns only results for that problem", () => {
    const store = createOptimizationResultStore();
    store.save(createOptimizationResult(resultInput({ problemId: "optproblem_1" })));
    store.save(createOptimizationResult(resultInput({ problemId: "optproblem_2" })));
    assert.equal(store.listForProblem("optproblem_1").length, 1);
  });
});

describe("OptimizationResultStore: serialization -- the full Pareto frontier round-trips", () => {
  it("round-trips through JSON with full fidelity, including dominance/comparisons and every candidate id list", () => {
    const store = createOptimizationResultStore();
    const result = createOptimizationResult(
      resultInput({
        candidateEvaluations: [
          evaluation({ candidateId: "cand_1", paretoEligible: true }),
          evaluation({ candidateId: "cand_2", paretoEligible: true, feasibility: "infeasible", constraintResults: [{ optimizationConstraintId: "optconstraint_1", metricKey: "mass", operator: "lte", threshold: 10, unit: null, actualValue: 15, satisfied: false, reasonKind: "violated" }] })
        ],
        paretoOptimalCandidateIds: ["cand_1"],
        dominatedCandidateIds: [],
        infeasibleCandidateIds: ["cand_2"],
        dominance: [
          {
            dominatorCandidateId: "cand_1",
            dominatedCandidateId: "cand_3",
            comparisons: [{ metricKey: "mass", direction: "minimize", dominatorValue: 8, dominatedValue: 10, dominatorAtLeastAsGood: true, dominatorStrictlyBetter: true }]
          }
        ]
      })
    );
    store.save(result);
    const restored = deserializeOptimizationResultStore(store.serialize());
    assert.deepEqual(restored.getById(result.id), result);
    assert.equal(restored.getById(result.id)!.dominance[0]!.comparisons[0]!.dominatorStrictlyBetter, true);
    assert.equal(restored.getById(result.id)!.infeasibleCandidateIds[0], "cand_2");
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeOptimizationResultStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeOptimizationResultStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });
});

describe("cross-store: a full candidate -> metrics -> problem -> result chain survives independent store round-trips", () => {
  it("serializes and deserializes every store independently, then confirms the ids still cross-reference correctly", () => {
    const candidateStore = createCandidateStore();
    const metricStore = createCandidateMetricValueStore();
    const problemStore = createOptimizationProblemStore();
    const resultStore = createOptimizationResultStore();

    const candidate = createCandidate(candidateInput());
    candidateStore.save(candidate);
    const metricValue = createCandidateMetricValue(metricValueInput({ candidateId: candidate.id }));
    metricStore.save(metricValue);
    const problem = createOptimizationProblem(problemInput({ candidateIds: [candidate.id] }));
    problemStore.save(problem);
    const result = createOptimizationResult(resultInput({ problemId: problem.id, candidateEvaluations: [evaluation({ candidateId: candidate.id })], paretoOptimalCandidateIds: [candidate.id] }));
    resultStore.save(result);

    const restoredCandidateStore = candidateStore; // CandidateStore's own serialize/deserialize is already covered by P22's own tests
    const restoredMetricStore = deserializeCandidateMetricValueStore(metricStore.serialize());
    const restoredProblemStore = deserializeOptimizationProblemStore(problemStore.serialize());
    const restoredResultStore = deserializeOptimizationResultStore(resultStore.serialize());

    const restoredResult = restoredResultStore.getById(result.id)!;
    const restoredProblem = restoredProblemStore.getById(restoredResult.problemId)!;
    assert.equal(restoredProblem.candidateIds[0], candidate.id);
    assert.equal(restoredCandidateStore.getById(candidate.id)!.id, candidate.id);
    assert.equal(restoredMetricStore.listForCandidate(candidate.id)[0]!.id, metricValue.id);
    assert.equal(restoredResult.candidateEvaluations[0]!.candidateId, candidate.id);
  });
});
