import {
  createOptimizationResult,
  WorldModelValidationError,
  type CandidateEvaluation,
  type CandidateFeasibility,
  type CandidateMetricSnapshot,
  type ConstraintEvaluationOutcome,
  type DataCompleteness,
  type DominanceRelation,
  type ObjectiveComparisonEntry,
  type OptimizationConstraint,
  type OptimizationObjective,
  type OptimizationProblem,
  type OptimizationResult
} from "@naqsh/schemas";
import type { CandidateMetricValueStore } from "./optimization-metric-store.js";
import { compareNumeric } from "./verify.js";

/**
 * Phase 23's deterministic ANALYSIS core: `OptimizationProblem` + recorded
 * `CandidateMetricValue`s -> `OptimizationResult`. The brief's own central
 * rule, enforced structurally here, not merely followed by convention:
 * "NAQSH may optimize based on VERIFIED/MEASURED engineering results. It
 * must NOT optimize based on arbitrary LLM opinions." This function is PURE
 * (reads `problem`/`metricValueStore`, writes to neither), takes no model
 * provider, and is the ONLY place Pareto dominance, feasibility, and
 * (optional) weighted scores are ever computed -- Gemini may propose an
 * `OptimizationProblem`'s objectives/weights (validated deterministically
 * before use, same as any other model-generated input reaching a tool), but
 * it never touches this math, mirrors `evaluateCheck`/`evaluateObjectiveSatisfaction`'s
 * (P16/P17) identical "no LLM verdict" precedent one layer up.
 *
 * ALGORITHM, spelled out (the brief's own "make tie-breaking/algorithm
 * choices explicit" requirement):
 *
 *   1. For each candidate, resolve the MOST RECENT `CandidateMetricValue`
 *      per relevant metricKey (objective ∪ constraint metricKeys) from
 *      `metricValueStore` -- "most recent" by `measuredAt`, ties broken by
 *      preferring the value that appears LATER in the store's own
 *      insertion order (deterministic, since the store never reorders).
 *      A metric whose `unit` disagrees with the objective/constraint's
 *      declared `unit` is treated as UNUSABLE for that objective/constraint
 *      (never silently compared as equal -- mirrors P16's `verify.ts`
 *      `unit_mismatch` precedent exactly), even though its raw value/unit
 *      still appear in the embedded snapshot for transparency.
 *   2. Constraint satisfaction reuses P16's own `compareNumeric` (exact
 *      comparison, no hidden tolerance) -- never a second comparison
 *      implementation.
 *   3. Feasibility: "infeasible" if ANY constraint is definitively
 *      violated (a definite violation always wins over an unknown one);
 *      else "unknown" if any constraint's metric was unusable/unavailable;
 *      else "feasible" (including the case of zero constraints).
 *   4. Data completeness: "complete" iff every OBJECTIVE metricKey (not
 *      constraint) has a usable value for this candidate.
 *   5. Pareto dominance is computed ONLY among candidates that are BOTH
 *      feasible AND data-complete (`paretoEligible`) -- an infeasible or
 *      data-incomplete candidate can never dominate or be dominated;
 *      iterating `problem.candidateIds` in its own declared order for both
 *      the outer and inner loop (never object/Map iteration order), A
 *      dominates B iff A is at-least-as-good on every objective (respecting
 *      each objective's own `direction`) AND strictly better on at least
 *      one. Ties (identical values on every objective) mean NEITHER
 *      dominates the other -- both remain Pareto-optimal, by definition,
 *      no special-case code required.
 *   6. Weighted scoring runs ONLY if EVERY objective has an explicit,
 *      non-null `weight` (never partially, never defaulted) -- each
 *      objective's raw values across the candidates that HAVE a usable
 *      value for it are min-max normalized into `[0, 1]` (1 = better,
 *      respecting `direction`; an exactly-equal range across all available
 *      values normalizes every one of them to `1.0` -- there is no
 *      meaningful spread to score, documented explicitly rather than
 *      dividing by zero), then summed with each objective's weight. A
 *      candidate missing a usable value for ANY weighted objective gets
 *      `weightedScore: null` for itself -- never a fabricated/defaulted
 *      contribution -- while candidates with complete data still score
 *      normally.
 *
 * `algorithm` is a fixed literal (`"pareto-dominance-v1"`) identifying this
 * exact deterministic procedure for reproducibility/audit purposes --
 * bumped only if the algorithm itself ever changes.
 */

const ALGORITHM = "pareto-dominance-v1";

interface ResolvedMetric {
  value: number | null;
  unit: string | null;
  status: CandidateMetricSnapshot["status"];
  provenanceKind: CandidateMetricSnapshot["provenanceKind"];
  metricValueId: string | null;
}

const UNAVAILABLE_METRIC: ResolvedMetric = { value: null, unit: null, status: "unavailable", provenanceKind: null, metricValueId: null };

function resolveLatestMetric(candidateId: string, metricKey: string, metricValueStore: CandidateMetricValueStore): ResolvedMetric {
  const entries = metricValueStore.listForCandidate(candidateId).filter((entry) => entry.metricKey === metricKey);
  if (entries.length === 0) return UNAVAILABLE_METRIC;

  let latest = entries[0]!;
  for (const entry of entries.slice(1)) {
    if (new Date(entry.measuredAt).getTime() >= new Date(latest.measuredAt).getTime()) {
      latest = entry;
    }
  }
  return { value: latest.value, unit: latest.unit, status: latest.status, provenanceKind: latest.provenanceKind, metricValueId: latest.id };
}

/**
 * AUDIT FIX: exactly mirrors P16's `verify.ts`'s own `checkUnitCompatible`
 * -- `expectedUnit === null || evidenceUnit === expectedUnit`. An earlier
 * version of this file only flagged a mismatch when BOTH sides declared a
 * (different) unit, silently treating a metric with NO recorded unit as
 * "compatible" with a declared one -- exactly the "10 kg vs 10 lb compared
 * as identical" failure mode this phase's own brief warns against, and a
 * real divergence from the ALREADY-AUDITED P16 precedent this file's own
 * doc comment claims to mirror. When an objective/constraint declares a
 * unit, a metric must report that EXACT unit string to be usable -- a
 * metric with `unit: null` is UNUSABLE, never silently assumed compatible,
 * matching `checkUnitCompatible`'s identical, already-tested semantics. */
function unitsCompatible(declaredUnit: string | null, metricUnit: string | null): boolean {
  return declaredUnit === null || metricUnit === declaredUnit;
}

/** `true` iff a resolved metric can honestly be used for an
 * objective/constraint declaring `declaredUnit`: it must have a real value
 * (`status !== "unavailable"`) and its unit must be compatible -- never
 * silently compared as if equal. */
function isMetricUsable(metric: ResolvedMetric, declaredUnit: string | null): boolean {
  if (metric.status === "unavailable" || metric.value === null) return false;
  return unitsCompatible(declaredUnit, metric.unit);
}

function hasUnitMismatch(metric: ResolvedMetric, declaredUnit: string | null): boolean {
  return metric.status !== "unavailable" && metric.value !== null && !unitsCompatible(declaredUnit, metric.unit);
}

function evaluateConstraint(constraint: OptimizationConstraint, metric: ResolvedMetric): ConstraintEvaluationOutcome {
  if (metric.status === "unavailable" || metric.value === null) {
    return {
      optimizationConstraintId: constraint.id,
      metricKey: constraint.metricKey,
      operator: constraint.operator,
      threshold: constraint.threshold,
      unit: constraint.unit,
      actualValue: null,
      satisfied: null,
      reasonKind: "metric_unavailable"
    };
  }
  if (hasUnitMismatch(metric, constraint.unit)) {
    return {
      optimizationConstraintId: constraint.id,
      metricKey: constraint.metricKey,
      operator: constraint.operator,
      threshold: constraint.threshold,
      unit: constraint.unit,
      actualValue: metric.value,
      satisfied: null,
      reasonKind: "unit_mismatch"
    };
  }
  const satisfied = compareNumeric(constraint.operator, metric.value, constraint.threshold, null);
  return {
    optimizationConstraintId: constraint.id,
    metricKey: constraint.metricKey,
    operator: constraint.operator,
    threshold: constraint.threshold,
    unit: constraint.unit,
    actualValue: metric.value,
    satisfied,
    reasonKind: satisfied ? "satisfied" : "violated"
  };
}

function computeFeasibility(constraintResults: ConstraintEvaluationOutcome[]): CandidateFeasibility {
  if (constraintResults.some((outcome) => outcome.satisfied === false)) return "infeasible";
  if (constraintResults.some((outcome) => outcome.satisfied === null)) return "unknown";
  return "feasible";
}

/**
 * AUDIT FIX: `computeOptimizationResult` is a pure function callable
 * directly (by a future caller, or a test) with a hand-built
 * `OptimizationProblem`, not only one that passed through
 * `create_optimization_problem`'s tool-level `validateOptimizationProblemSemantics`
 * check. An earlier version of this file silently trusted the problem was
 * already well-formed; two objectives sharing one `metricKey` (ambiguous,
 * possibly conflicting directions/weights for the SAME measured quantity)
 * or a duplicated `candidateId` would have produced confusing, duplicated,
 * or double-counted output rather than a clear rejection. `compareCandidates`
 * (P22) already establishes the precedent this file now follows: a pure
 * analysis function defends its OWN structural invariants, rather than
 * relying solely on a separate validation step the caller might skip. */
function assertWellFormedForAnalysis(problem: OptimizationProblem): void {
  const seenMetricKeys = new Set<string>();
  for (const objective of problem.objectives) {
    if (seenMetricKeys.has(objective.metricKey)) {
      throw new WorldModelValidationError(
        "invalid_shape",
        `computeOptimizationResult requires every objective to have a distinct metricKey -- "${objective.metricKey}" appears more than once`
      );
    }
    seenMetricKeys.add(objective.metricKey);
  }

  const seenCandidateIds = new Set<string>();
  for (const candidateId of problem.candidateIds) {
    if (seenCandidateIds.has(candidateId)) {
      throw new WorldModelValidationError("invalid_shape", `computeOptimizationResult requires distinct candidateIds -- "${candidateId}" appears more than once`);
    }
    seenCandidateIds.add(candidateId);
  }
}

export function computeOptimizationResult(problem: OptimizationProblem, metricValueStore: CandidateMetricValueStore): OptimizationResult {
  assertWellFormedForAnalysis(problem);

  const objectiveMetricKeys = problem.objectives.map((objective) => objective.metricKey);
  const allMetricKeys = Array.from(new Set([...objectiveMetricKeys, ...problem.constraints.map((constraint) => constraint.metricKey)]));

  const resolvedByCandidate = new Map<string, Map<string, ResolvedMetric>>();
  for (const candidateId of problem.candidateIds) {
    const byMetricKey = new Map<string, ResolvedMetric>();
    for (const metricKey of allMetricKeys) {
      byMetricKey.set(metricKey, resolveLatestMetric(candidateId, metricKey, metricValueStore));
    }
    resolvedByCandidate.set(candidateId, byMetricKey);
  }

  const evaluations: CandidateEvaluation[] = problem.candidateIds.map((candidateId) => {
    const resolved = resolvedByCandidate.get(candidateId)!;

    const metrics: CandidateMetricSnapshot[] = allMetricKeys.map((metricKey) => {
      const metric = resolved.get(metricKey)!;
      return { metricKey, status: metric.status, value: metric.value, unit: metric.unit, provenanceKind: metric.provenanceKind, metricValueId: metric.metricValueId };
    });

    const constraintResults = problem.constraints.map((constraint) => evaluateConstraint(constraint, resolved.get(constraint.metricKey)!));
    const feasibility = computeFeasibility(constraintResults);

    const dataCompleteness: DataCompleteness = problem.objectives.every((objective) => isMetricUsable(resolved.get(objective.metricKey)!, objective.unit))
      ? "complete"
      : "incomplete";

    const paretoEligible = feasibility === "feasible" && dataCompleteness === "complete";

    return { candidateId, feasibility, dataCompleteness, metrics, constraintResults, paretoEligible, weightedScore: null };
  });

  // --- Weighted scoring (opt-in: every objective must carry an explicit weight) ---
  const allObjectivesWeighted = problem.objectives.length > 0 && problem.objectives.every((objective) => objective.weight !== null);
  if (allObjectivesWeighted) {
    const weightedSums = new Map<string, number>();
    const unscorable = new Set<string>();

    for (const objective of problem.objectives) {
      const available: { candidateId: string; value: number }[] = [];
      for (const candidateId of problem.candidateIds) {
        const metric = resolvedByCandidate.get(candidateId)!.get(objective.metricKey)!;
        if (isMetricUsable(metric, objective.unit)) {
          available.push({ candidateId, value: metric.value! });
        } else {
          unscorable.add(candidateId);
        }
      }
      if (available.length === 0) continue;

      const values = available.map((entry) => entry.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;

      for (const { candidateId, value } of available) {
        const normalized = range === 0 ? 1 : objective.direction === "minimize" ? (max - value) / range : (value - min) / range;
        weightedSums.set(candidateId, (weightedSums.get(candidateId) ?? 0) + objective.weight! * normalized);
      }
    }

    for (const evaluation of evaluations) {
      if (!unscorable.has(evaluation.candidateId)) {
        evaluation.weightedScore = weightedSums.get(evaluation.candidateId) ?? 0;
      }
    }
  }

  // --- Pareto dominance (only among paretoEligible candidates, input order) ---
  const eligibleIds = problem.candidateIds.filter((candidateId) => evaluations.find((evaluation) => evaluation.candidateId === candidateId)!.paretoEligible);
  const dominance: DominanceRelation[] = [];
  const dominatedSet = new Set<string>();

  for (const dominatorId of eligibleIds) {
    for (const dominatedId of eligibleIds) {
      if (dominatorId === dominatedId) continue;
      const comparisons: ObjectiveComparisonEntry[] = problem.objectives.map((objective: OptimizationObjective) => {
        const dominatorValue = resolvedByCandidate.get(dominatorId)!.get(objective.metricKey)!.value!;
        const dominatedValue = resolvedByCandidate.get(dominatedId)!.get(objective.metricKey)!.value!;
        const dominatorAtLeastAsGood = objective.direction === "minimize" ? dominatorValue <= dominatedValue : dominatorValue >= dominatedValue;
        const dominatorStrictlyBetter = objective.direction === "minimize" ? dominatorValue < dominatedValue : dominatorValue > dominatedValue;
        return { metricKey: objective.metricKey, direction: objective.direction, dominatorValue, dominatedValue, dominatorAtLeastAsGood, dominatorStrictlyBetter };
      });

      const dominatorWins = comparisons.every((comparison) => comparison.dominatorAtLeastAsGood) && comparisons.some((comparison) => comparison.dominatorStrictlyBetter);
      if (dominatorWins) {
        dominance.push({ dominatorCandidateId: dominatorId, dominatedCandidateId: dominatedId, comparisons });
        dominatedSet.add(dominatedId);
      }
    }
  }

  const paretoOptimalCandidateIds = eligibleIds.filter((candidateId) => !dominatedSet.has(candidateId));
  const dominatedCandidateIds = eligibleIds.filter((candidateId) => dominatedSet.has(candidateId));
  const infeasibleCandidateIds = evaluations.filter((evaluation) => evaluation.feasibility === "infeasible").map((evaluation) => evaluation.candidateId);
  const unknownFeasibilityCandidateIds = evaluations.filter((evaluation) => evaluation.feasibility === "unknown").map((evaluation) => evaluation.candidateId);
  const incompleteDataCandidateIds = evaluations
    .filter((evaluation) => evaluation.feasibility === "feasible" && evaluation.dataCompleteness === "incomplete")
    .map((evaluation) => evaluation.candidateId);

  return createOptimizationResult({
    problemId: problem.id,
    projectId: problem.projectId,
    projectVersion: problem.projectVersion,
    candidateEvaluations: evaluations,
    paretoOptimalCandidateIds,
    dominatedCandidateIds,
    infeasibleCandidateIds,
    unknownFeasibilityCandidateIds,
    incompleteDataCandidateIds,
    dominance,
    algorithm: ALGORITHM,
    source: "system"
  });
}
