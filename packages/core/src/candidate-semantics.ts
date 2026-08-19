import type { Candidate, Plan, WorldModelState } from "@naqsh/schemas";
import type { DesignSpecificationStore } from "./design-specification-store.js";
import type { CandidateStore } from "./candidate-store.js";

/**
 * Deterministic SEMANTIC validation for a `Candidate` (P22) -- mirrors
 * `validateDesignSpecificationSemantics`'s (P20) exact shape and reasoning,
 * one layer further UP the same pipeline: shape validation
 * (`assertCandidate`) only knows a field is "a non-empty string" or "an
 * array," never whether it names something real. This is what makes "a
 * candidate must never become an unexplained orphan" (P22 brief) an
 * enforced FACT, not a convention a caller has to remember to check.
 *
 * Pure and side-effect-free (every argument is read from, never written
 * to): given the same inputs, always returns the same issues. Never
 * throws -- an empty array means "valid," a non-empty one lists every
 * issue found, matching `validateDesignSpecificationSemantics`'s "report
 * everything, not one at a time" rule.
 *
 * `state`/`designSpecificationStore`/`candidateStore` are all OPTIONAL
 * (mirrors `validateDesignSpecificationSemantics`'s optional `state`
 * exactly): a caller validating a candidate before anything else exists
 * yet (e.g. immediately after generating it, before saving to any store)
 * can still get the PLAN-level checks without needing to construct
 * dependencies it doesn't have.
 */
export type CandidateSemanticIssueCode =
  | "plan_mismatch"
  | "project_mismatch"
  | "unknown_plan_step"
  | "unknown_requirement_reference"
  | "unknown_constraint_reference"
  | "unresolved_requirement_in_project"
  | "unresolved_constraint_in_project"
  | "unresolved_research_evidence_in_project"
  | "unknown_assumption_reference"
  | "unknown_design_specification_reference"
  | "design_specification_plan_mismatch"
  | "unknown_parent_candidate_reference";

export interface CandidateSemanticIssue {
  code: CandidateSemanticIssueCode;
  message: string;
}

export interface ValidateCandidateSemanticsOptions {
  state?: WorldModelState;
  designSpecificationStore?: DesignSpecificationStore;
  candidateStore?: CandidateStore;
}

export function validateCandidateSemantics(candidate: Candidate, plan: Plan, options: ValidateCandidateSemanticsOptions = {}): CandidateSemanticIssue[] {
  const issues: CandidateSemanticIssue[] = [];

  if (candidate.planId !== plan.id) {
    issues.push({ code: "plan_mismatch", message: `Candidate names planId "${candidate.planId}" but was validated against plan "${plan.id}"` });
  }
  if (candidate.projectId !== plan.projectId) {
    issues.push({
      code: "project_mismatch",
      message: `Candidate belongs to project "${candidate.projectId}" but its plan is for project "${plan.projectId}"`
    });
  }

  // A candidate scoped to ONE plan step must only cite that step's own
  // relevant requirements/constraints (matches DesignSpecification's
  // identical rule); a whole-plan candidate (planStepId === null) is
  // checked against the UNION of every step's relevant ids instead, since
  // it is not scoped to any single step's own narrower list.
  if (candidate.planStepId !== null) {
    const step = plan.steps.find((candidateStep) => candidateStep.id === candidate.planStepId);
    if (!step) {
      issues.push({ code: "unknown_plan_step", message: `Candidate references plan step "${candidate.planStepId}", which does not exist in plan "${plan.id}"` });
    } else {
      for (const id of candidate.relevantRequirementIds) {
        if (!step.relevantRequirementIds.includes(id)) {
          issues.push({ code: "unknown_requirement_reference", message: `Candidate references requirement "${id}", which its originating plan step never cited` });
        }
      }
      for (const id of candidate.relevantConstraintIds) {
        if (!step.relevantConstraintIds.includes(id)) {
          issues.push({ code: "unknown_constraint_reference", message: `Candidate references constraint "${id}", which its originating plan step never cited` });
        }
      }
    }
  } else {
    const planRequirementIds = new Set(plan.steps.flatMap((step) => step.relevantRequirementIds));
    const planConstraintIds = new Set(plan.steps.flatMap((step) => step.relevantConstraintIds));
    for (const id of candidate.relevantRequirementIds) {
      if (!planRequirementIds.has(id)) {
        issues.push({ code: "unknown_requirement_reference", message: `Candidate references requirement "${id}", which no step of plan "${plan.id}" cites` });
      }
    }
    for (const id of candidate.relevantConstraintIds) {
      if (!planConstraintIds.has(id)) {
        issues.push({ code: "unknown_constraint_reference", message: `Candidate references constraint "${id}", which no step of plan "${plan.id}" cites` });
      }
    }
  }

  const planAssumptionIds = new Set(plan.assumptions.map((assumption) => assumption.id));
  for (const id of candidate.assumptionIds) {
    if (!planAssumptionIds.has(id)) {
      issues.push({ code: "unknown_assumption_reference", message: `Candidate references assumption "${id}", which does not exist in plan "${plan.id}"` });
    }
  }

  if (options.state) {
    const requirementIds = new Set(options.state.project.requirements.map((requirement) => requirement.id));
    const constraintIds = new Set(options.state.project.constraints.map((constraint) => constraint.id));
    const evidenceIds = new Set(options.state.project.researchEvidence.map((evidence) => evidence.id));
    for (const id of candidate.relevantRequirementIds) {
      if (!requirementIds.has(id)) {
        issues.push({ code: "unresolved_requirement_in_project", message: `Candidate references requirement "${id}", which does not exist in the current project` });
      }
    }
    for (const id of candidate.relevantConstraintIds) {
      if (!constraintIds.has(id)) {
        issues.push({ code: "unresolved_constraint_in_project", message: `Candidate references constraint "${id}", which does not exist in the current project` });
      }
    }
    for (const id of candidate.relevantResearchEvidenceIds) {
      if (!evidenceIds.has(id)) {
        issues.push({ code: "unresolved_research_evidence_in_project", message: `Candidate references research evidence "${id}", which does not exist in the current project` });
      }
    }
  }

  if (candidate.designSpecificationId !== null && options.designSpecificationStore) {
    const design = options.designSpecificationStore.getById(candidate.designSpecificationId);
    if (!design) {
      issues.push({ code: "unknown_design_specification_reference", message: `Candidate references DesignSpecification "${candidate.designSpecificationId}", which does not exist` });
    } else if (design.planId !== candidate.planId || (candidate.planStepId !== null && design.planStepId !== candidate.planStepId)) {
      issues.push({
        code: "design_specification_plan_mismatch",
        message: `Candidate's DesignSpecification "${candidate.designSpecificationId}" was generated for plan "${design.planId}"/step "${design.planStepId}", which does not match the candidate's own plan "${candidate.planId}"/step "${candidate.planStepId}"`
      });
    }
  }

  if (candidate.parentCandidateId !== null && options.candidateStore) {
    if (!options.candidateStore.getById(candidate.parentCandidateId)) {
      issues.push({ code: "unknown_parent_candidate_reference", message: `Candidate references parentCandidateId "${candidate.parentCandidateId}", which does not exist` });
    }
  }

  return issues;
}
