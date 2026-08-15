import type { Plan, PlanStatus, PlanStep } from "@naqsh/schemas";

/**
 * Deterministic, read-only query helpers over an already-generated `Plan`
 * (P9 brief §15). Unlike `observe-project.ts`'s query functions, none of
 * these need a defensive `structuredClone`/freeze step: `createPlan`
 * already deep-freezes every `Plan` it returns (see its doc comment), so
 * there is no live, mutable World-Model-style reference to guard against
 * here — every value these functions hand back is already immutable.
 */

/** A lightweight header, not the full plan — mirrors `ProjectSummary`'s
 * role for `observeProject`: for a caller (a plan list view) that only
 * needs identity/counts without the full step/assumption/risk bodies. */
export interface PlanSummary {
  id: string;
  projectId: string;
  observationId: string;
  objectiveSummary: string;
  status: PlanStatus;
  stepCount: number;
  assumptionCount: number;
  unresolvedQuestionCount: number;
  riskCount: number;
  missingInformationCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function getPlanSummary(plan: Plan): PlanSummary {
  return {
    id: plan.id,
    projectId: plan.projectId,
    observationId: plan.observationId,
    objectiveSummary: plan.objectiveSummary,
    status: plan.status,
    stepCount: plan.steps.length,
    assumptionCount: plan.assumptions.length,
    unresolvedQuestionCount: plan.unresolvedQuestions.length,
    riskCount: plan.risks.length,
    missingInformationCount: plan.missingInformation.length,
    version: plan.version,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

export function getPlanStepById(plan: Plan, stepId: string): PlanStep | undefined {
  return plan.steps.find((step) => step.id === stepId);
}

/** Resolves a step's `dependsOn` ids to the actual `PlanStep` objects
 * they name, silently skipping any id that doesn't resolve (the same
 * "a dangling reference is a read-time fact to tolerate" precedent
 * `observe-project.ts` already set — `validatePlanSemantics` is what
 * REJECTS a plan with a dangling dependency at generation time; a query
 * function reading an already-accepted plan should never throw). */
export function getStepDependencies(plan: Plan, stepId: string): PlanStep[] {
  const step = getPlanStepById(plan, stepId);
  if (!step) return [];
  const byId = new Map(plan.steps.map((candidate) => [candidate.id, candidate]));
  const resolved: PlanStep[] = [];
  for (const dependencyId of step.dependsOn) {
    const dependency = byId.get(dependencyId);
    if (dependency) resolved.push(dependency);
  }
  return resolved;
}

/** The reverse of `dependsOn`: every step that depends ON `stepId`. */
export function getStepDependents(plan: Plan, stepId: string): PlanStep[] {
  return plan.steps.filter((step) => step.dependsOn.includes(stepId));
}
