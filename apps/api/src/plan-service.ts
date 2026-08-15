import {
  generatePlanProposal,
  getPlanStepById,
  getPlanSummary,
  getStepDependencies,
  getStepDependents,
  observeProject,
  type GeneratePlanOptions,
  type ModelProvider,
  type PlanGenerationResult,
  type PlanSummary
} from "@naqsh/core";
import type { Plan, PlanStep, WorldModelState } from "@naqsh/schemas";

/**
 * The application/API-surface seam Phase 9 requires (§17): "expose a clean
 * API/service boundary for future UI integration" so a future UI can show
 * the objective, the generated plan, its steps, dependencies, assumptions,
 * missing information, risks, and linked requirements/constraints/objects.
 * Deliberately NOT an HTTP server, for the exact same reason
 * `observation-service.ts` (P8) isn't one — no route table, no framework
 * choice, no port binding. What this file IS: the exact functions a future
 * HTTP handler (`POST /projects/:id/plan`, `GET /plans/:id/steps/:stepId`,
 * or similar) would call directly, already typed against `@naqsh/core`'s
 * real planning API.
 *
 * Every function is a thin, literal pass-through to `@naqsh/core` — this
 * file adds naming for the request SHAPES the brief names, nothing else.
 * All actual behavior (observation scoping, structured-output validation,
 * id remapping, semantic validation) stays exactly where P9 put it:
 * `packages/core/src/planner.ts`/`plan-semantics.ts`/`plan-query.ts`.
 * Generating a plan through this seam is EXACTLY as non-mutating as
 * calling `generatePlanProposal` directly — this file adds no state, no
 * caching, no implicit persistence.
 */

export function generateWholeProjectPlan(
  state: WorldModelState,
  provider: ModelProvider,
  options: GeneratePlanOptions
): Promise<PlanGenerationResult> {
  return generatePlanProposal(provider, observeProject(state, { scope: "project" }), options);
}

export function generateFocusedPlan(
  state: WorldModelState,
  provider: ModelProvider,
  options: GeneratePlanOptions
): Promise<PlanGenerationResult> {
  return generatePlanProposal(provider, observeProject(state, { scope: "focus" }), options);
}

export function generateObjectPlan(
  state: WorldModelState,
  provider: ModelProvider,
  objectId: string,
  options: GeneratePlanOptions
): Promise<PlanGenerationResult> {
  return generatePlanProposal(provider, observeProject(state, { scope: "object", objectId }), options);
}

export function inspectPlanSummary(plan: Plan): PlanSummary {
  return getPlanSummary(plan);
}

export function inspectPlanStep(plan: Plan, stepId: string): PlanStep | undefined {
  return getPlanStepById(plan, stepId);
}

export interface PlanStepDependencyContext {
  dependencies: PlanStep[];
  dependents: PlanStep[];
}

export function inspectStepDependencies(plan: Plan, stepId: string): PlanStepDependencyContext {
  return {
    dependencies: getStepDependencies(plan, stepId),
    dependents: getStepDependents(plan, stepId)
  };
}
