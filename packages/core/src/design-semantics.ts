import type { DesignSpecification, Plan, WorldModelState } from "@naqsh/schemas";

/**
 * Deterministic SEMANTIC validation for a `DesignSpecification` (P20) --
 * mirrors `proposal-semantics.ts`'s `validateProposalSemantics` (P10)
 * exactly, one layer further down this pipeline: shape validation
 * (`assertDesignSpecification`) only knows a field is "a non-empty string"
 * or "an array," never whether it names something real. This is what
 * makes "a design must not exist as an unexplained orphan" and "no
 * hallucinated requirement/constraint/component reference" enforced
 * FACTS, not conventions a caller has to remember to check.
 *
 * Pure and side-effect-free (`plan`/`state` are read from, never written
 * to): given the same `(design, plan, state)`, always returns the same
 * issues. Never throws -- an empty array means "valid," a non-empty one
 * lists every issue found, matching `validateProposalSemantics`'s "report
 * everything, not one at a time" rule.
 */
export type DesignSemanticIssueCode =
  | "plan_mismatch"
  | "project_mismatch"
  | "unknown_plan_step"
  | "unknown_requirement_reference"
  | "unknown_constraint_reference"
  | "unresolved_requirement_in_project"
  | "unresolved_constraint_in_project"
  | "unknown_component_reference"
  | "component_cycle"
  | "unknown_relationship_component_reference"
  | "unknown_expected_output_component_reference";

export interface DesignSemanticIssue {
  code: DesignSemanticIssueCode;
  message: string;
}

/** A component whose `parentComponentId` chain eventually returns to
 * itself -- bounded by `components.length` so a genuine cycle can never
 * spin this loop forever even before it's reported. */
function findsCycle(componentId: string, byId: Map<string, { parentComponentId: string | null }>): boolean {
  let current: string | null = componentId;
  const seen = new Set<string>();
  for (let steps = 0; current !== null && steps <= byId.size; steps++) {
    if (seen.has(current)) return true;
    seen.add(current);
    const component = byId.get(current);
    current = component ? component.parentComponentId : null;
  }
  return false;
}

export function validateDesignSpecificationSemantics(design: DesignSpecification, plan: Plan, state?: WorldModelState): DesignSemanticIssue[] {
  const issues: DesignSemanticIssue[] = [];

  if (design.planId !== plan.id) {
    issues.push({ code: "plan_mismatch", message: `DesignSpecification names planId "${design.planId}" but was validated against plan "${plan.id}"` });
  }
  if (design.projectId !== plan.projectId) {
    issues.push({
      code: "project_mismatch",
      message: `DesignSpecification belongs to project "${design.projectId}" but its plan is for project "${plan.projectId}"`
    });
  }

  const step = plan.steps.find((candidate) => candidate.id === design.planStepId);
  if (!step) {
    issues.push({ code: "unknown_plan_step", message: `DesignSpecification references plan step "${design.planStepId}", which does not exist in plan "${plan.id}"` });
  } else {
    for (const id of design.relevantRequirementIds) {
      if (!step.relevantRequirementIds.includes(id)) {
        issues.push({ code: "unknown_requirement_reference", message: `DesignSpecification references requirement "${id}", which its originating plan step never cited` });
      }
    }
    for (const id of design.relevantConstraintIds) {
      if (!step.relevantConstraintIds.includes(id)) {
        issues.push({ code: "unknown_constraint_reference", message: `DesignSpecification references constraint "${id}", which its originating plan step never cited` });
      }
    }
  }

  if (state) {
    const requirementIds = new Set(state.project.requirements.map((requirement) => requirement.id));
    const constraintIds = new Set(state.project.constraints.map((constraint) => constraint.id));
    for (const id of design.relevantRequirementIds) {
      if (!requirementIds.has(id)) {
        issues.push({ code: "unresolved_requirement_in_project", message: `DesignSpecification references requirement "${id}", which does not exist in the current project` });
      }
    }
    for (const id of design.relevantConstraintIds) {
      if (!constraintIds.has(id)) {
        issues.push({ code: "unresolved_constraint_in_project", message: `DesignSpecification references constraint "${id}", which does not exist in the current project` });
      }
    }
  }

  const componentById = new Map(design.components.map((component) => [component.id, component]));
  for (const component of design.components) {
    if (component.parentComponentId !== null && !componentById.has(component.parentComponentId)) {
      issues.push({
        code: "unknown_component_reference",
        message: `Component "${component.id}" has parentComponentId "${component.parentComponentId}", which does not exist in this design`
      });
    }
  }
  for (const component of design.components) {
    if (findsCycle(component.id, componentById)) {
      issues.push({ code: "component_cycle", message: `Component "${component.id}" is part of a parentComponentId cycle` });
      break; // one report is enough -- every component in the cycle would otherwise report the same cycle redundantly
    }
  }

  for (const relationship of design.relationships) {
    if (!componentById.has(relationship.sourceComponentId)) {
      issues.push({
        code: "unknown_relationship_component_reference",
        message: `Relationship "${relationship.id}" references sourceComponentId "${relationship.sourceComponentId}", which does not exist in this design`
      });
    }
    if (!componentById.has(relationship.targetComponentId)) {
      issues.push({
        code: "unknown_relationship_component_reference",
        message: `Relationship "${relationship.id}" references targetComponentId "${relationship.targetComponentId}", which does not exist in this design`
      });
    }
  }

  for (const output of design.expectedOutputs) {
    if (!componentById.has(output.componentId)) {
      issues.push({
        code: "unknown_expected_output_component_reference",
        message: `ExpectedBuildOutput "${output.id}" references componentId "${output.componentId}", which does not exist in this design`
      });
    }
  }

  return issues;
}
