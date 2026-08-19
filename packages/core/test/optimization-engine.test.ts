import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidateMetricValue,
  createOptimizationProblem,
  type CandidateMetricValueInput,
  type OptimizationConstraintInput,
  type OptimizationObjectiveInput,
  type OptimizationProblemInput
} from "@naqsh/schemas";
import { computeOptimizationResult } from "../src/optimization-engine.js";
import { createCandidateMetricValueStore, type CandidateMetricValueStore } from "../src/optimization-metric-store.js";

function objective(overrides: Partial<OptimizationObjectiveInput> = {}): OptimizationObjectiveInput {
  return { metricKey: "mass", description: "d", direction: "minimize", ...overrides };
}

function constraint(overrides: Partial<OptimizationConstraintInput> = {}): OptimizationConstraintInput {
  return { metricKey: "mass", description: "d", operator: "lte", threshold: 10, ...overrides };
}

function problem(overrides: Partial<OptimizationProblemInput> = {}) {
  return createOptimizationProblem({
    projectId: "proj_1",
    projectVersion: 1,
    candidateIds: ["cand_a", "cand_b", "cand_c"],
    objectives: [objective()],
    ...overrides
  });
}

let vrCounter = 0;
function measure(store: CandidateMetricValueStore, candidateId: string, metricKey: string, value: number | null, overrides: Partial<CandidateMetricValueInput> = {}): void {
  vrCounter += 1;
  const status = overrides.status ?? (value === null ? "unavailable" : "measured");
  const provenanceKind = overrides.provenanceKind ?? (status === "measured" ? "verification_result" : "declared");
  const input: CandidateMetricValueInput = {
    candidateId,
    metricKey,
    status,
    provenanceKind,
    value,
    verificationResultId: provenanceKind === "verification_result" ? `vr_${vrCounter}` : null,
    ...overrides
  };
  store.save(createCandidateMetricValue(input));
}

describe("computeOptimizationResult: single objective", () => {
  it("minimize: the candidate with the lowest value is the sole Pareto-optimal one", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_c", "mass", 12);
    const result = computeOptimizationResult(problem(), store);
    assert.deepEqual(result.paretoOptimalCandidateIds, ["cand_b"]);
    assert.deepEqual([...result.dominatedCandidateIds].sort(), ["cand_a", "cand_c"]);
  });

  it("maximize: the candidate with the highest value is the sole Pareto-optimal one", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "strength", 100);
    measure(store, "cand_b", "strength", 130);
    measure(store, "cand_c", "strength", 90);
    const result = computeOptimizationResult(problem({ objectives: [objective({ metricKey: "strength", direction: "maximize" })] }), store);
    assert.deepEqual(result.paretoOptimalCandidateIds, ["cand_b"]);
  });
});

describe("computeOptimizationResult: the brief's realistic mass/cost/strength example, verified mathematically", () => {
  it("A(10,500,100) B(8,700,130) C(12,450,90) with mass/cost minimize, strength maximize -- all three are mutually non-dominated", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_a", "strength", 100);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    measure(store, "cand_b", "strength", 130);
    measure(store, "cand_c", "mass", 12);
    measure(store, "cand_c", "cost", 450);
    measure(store, "cand_c", "strength", 90);

    const result = computeOptimizationResult(
      problem({
        objectives: [objective({ metricKey: "mass", direction: "minimize" }), objective({ metricKey: "cost", direction: "minimize" }), objective({ metricKey: "strength", direction: "maximize" })]
      }),
      store
    );

    // A vs B: B better mass&strength, A better cost -> mixed, neither dominates.
    // A vs C: A better mass&strength, C better cost -> mixed, neither dominates.
    // B vs C: B better mass&strength, C better cost -> mixed, neither dominates.
    assert.deepEqual(result.dominance, []);
    assert.deepEqual([...result.paretoOptimalCandidateIds].sort(), ["cand_a", "cand_b", "cand_c"]);
    assert.deepEqual(result.dominatedCandidateIds, []);
  });
});

describe("computeOptimizationResult: Pareto dominance and frontier", () => {
  it("A dominates D when A is at-least-as-good on every objective and strictly better on at least one", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 11);
    measure(store, "cand_b", "cost", 600);
    const objectives = [objective({ metricKey: "mass" }), objective({ metricKey: "cost" })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);

    assert.deepEqual(result.paretoOptimalCandidateIds, ["cand_a"]);
    assert.deepEqual(result.dominatedCandidateIds, ["cand_b"]);
    assert.equal(result.dominance.length, 1);
    assert.equal(result.dominance[0]!.dominatorCandidateId, "cand_a");
    assert.equal(result.dominance[0]!.dominatedCandidateId, "cand_b");
    assert.equal(result.dominance[0]!.comparisons.length, 2);
    assert.ok(result.dominance[0]!.comparisons.every((c) => c.dominatorAtLeastAsGood));
    assert.ok(result.dominance[0]!.comparisons.some((c) => c.dominatorStrictlyBetter));
  });

  it("a completely dominated candidate is excluded from paretoOptimalCandidateIds and listed in dominatedCandidateIds", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 5);
    measure(store, "cand_c", "mass", 15);
    const result = computeOptimizationResult(problem(), store);
    assert.ok(!result.paretoOptimalCandidateIds.includes("cand_c"));
    assert.ok(result.dominatedCandidateIds.includes("cand_c"));
  });

  it("identical candidates: neither dominates the other; both remain Pareto-optimal (a tie, not an error)", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 10);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"] }), store);
    assert.deepEqual([...result.paretoOptimalCandidateIds].sort(), ["cand_a", "cand_b"]);
    assert.deepEqual(result.dominance, []);
  });

  it("never claims a Pareto-optimal candidate is 'the best' -- multiple ids can legitimately coexist", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    const result = computeOptimizationResult(problem({ objectives: [objective({ metricKey: "mass" }), objective({ metricKey: "cost" })] }), store);
    assert.equal(result.paretoOptimalCandidateIds.length, 2);
  });
});

describe("computeOptimizationResult: hard constraints and feasibility", () => {
  it("a candidate violating a hard constraint is infeasible and excluded from the Pareto set", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 8);
    measure(store, "cand_b", "mass", 15); // violates mass <= 10
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], constraints: [constraint({ threshold: 10 })] }), store);

    const evalB = result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!;
    assert.equal(evalB.feasibility, "infeasible");
    assert.equal(evalB.paretoEligible, false);
    assert.ok(result.infeasibleCandidateIds.includes("cand_b"));
    assert.ok(!result.paretoOptimalCandidateIds.includes("cand_b"));
    assert.ok(!result.dominatedCandidateIds.includes("cand_b"), "an infeasible candidate is never reported as merely dominated -- it is a distinct category");
  });

  it("infeasible candidates never dominate or get dominated -- they are excluded from Pareto analysis, not silently hidden from the result", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 20); // infeasible, but numerically "best" on mass would be wrong to assume
    measure(store, "cand_b", "mass", 5);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], constraints: [constraint({ threshold: 10 })] }), store);
    assert.deepEqual(result.paretoOptimalCandidateIds, ["cand_b"]);
    assert.equal(result.dominance.length, 0, "cand_a is infeasible, so it cannot participate in dominance at all -- not even as the loser");
  });

  it("unknown feasibility (missing constraint metric) is a distinct, non-collapsed state -- never silently treated as feasible", () => {
    const store = createCandidateMetricValueStore();
    // No metric recorded for cand_a's mass at all.
    measure(store, "cand_b", "mass", 5);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], constraints: [constraint({ threshold: 10 })] }), store);
    const evalA = result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!;
    assert.equal(evalA.feasibility, "unknown");
    assert.ok(result.unknownFeasibilityCandidateIds.includes("cand_a"));
    assert.ok(!result.infeasibleCandidateIds.includes("cand_a"));
    assert.ok(!result.paretoOptimalCandidateIds.includes("cand_a"));
  });

  it("a DEFINITE violation always wins over an unknown constraint on another metric -- infeasible, not unknown", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 15); // violates mass <= 10
    // cost has no metric recorded -- would be "unknown" in isolation.
    const result = computeOptimizationResult(
      problem({ candidateIds: ["cand_a"], constraints: [constraint({ metricKey: "mass", threshold: 10 }), constraint({ metricKey: "cost", threshold: 1000 })] }),
      store
    );
    assert.equal(result.candidateEvaluations[0]!.feasibility, "infeasible");
  });

  it("zero constraints means every candidate is feasible by default", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 999999);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [] }), store);
    assert.equal(result.candidateEvaluations[0]!.feasibility, "feasible");
  });
});

describe("computeOptimizationResult: missing objective metrics (data completeness)", () => {
  it("a candidate missing an OBJECTIVE metric is 'incomplete' and excluded from Pareto analysis, reported separately from infeasible/unknown", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    // cand_b has no cost metric at all.
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives: [objective({ metricKey: "mass" }), objective({ metricKey: "cost" })] }), store);

    const evalB = result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!;
    assert.equal(evalB.dataCompleteness, "incomplete");
    assert.equal(evalB.paretoEligible, false);
    assert.ok(result.incompleteDataCandidateIds.includes("cand_b"));
    assert.ok(!result.infeasibleCandidateIds.includes("cand_b"));
    assert.ok(!result.unknownFeasibilityCandidateIds.includes("cand_b"));
    assert.ok(!result.dominatedCandidateIds.includes("cand_b"));
  });

  it("never fabricates a missing value -- the embedded snapshot reports status 'unavailable' and value null", () => {
    const store = createCandidateMetricValueStore();
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"] }), store);
    const snapshot = result.candidateEvaluations[0]!.metrics.find((m) => m.metricKey === "mass")!;
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.value, null);
  });
});

describe("computeOptimizationResult: unit mismatch", () => {
  it("a metric whose unit disagrees with the objective's declared unit is treated as unusable, never silently compared", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10, { unit: "lb" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], objectives: [objective({ metricKey: "mass", unit: "kg" })] }), store);
    assert.equal(result.candidateEvaluations[0]!.dataCompleteness, "incomplete");
  });

  it("a metric whose unit disagrees with a constraint's declared unit reports satisfied: null, reasonKind: unit_mismatch", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 22, { unit: "lb" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ unit: "kg", threshold: 10 })] }), store);
    const outcome = result.candidateEvaluations[0]!.constraintResults[0]!;
    assert.equal(outcome.satisfied, null);
    assert.equal(outcome.reasonKind, "unit_mismatch");
    assert.equal(outcome.actualValue, 22, "the raw value is still surfaced for transparency, even though it wasn't used for the satisfied determination");
  });

  it("matching units on both sides compare normally", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 8, { unit: "kg" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ unit: "kg", threshold: 10 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, true);
  });

  it("a NULL declared unit (the constraint/objective doesn't care about units) compares normally regardless of the metric's own unit", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 8, { unit: "lb" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ unit: null, threshold: 10 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, true);
  });

  it("AUDIT FIX REGRESSION: a metric with NO recorded unit is treated as UNUSABLE when the constraint/objective DOES declare one -- never silently assumed compatible. Exactly mirrors P16's verify.ts checkUnitCompatible (expectedUnit===null || evidenceUnit===expectedUnit), which an earlier version of this file diverged from.", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 8); // no unit recorded at all
    const constraintResult = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ unit: "kg", threshold: 10 })] }), store);
    const outcome = constraintResult.candidateEvaluations[0]!.constraintResults[0]!;
    assert.equal(outcome.satisfied, null);
    assert.equal(outcome.reasonKind, "unit_mismatch");

    const objectiveResult = computeOptimizationResult(problem({ candidateIds: ["cand_a"], objectives: [objective({ metricKey: "mass", unit: "kg" })] }), store);
    assert.equal(objectiveResult.candidateEvaluations[0]!.dataCompleteness, "incomplete");
  });
});

describe("computeOptimizationResult: hard constraint boundary semantics", () => {
  it("lte: exactly on the boundary is SATISFIED, not violated", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ operator: "lte", threshold: 10 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, true);
  });

  it("lte: a hair below the boundary is SATISFIED", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 9.9999);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ operator: "lte", threshold: 10 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, true);
  });

  it("lte: a hair above the boundary is VIOLATED -- no hidden tolerance", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10.0001);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ operator: "lte", threshold: 10 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, false);
  });

  it("gte: exactly on the boundary is SATISFIED", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "strength", 150);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ metricKey: "strength", operator: "gte", threshold: 150 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, true);
  });

  it("gte: a hair below the boundary is VIOLATED", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "strength", 149.9999);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], constraints: [constraint({ metricKey: "strength", operator: "gte", threshold: 150 })] }), store);
    assert.equal(result.candidateEvaluations[0]!.constraintResults[0]!.satisfied, false);
  });
});

describe("computeOptimizationResult: defensive structural validation (AUDIT FIX -- a pure function must not silently trust an unvalidated caller)", () => {
  it("rejects two objectives sharing the same metricKey rather than silently double-counting it", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    assert.throws(() =>
      computeOptimizationResult(
        problem({ candidateIds: ["cand_a"], objectives: [objective({ metricKey: "mass", direction: "minimize" }), objective({ metricKey: "mass", direction: "maximize" })] }),
        store
      )
    );
  });

  it("rejects a duplicated candidateId rather than silently producing duplicated output", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    assert.throws(() => computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_a"] }), store));
  });
});

describe("computeOptimizationResult: weighted scoring (explicit, opt-in)", () => {
  it("no objective has a weight -> weightedScore is null for every candidate, Pareto/tradeoff analysis still runs", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 8);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"] }), store);
    assert.ok(result.candidateEvaluations.every((e) => e.weightedScore === null));
    assert.equal(result.paretoOptimalCandidateIds.length, 1, "Pareto analysis is unaffected by the absence of weights");
  });

  it("only SOME objectives weighted -> weightedScore stays null for every candidate (never a partial/implicit weight)", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    const objectives = [objective({ metricKey: "mass", weight: 0.5 }), objective({ metricKey: "cost", weight: null })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    assert.ok(result.candidateEvaluations.every((e) => e.weightedScore === null));
  });

  it("every objective weighted -> min-max normalized weighted sum, respecting direction, mathematically verified", () => {
    const store = createCandidateMetricValueStore();
    // mass: minimize, range [8,10] -> A(10)->0, B(8)->1
    // cost: minimize, range [500,700] -> A(500)->1, B(700)->0
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    const objectives = [objective({ metricKey: "mass", weight: 0.5 }), objective({ metricKey: "cost", weight: 0.5 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);

    const evalA = result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!;
    const evalB = result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!;
    assert.equal(evalA.weightedScore, 0.5 * 0 + 0.5 * 1); // 0.5
    assert.equal(evalB.weightedScore, 0.5 * 1 + 0.5 * 0); // 0.5
  });

  it("a weight of 0 zeroes out that objective's contribution without excluding it from validation/normalization", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    const objectives = [objective({ metricKey: "mass", weight: 0 }), objective({ metricKey: "cost", weight: 1 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    const evalA = result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!;
    const evalB = result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!;
    assert.equal(evalA.weightedScore, 1); // cost=500 is the best -> normalized 1, mass contributes 0
    assert.equal(evalB.weightedScore, 0);
  });

  it("a candidate missing a value for a weighted objective gets weightedScore null; others still score normally", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    // cand_b has no cost.
    const objectives = [objective({ metricKey: "mass", weight: 0.5 }), objective({ metricKey: "cost", weight: 0.5 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    assert.notEqual(result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!.weightedScore, null);
    assert.equal(result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!.weightedScore, null);
  });

  it("ties in weighted score are represented plainly -- no arbitrary ranking or ordering is imposed", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 10);
    const objectives = [objective({ metricKey: "mass", weight: 1 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    const evalA = result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!;
    const evalB = result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!;
    assert.equal(evalA.weightedScore, evalB.weightedScore);
    // Order is preserved exactly as input, never re-sorted by score.
    assert.deepEqual(
      result.candidateEvaluations.map((e) => e.candidateId),
      ["cand_a", "cand_b"]
    );
  });
});

describe("computeOptimizationResult: normalization edge cases", () => {
  it("a zero range (every candidate has the same value for an objective) normalizes to 1.0 for all of them, not a division by zero", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_b", "mass", 10);
    measure(store, "cand_c", "mass", 10);
    const objectives = [objective({ metricKey: "mass", weight: 1 })];
    const result = computeOptimizationResult(problem({ objectives }), store);
    assert.ok(result.candidateEvaluations.every((e) => e.weightedScore === 1));
  });

  it("handles negative values correctly (e.g. a temperature-delta metric)", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "delta", -5);
    measure(store, "cand_b", "delta", -10);
    const objectives = [objective({ metricKey: "delta", direction: "minimize", weight: 1 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    // minimize: range [-10,-5], A=-5 (worse) -> 0, B=-10 (better) -> 1
    assert.equal(result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!.weightedScore, 0);
    assert.equal(result.candidateEvaluations.find((e) => e.candidateId === "cand_b")!.weightedScore, 1);
  });

  it("mixed-scale metrics (cost in the hundreds, mass in single digits) never accidentally compared as raw numbers -- normalization uses each objective's OWN range", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 9);
    measure(store, "cand_a", "cost", 1000);
    measure(store, "cand_b", "mass", 10);
    measure(store, "cand_b", "cost", 900);
    const objectives = [objective({ metricKey: "mass", weight: 0.5 }), objective({ metricKey: "cost", weight: 0.5 })];
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a", "cand_b"], objectives }), store);
    const evalA = result.candidateEvaluations.find((e) => e.candidateId === "cand_a")!;
    // mass range[9,10]: A(9)->1; cost range[900,1000]: A(1000)->0 => 0.5*1+0.5*0=0.5
    assert.equal(evalA.weightedScore, 0.5);
  });
});

describe("computeOptimizationResult: determinism and reproducibility", () => {
  it("identical input always produces identical (deterministic) analysis, run twice", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_a", "cost", 500);
    measure(store, "cand_b", "mass", 8);
    measure(store, "cand_b", "cost", 700);
    const objectives = [objective({ metricKey: "mass", weight: 0.5 }), objective({ metricKey: "cost", weight: 0.5 })];
    const p = problem({ candidateIds: ["cand_a", "cand_b"], objectives });

    const first = computeOptimizationResult(p, store);
    const second = computeOptimizationResult(p, store);

    assert.deepEqual(first.candidateEvaluations, second.candidateEvaluations);
    assert.deepEqual(first.paretoOptimalCandidateIds, second.paretoOptimalCandidateIds);
    assert.deepEqual(first.dominatedCandidateIds, second.dominatedCandidateIds);
    assert.deepEqual(first.dominance, second.dominance);
    assert.equal(first.algorithm, second.algorithm);
  });

  it("output candidate ordering always follows the PROBLEM's own candidateIds order, never object/Map iteration order", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_z", "mass", 5);
    measure(store, "cand_a", "mass", 10);
    measure(store, "cand_m", "mass", 7);
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_z", "cand_a", "cand_m"] }), store);
    assert.deepEqual(
      result.candidateEvaluations.map((e) => e.candidateId),
      ["cand_z", "cand_a", "cand_m"]
    );
  });

  it("re-measuring a candidate's metric (a later, more recent value) is what the engine uses -- the earlier record stays a real historical fact, never overwritten", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10, { measuredAt: "2024-01-01T00:00:00.000Z" });
    measure(store, "cand_a", "mass", 7, { measuredAt: "2024-06-01T00:00:00.000Z" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"] }), store);
    assert.equal(result.candidateEvaluations[0]!.metrics[0]!.value, 7);
    assert.equal(store.listForCandidate("cand_a").length, 2, "both historical records remain in the append-only store");
  });
});

describe("computeOptimizationResult: provenance preservation", () => {
  it("a measured metric's verificationResultId and provenanceKind survive into the embedded snapshot", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 9.4, { verificationResultId: "vr_specific", provenanceKind: "verification_result", status: "measured" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"] }), store);
    const snapshot = result.candidateEvaluations[0]!.metrics[0]!;
    assert.equal(snapshot.status, "measured");
    assert.equal(snapshot.provenanceKind, "verification_result");
  });

  it("an estimated metric is never confused with a measured one -- explainability preserves the distinction end to end", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "cost", 500, { status: "estimated", provenanceKind: "declared" });
    const result = computeOptimizationResult(problem({ candidateIds: ["cand_a"], objectives: [objective({ metricKey: "cost" })] }), store);
    const snapshot = result.candidateEvaluations[0]!.metrics[0]!;
    assert.equal(snapshot.status, "estimated");
    assert.notEqual(snapshot.status, "measured");
  });
});

describe("computeOptimizationResult: purity", () => {
  it("never mutates the problem", () => {
    const store = createCandidateMetricValueStore();
    measure(store, "cand_a", "mass", 10);
    const p = problem({ candidateIds: ["cand_a"] });
    const before = JSON.stringify(p);
    computeOptimizationResult(p, store);
    assert.equal(JSON.stringify(p), before);
  });
});
