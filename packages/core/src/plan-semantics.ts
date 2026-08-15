import type { ObservationResult, Plan } from "@naqsh/schemas";

/**
 * Deterministic SEMANTIC validation for a `Plan` (P9) — the check schema
 * validation (`assertPlan`) cannot perform, because schema validation only
 * knows a field is "an array of strings," never whether those strings
 * actually name something real. This is what makes "no hallucinated
 * requirements/objects/constraints/decisions" and "no circular
 * dependencies" enforced FACTS about a generated plan rather than
 * conventions a caller has to remember to check.
 *
 * Pure and side-effect-free: given the same `(plan, observation)`, always
 * returns the same issues. Never throws for a plan that merely has
 * problems — an empty array means "valid," a non-empty one lists every
 * issue found (not just the first), matching `matchesToolValueSchema`'s
 * "report everything, not one at a time across retries" precedent.
 */
export type PlanSemanticIssueCode =
  | "project_mismatch"
  | "duplicate_step_id"
  | "duplicate_assumption_id"
  | "duplicate_question_id"
  | "duplicate_risk_id"
  | "self_dependency"
  | "unknown_dependency"
  | "circular_dependency"
  | "unknown_requirement_reference"
  | "unknown_constraint_reference"
  | "unknown_object_reference"
  | "unknown_decision_reference"
  | "unknown_assumption_reference";

export interface PlanSemanticIssue {
  code: PlanSemanticIssueCode;
  message: string;
  /** The step this issue concerns, when it's step-scoped. Absent for
   * plan-level issues (e.g. `project_mismatch`). */
  stepId?: string;
}

function findDuplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/**
 * Depth-first cycle detection over the `dependsOn` graph (three-color
 * marking: unvisited / in-progress / done). A step's dependency edges that
 * point at an unknown step id are skipped here — those are already
 * reported as `unknown_dependency` by the caller, and walking into a
 * nonexistent node would either crash or require the same "does this id
 * exist" check duplicated a second time.
 *
 * Iterative (an explicit stack of `{id, depIndex}` frames), not recursive:
 * a genuinely large, non-cyclic plan (e.g. a long linear dependency chain
 * a model could return, whether legitimately or as hostile/malformed
 * output) must not be able to overflow the JS call stack just by having
 * many steps. `validatePlanSemantics` is documented as never throwing for
 * a plan that merely has problems — a `RangeError: Maximum call stack size
 * exceeded` from a recursive walk would have silently broken that
 * contract for large-enough input.
 */
function findCircularDependencies(steps: readonly Plan["steps"][number][]): PlanSemanticIssue[] {
  const issues: PlanSemanticIssue[] = [];
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const color = new Map<string, "in_progress" | "done">();
  const reportedCycles = new Set<string>();

  for (const startStep of steps) {
    if (color.has(startStep.id)) continue;

    const stack: { id: string; depIndex: number }[] = [{ id: startStep.id, depIndex: 0 }];
    color.set(startStep.id, "in_progress");

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const deps = stepsById.get(frame.id)?.dependsOn ?? [];

      if (frame.depIndex >= deps.length) {
        color.set(frame.id, "done");
        stack.pop();
        continue;
      }

      const depId = deps[frame.depIndex]!;
      frame.depIndex++;
      if (depId === frame.id || !stepsById.has(depId)) continue;

      const depColor = color.get(depId);
      if (depColor === "in_progress") {
        const cyclePath = [...stack.map((entry) => entry.id), depId];
        const cycleKey = [...cyclePath].sort().join(">");
        if (!reportedCycles.has(cycleKey)) {
          reportedCycles.add(cycleKey);
          issues.push({
            code: "circular_dependency",
            message: `Circular dependency: ${cyclePath.join(" -> ")}`,
            stepId: frame.id
          });
        }
      } else if (!depColor) {
        color.set(depId, "in_progress");
        stack.push({ id: depId, depIndex: 0 });
      }
    }
  }
  return issues;
}

export function validatePlanSemantics(plan: Plan, observation: ObservationResult): PlanSemanticIssue[] {
  const issues: PlanSemanticIssue[] = [];

  if (plan.projectId !== observation.projectId) {
    issues.push({
      code: "project_mismatch",
      message: `Plan belongs to project "${plan.projectId}" but the observation is for project "${observation.projectId}"`
    });
  }

  for (const id of findDuplicateIds(plan.steps.map((step) => step.id))) {
    issues.push({ code: "duplicate_step_id", message: `Step id "${id}" is used by more than one step`, stepId: id });
  }
  for (const id of findDuplicateIds(plan.assumptions.map((assumption) => assumption.id))) {
    issues.push({ code: "duplicate_assumption_id", message: `Assumption id "${id}" is used more than once` });
  }
  for (const id of findDuplicateIds(plan.unresolvedQuestions.map((question) => question.id))) {
    issues.push({ code: "duplicate_question_id", message: `Question id "${id}" is used more than once` });
  }
  for (const id of findDuplicateIds(plan.risks.map((risk) => risk.id))) {
    issues.push({ code: "duplicate_risk_id", message: `Risk id "${id}" is used more than once` });
  }

  const stepIds = new Set(plan.steps.map((step) => step.id));
  const requirementIds = new Set(observation.requirements.map((requirement) => requirement.id));
  const constraintIds = new Set(observation.constraints.map((constraint) => constraint.id));
  const objectIds = new Set(observation.objects.map((object) => object.id));
  const decisionIds = new Set(observation.decisions.map((decision) => decision.id));
  const assumptionIds = new Set(plan.assumptions.map((assumption) => assumption.id));

  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      if (depId === step.id) {
        issues.push({ code: "self_dependency", message: `Step "${step.id}" depends on itself`, stepId: step.id });
      } else if (!stepIds.has(depId)) {
        issues.push({
          code: "unknown_dependency",
          message: `Step "${step.id}" depends on unknown step "${depId}"`,
          stepId: step.id
        });
      }
    }
    for (const id of step.relevantRequirementIds) {
      if (!requirementIds.has(id)) {
        issues.push({
          code: "unknown_requirement_reference",
          message: `Step "${step.id}" references requirement "${id}", which does not exist in the observation this plan was built from`,
          stepId: step.id
        });
      }
    }
    for (const id of step.relevantConstraintIds) {
      if (!constraintIds.has(id)) {
        issues.push({
          code: "unknown_constraint_reference",
          message: `Step "${step.id}" references constraint "${id}", which does not exist in the observation this plan was built from`,
          stepId: step.id
        });
      }
    }
    for (const id of step.relevantObjectIds) {
      if (!objectIds.has(id)) {
        issues.push({
          code: "unknown_object_reference",
          message: `Step "${step.id}" references object "${id}", which does not exist in the observation this plan was built from`,
          stepId: step.id
        });
      }
    }
    for (const id of step.relevantDecisionIds) {
      if (!decisionIds.has(id)) {
        issues.push({
          code: "unknown_decision_reference",
          message: `Step "${step.id}" references decision "${id}", which does not exist in the observation this plan was built from`,
          stepId: step.id
        });
      }
    }
    for (const id of step.assumptionIds) {
      if (!assumptionIds.has(id)) {
        issues.push({
          code: "unknown_assumption_reference",
          message: `Step "${step.id}" references assumption "${id}", which is not one of this plan's own assumptions`,
          stepId: step.id
        });
      }
    }
  }

  issues.push(...findCircularDependencies(plan.steps));

  return issues;
}
