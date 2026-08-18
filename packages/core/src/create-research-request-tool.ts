import { createResearchRequest, createTool, ENTITY_SOURCES, ToolError, WorldModelValidationError, type EntitySource, type SourceType, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ResearchRequestStore } from "./research-request-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 21's FIRST step of the research pipeline (brief Section 3: "Agent
 * -> Research Request -> Research Tool -> ..."): records WHY research is
 * about to be performed, BEFORE any external call happens. Mirrors
 * `create_check`'s (P16) exact shape and classification -- a new,
 * independent, auditable record in its own store, never a World Model
 * write. Deliberately separate from `research_search`/`research_fetch`
 * (which do the actual external retrieval): a `ResearchRequest` can exist
 * -- and be audited -- even if the searches that follow it find nothing
 * useful, mirroring `create_check`'s own "the definition persists
 * independently of any one evaluation" reasoning.
 *
 * `query`/`purpose` are BOTH required and non-empty (enforced again here,
 * on top of `assertResearchRequest`'s own check) -- the P21 brief's
 * Section 12 insists research must explain WHY, not just what, and this is
 * the one place an agent actually supplies that explanation.
 *
 * `relatedRequirementIds`/`relatedConstraintIds`, when supplied, are
 * cross-checked against the CURRENT project (never a hallucinated
 * reference) -- the same "don't fabricate a link to something that
 * doesn't exist" discipline `add_evidence`'s `unknown_source` check
 * already applies one step later in this same pipeline.
 * `relatedPlanId`/`relatedPlanStepId` are NOT cross-checked here (this
 * tool takes no `PlanStore` dependency, keeping it usable before a plan
 * exists at all) -- they are honest, unenforced traceability hints, exactly
 * like `DesignSpecification.planStepId` is enforced by `design-semantics.ts`
 * only where a `Plan` is actually available to check against.
 *
 * `provenance` (optional, defaults to `"agent"`) becomes the request's own
 * `source` field -- named `provenance` at the tool boundary for the same
 * reason `add_source_tool.ts`/`add_evidence_tool.ts` do: a human can also
 * directly ask for research (e.g. through a future UI), and that should be
 * traceable as `"human"`, not silently attributed to the agent.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    purpose: { type: "string" },
    relatedRequirementIds: { type: "array", items: { type: "string" }, nullable: true },
    relatedConstraintIds: { type: "array", items: { type: "string" }, nullable: true },
    relatedPlanId: { type: "string", nullable: true },
    relatedPlanStepId: { type: "string", nullable: true },
    preferredSourceTypes: { type: "array", items: { type: "string" }, nullable: true },
    maxResults: { type: "number", nullable: true },
    freshnessRequirementDays: { type: "number", nullable: true },
    provenance: { type: "string", nullable: true, description: "Who/what requested this research -- one of EntitySource (e.g. 'agent', 'human'). Defaults to 'agent' when omitted." }
  },
  required: ["query", "purpose"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { request: { type: "object", properties: {}, additionalProperties: true } },
  required: ["request"]
};

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", message);
  }
  return value;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function createCreateResearchRequestTool(researchRequestStore: ResearchRequestStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_research_request",
    description:
      "Records a structured, auditable research request: a query AND why it is being performed (purpose), optionally linked to existing requirements/constraints/a plan step. Creates a new independent record -- never touches the World Model or performs any external call itself.",
    target: "research",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const record = rawInput as Record<string, unknown>;
    const query = requireString(record.query, "query is required and must be a non-empty string");
    const purpose = requireString(record.purpose, "purpose is required and must be a non-empty string -- research must explain WHY it is being performed");
    const relatedRequirementIds = optionalStringArray(record.relatedRequirementIds);
    const relatedConstraintIds = optionalStringArray(record.relatedConstraintIds);

    const state = getState();
    for (const requirementId of relatedRequirementIds) {
      if (!state.project.requirements.some((requirement) => requirement.id === requirementId)) {
        throw new ToolError("invalid_input", `unknown_requirement: "${requirementId}" does not name a Requirement in the current project`);
      }
    }
    for (const constraintId of relatedConstraintIds) {
      if (!state.project.constraints.some((constraint) => constraint.id === constraintId)) {
        throw new ToolError("invalid_input", `unknown_constraint: "${constraintId}" does not name a Constraint in the current project`);
      }
    }
    if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
      throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
    }
    const provenance: EntitySource | null = typeof record.provenance === "string" ? (record.provenance as EntitySource) : null;

    let request;
    try {
      request = createResearchRequest({
        projectId: state.project.id,
        projectVersion: state.project.version,
        query,
        purpose,
        relatedRequirementIds,
        relatedConstraintIds,
        relatedPlanId: typeof record.relatedPlanId === "string" ? record.relatedPlanId : null,
        relatedPlanStepId: typeof record.relatedPlanStepId === "string" ? record.relatedPlanStepId : null,
        preferredSourceTypes: optionalStringArray(record.preferredSourceTypes) as SourceType[],
        maxResults: typeof record.maxResults === "number" ? record.maxResults : undefined,
        freshnessRequirementDays: typeof record.freshnessRequirementDays === "number" ? record.freshnessRequirementDays : null,
        source: provenance ?? "agent"
      });
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `research request is invalid: ${error.message}`);
      }
      throw error;
    }

    researchRequestStore.save(request);
    return { request };
  };

  return { tool, handler };
}
