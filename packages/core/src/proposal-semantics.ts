import { matchesToolValueSchema, type Plan, type Proposal } from "@naqsh/schemas";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * Deterministic SEMANTIC validation for a `Proposal` (P10) — mirrors
 * `plan-semantics.ts`'s `validatePlanSemantics` (P9) exactly, one layer
 * further down the pipeline: schema validation (`assertProposal`) only
 * knows a field is "a non-empty string" or "an array of strings," never
 * whether it names something real. This is what makes "a proposal must
 * not exist as an unexplained orphan" and "no hallucinated tool name" —
 * both explicit P10 requirements — enforced FACTS, not conventions a
 * caller has to remember to check.
 *
 * Pure and side-effect-free (an optional `registry` parameter is read
 * from, never written to): given the same `(proposal, plan, registry)`,
 * always returns the same issues. Never throws — an empty array means
 * "valid," a non-empty one lists every issue found, matching
 * `validatePlanSemantics`'s "report everything, not one at a time" rule.
 */
export type ProposalSemanticIssueCode =
  | "plan_mismatch"
  | "project_mismatch"
  | "unknown_plan_step"
  | "unknown_requirement_reference"
  | "unknown_constraint_reference"
  | "unknown_target_reference"
  | "unknown_tool"
  | "invalid_tool_input";

export interface ProposalSemanticIssue {
  code: ProposalSemanticIssueCode;
  message: string;
}

/** Which `PlanStep` field a `target.entityType` maps to, for the
 * "this proposal's target must be something its own plan step already
 * cited" check below. Only the entity kinds a `PlanStep` actually tracks
 * relevance for are checked — a `target.entityType` outside this set
 * (e.g. a future environment-specific resource type) is intentionally
 * left unchecked here, not rejected: `ChangeTarget.entityType` is
 * deliberately open-ended (see `types.ts`), and this function only
 * enforces what it can meaningfully cross-reference. */
const TARGET_ENTITY_TYPE_TO_STEP_FIELD = {
  object: "relevantObjectIds",
  requirement: "relevantRequirementIds",
  constraint: "relevantConstraintIds",
  decision: "relevantDecisionIds"
} as const;

export function validateProposalSemantics(proposal: Proposal, plan: Plan, registry?: ToolRegistry): ProposalSemanticIssue[] {
  const issues: ProposalSemanticIssue[] = [];

  if (proposal.planId !== plan.id) {
    issues.push({
      code: "plan_mismatch",
      message: `Proposal names planId "${proposal.planId}" but was validated against plan "${plan.id}"`
    });
  }
  if (proposal.projectId !== plan.projectId) {
    issues.push({
      code: "project_mismatch",
      message: `Proposal belongs to project "${proposal.projectId}" but its plan is for project "${plan.projectId}"`
    });
  }

  const step = plan.steps.find((candidate) => candidate.id === proposal.planStepId);
  if (!step) {
    issues.push({
      code: "unknown_plan_step",
      message: `Proposal references plan step "${proposal.planStepId}", which does not exist in plan "${plan.id}"`
    });
  } else {
    for (const id of proposal.relevantRequirementIds) {
      if (!step.relevantRequirementIds.includes(id)) {
        issues.push({
          code: "unknown_requirement_reference",
          message: `Proposal references requirement "${id}", which its originating plan step never cited`
        });
      }
    }
    for (const id of proposal.relevantConstraintIds) {
      if (!step.relevantConstraintIds.includes(id)) {
        issues.push({
          code: "unknown_constraint_reference",
          message: `Proposal references constraint "${id}", which its originating plan step never cited`
        });
      }
    }
    if (proposal.target && proposal.target.entityId !== null) {
      const stepField =
        TARGET_ENTITY_TYPE_TO_STEP_FIELD[proposal.target.entityType as keyof typeof TARGET_ENTITY_TYPE_TO_STEP_FIELD];
      if (stepField && !step[stepField].includes(proposal.target.entityId)) {
        issues.push({
          code: "unknown_target_reference",
          message: `Proposal targets ${proposal.target.entityType} "${proposal.target.entityId}", which its originating plan step never cited`
        });
      }
    }
  }

  if (registry) {
    const tool = registry.getByName(proposal.toolName);
    if (!tool) {
      issues.push({ code: "unknown_tool", message: `Proposal names tool "${proposal.toolName}", which is not registered` });
    } else {
      const inputErrors = matchesToolValueSchema(tool.inputSchema, proposal.input, "proposal.input");
      if (inputErrors.length > 0) {
        issues.push({
          code: "invalid_tool_input",
          message: `Proposal's input does not match tool "${tool.name}"'s inputSchema: ${inputErrors.join("; ")}`
        });
      }
    }
  }

  return issues;
}
