import {
  assertPlan,
  createCandidate,
  ENTITY_SOURCES,
  ToolError,
  WorldModelValidationError,
  createTool,
  type CandidateInput,
  type EntitySource,
  type Plan,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { DesignSpecificationStore } from "./design-specification-store.js";
import { validateCandidateSemantics } from "./candidate-semantics.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 22's candidate-DEFINITION tool: mirrors `create_check`'s (P16)
 * exact shape -- flat, already-decided fields go in (the agent's own
 * hypothesis/rationale, arrived at through its normal tool-calling
 * reasoning, not a second Gemini-calling orchestration function this file
 * would have to invent), a validated, stored `Candidate` comes out.
 *
 * Classified `mutation: "suggest"` (creates a new independent process
 * record, never touches `WorldModelState` or the environment) -- the same
 * classification `create_check`/`create_checkpoint`/`create_plan` use for
 * the identical reason.
 *
 * Unlike `create_check`, a `Candidate` must be validated against a `Plan`
 * (`validateCandidateSemantics`) -- and this repository has no `PlanStore`
 * (see `proposal-tool.ts`'s own doc comment on this deferral), so exactly
 * like `create_proposal`, the caller supplies the full `plan` value
 * directly as a tool input; it is deep-validated (`assertPlan`) before
 * anything else happens.
 *
 * `projectId`/`projectVersion` are NOT caller-supplied inputs -- they are
 * read from the live `WorldModelState` via `getState()`, the same way
 * `create_check`'s linked-requirement cross-check reads live state. This
 * closes off the obvious spoofing path (a caller claiming a candidate
 * belongs to a project/version it was never actually generated against);
 * `validateCandidateSemantics`'s own `project_mismatch` check then catches
 * a `plan` argument that disagrees with the CURRENT project.
 *
 * `designSpecificationStore`/`candidateStore` are passed through to
 * `validateCandidateSemantics` as optional dependencies so a
 * `designSpecificationId`/`parentCandidateId` reference is cross-checked
 * against real, currently-saved records -- not merely shape-checked.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    plan: {
      type: "object",
      properties: {},
      additionalProperties: true,
      description: "The full Plan (P9) this candidate is an alternative approach for. Deep-validated by this tool's handler."
    },
    planStepId: {
      type: "string",
      nullable: true,
      description: "The specific PlanStep this candidate addresses, or omitted/null for a whole-plan alternative."
    },
    designSpecificationId: { type: "string", nullable: true },
    proposalId: { type: "string", nullable: true },
    relevantRequirementIds: { type: "array", items: { type: "string" }, nullable: true },
    relevantConstraintIds: { type: "array", items: { type: "string" }, nullable: true },
    relevantResearchEvidenceIds: { type: "array", items: { type: "string" }, nullable: true },
    assumptionIds: { type: "array", items: { type: "string" }, nullable: true },
    hypothesis: { type: "string", description: "What this candidate claims/tests." },
    rationale: { type: "string", description: "Why this particular approach was chosen." },
    parentCandidateId: { type: "string", nullable: true, description: "An earlier Candidate this one was branched/refined from, if any." },
    provenance: {
      type: "string",
      nullable: true,
      description: "Who/what supplied this candidate -- one of EntitySource (e.g. 'agent', 'human'). Defaults to 'agent' when omitted."
    }
  },
  required: ["plan", "hypothesis", "rationale"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { candidate: { type: "object", properties: {}, additionalProperties: true } },
  required: ["candidate"]
};

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", message);
  }
  return value;
}

function optionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ToolError("invalid_input", `${fieldName} must be an array of strings when supplied`);
  }
  return value;
}

interface CreateCandidateToolInput {
  plan: Plan;
  planStepId: string | null;
  designSpecificationId: string | null;
  proposalId: string | null;
  relevantRequirementIds: string[];
  relevantConstraintIds: string[];
  relevantResearchEvidenceIds: string[];
  assumptionIds: string[];
  hypothesis: string;
  rationale: string;
  parentCandidateId: string | null;
  provenance: EntitySource | null;
}

function toCreateCandidateToolInput(rawInput: unknown): CreateCandidateToolInput {
  const record = rawInput as Record<string, unknown>;

  let plan: Plan;
  try {
    assertPlan(record.plan);
    plan = record.plan as Plan;
  } catch (error) {
    if (error instanceof WorldModelValidationError) {
      throw new ToolError("invalid_input", `plan is invalid: ${error.message}`);
    }
    throw error;
  }

  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }

  return {
    plan,
    planStepId: optionalId(record.planStepId),
    designSpecificationId: optionalId(record.designSpecificationId),
    proposalId: optionalId(record.proposalId),
    relevantRequirementIds: optionalStringArray(record.relevantRequirementIds, "relevantRequirementIds"),
    relevantConstraintIds: optionalStringArray(record.relevantConstraintIds, "relevantConstraintIds"),
    relevantResearchEvidenceIds: optionalStringArray(record.relevantResearchEvidenceIds, "relevantResearchEvidenceIds"),
    assumptionIds: optionalStringArray(record.assumptionIds, "assumptionIds"),
    hypothesis: requireString(record.hypothesis, "hypothesis is required and must be a non-empty string"),
    rationale: requireString(record.rationale, "rationale is required and must be a non-empty string"),
    parentCandidateId: optionalId(record.parentCandidateId),
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createCreateCandidateTool(
  candidateStore: CandidateStore,
  getState: () => WorldModelState,
  designSpecificationStore?: DesignSpecificationStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_candidate",
    description:
      "Records a new Candidate: a proposed alternative approach to a Plan (or one PlanStep of it) -- its hypothesis, rationale, and which requirements/constraints/research evidence it is trying to satisfy. Never mutates the World Model or the environment; never itself declares a candidate valid, verified, or optimal.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toCreateCandidateToolInput(rawInput);
    const state = getState();

    const candidateInput: CandidateInput = {
      projectId: state.project.id,
      projectVersion: state.project.version,
      planId: input.plan.id,
      planStepId: input.planStepId,
      designSpecificationId: input.designSpecificationId,
      proposalId: input.proposalId,
      relevantRequirementIds: input.relevantRequirementIds,
      relevantConstraintIds: input.relevantConstraintIds,
      relevantResearchEvidenceIds: input.relevantResearchEvidenceIds,
      assumptionIds: input.assumptionIds,
      hypothesis: input.hypothesis,
      rationale: input.rationale,
      parentCandidateId: input.parentCandidateId,
      source: input.provenance ?? "agent"
    };

    let candidate;
    try {
      candidate = createCandidate(candidateInput);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `candidate is invalid: ${error.message}`);
      }
      throw error;
    }

    const issues = validateCandidateSemantics(candidate, input.plan, { state, designSpecificationStore, candidateStore });
    if (issues.length > 0) {
      throw new ToolError("invalid_input", `candidate failed semantic validation: ${issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; ")}`);
    }

    candidateStore.save(candidate);
    return { candidate };
  };

  return { tool, handler };
}
