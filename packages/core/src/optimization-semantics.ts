import type { OptimizationProblem, WorldModelState } from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";

/**
 * Deterministic SEMANTIC validation for an `OptimizationProblem` (P23) --
 * mirrors `validateCandidateSemantics`'s (P22) exact shape and reasoning:
 * shape validation (`assertOptimizationProblem`) only knows a field is "a
 * non-empty string" or "an array," never whether it names something real.
 * This is what makes "an optimization problem must never silently analyze
 * a nonexistent candidate, or two objectives silently disagree about the
 * same metric's direction" an enforced FACT, not a convention a caller has
 * to remember to check.
 *
 * Pure and side-effect-free. `state`/`candidateStore` are both OPTIONAL
 * (mirrors `validateCandidateSemantics`'s identical optional-dependency
 * pattern) -- a caller validating a problem before a `CandidateStore` even
 * exists yet still gets the structural (duplicate-metricKey) check.
 */
export type OptimizationSemanticIssueCode =
  | "project_mismatch"
  | "unknown_candidate_reference"
  | "duplicate_candidate_reference"
  | "duplicate_objective_metric_key"
  | "unresolved_requirement_in_project"
  | "unresolved_constraint_in_project";

export interface OptimizationSemanticIssue {
  code: OptimizationSemanticIssueCode;
  message: string;
}

export interface ValidateOptimizationProblemSemanticsOptions {
  state?: WorldModelState;
  candidateStore?: CandidateStore;
}

export function validateOptimizationProblemSemantics(
  problem: OptimizationProblem,
  options: ValidateOptimizationProblemSemanticsOptions = {}
): OptimizationSemanticIssue[] {
  const issues: OptimizationSemanticIssue[] = [];

  if (options.state && problem.projectId !== options.state.project.id) {
    issues.push({
      code: "project_mismatch",
      message: `OptimizationProblem belongs to project "${problem.projectId}", not the current project "${options.state.project.id}"`
    });
  }

  const seenCandidateIds = new Set<string>();
  for (const candidateId of problem.candidateIds) {
    if (seenCandidateIds.has(candidateId)) {
      issues.push({ code: "duplicate_candidate_reference", message: `OptimizationProblem lists candidate "${candidateId}" more than once` });
    }
    seenCandidateIds.add(candidateId);
  }

  if (options.candidateStore) {
    for (const candidateId of problem.candidateIds) {
      if (!options.candidateStore.getById(candidateId)) {
        issues.push({ code: "unknown_candidate_reference", message: `OptimizationProblem references candidate "${candidateId}", which does not exist` });
      }
    }
  }

  const seenMetricKeys = new Set<string>();
  for (const objective of problem.objectives) {
    if (seenMetricKeys.has(objective.metricKey)) {
      issues.push({
        code: "duplicate_objective_metric_key",
        message: `OptimizationProblem has more than one objective for metricKey "${objective.metricKey}" -- two objectives for the same metric would give it two, possibly conflicting, directions`
      });
    }
    seenMetricKeys.add(objective.metricKey);
  }

  if (options.state) {
    const requirementIds = new Set(options.state.project.requirements.map((requirement) => requirement.id));
    const constraintIds = new Set(options.state.project.constraints.map((constraint) => constraint.id));
    for (const objective of problem.objectives) {
      if (objective.requirementId !== null && !requirementIds.has(objective.requirementId)) {
        issues.push({
          code: "unresolved_requirement_in_project",
          message: `Objective for metricKey "${objective.metricKey}" references requirement "${objective.requirementId}", which does not exist in the current project`
        });
      }
    }
    for (const constraint of problem.constraints) {
      if (constraint.constraintId !== null && !constraintIds.has(constraint.constraintId)) {
        issues.push({
          code: "unresolved_constraint_in_project",
          message: `Constraint for metricKey "${constraint.metricKey}" references constraint "${constraint.constraintId}", which does not exist in the current project`
        });
      }
    }
  }

  return issues;
}
