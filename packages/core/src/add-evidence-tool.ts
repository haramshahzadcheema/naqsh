import { createResearchEvidence, createTool, ENTITY_SOURCES, ToolError, WorldModelValidationError, type EntitySource, type ResearchEvidenceConfidence, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * A specific claim + excerpt -> real, audited `ResearchEvidence` (P21).
 * Mirrors `add_source_tool.ts`'s exact shape, including its `provenance`
 * input field (defaults to `"research"`, accepts e.g. `"human"` for a
 * user-supplied claim) -- see that file's doc comment for why this is
 * named `provenance` rather than a bare `source` at the tool boundary.
 *
 * REJECTS a `sourceId` that does not name a `Source` already in the
 * CURRENT project (`unknown_source`) -- this is the one referential check
 * P21 needs (see `research-types.ts`'s own doc comment for why this lives
 * here, not in a separate semantics file: `add_relationship`'s reducer
 * never checks cross-entity references either, but a TOOL accepting new
 * project knowledge is exactly the write-time boundary where "don't
 * fabricate evidence for a source that doesn't exist" belongs -- the same
 * boundary `add_requirement` already enforces for `cross_project_forbidden`).
 *
 * The World Model changes ONLY through the EXISTING `add_evidence`
 * `WorldModelTransition` (unmodified) via `recordTransition`.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" },
    claim: { type: "string" },
    excerpt: { type: "string", nullable: true },
    confidence: { type: "string", nullable: true },
    relevanceNote: { type: "string", nullable: true },
    provenance: { type: "string", nullable: true, description: "Who/what supplied this evidence -- one of EntitySource (e.g. 'research', 'human'). Defaults to 'research' when omitted." }
  },
  required: ["sourceId", "claim"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceId: { type: "string" },
    claim: { type: "string" },
    excerpt: { type: "string", nullable: true },
    confidence: { type: "string" },
    relevanceNote: { type: "string", nullable: true },
    status: { type: "string" },
    source: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "sourceId", "claim", "excerpt", "confidence", "relevanceNote", "status", "source", "metadata"]
};

interface AddEvidenceToolInput {
  sourceId: string;
  claim: string;
  excerpt: string | null;
  confidence: string | null;
  relevanceNote: string | null;
  provenance: EntitySource | null;
}

function toAddEvidenceToolInput(input: unknown): AddEvidenceToolInput {
  const record = input as { sourceId?: unknown; claim?: unknown; excerpt?: unknown; confidence?: unknown; relevanceNote?: unknown; provenance?: unknown };
  if (typeof record.sourceId !== "string" || record.sourceId.trim().length === 0) {
    throw new ToolError("invalid_input", "sourceId is required and must be a non-empty string");
  }
  if (typeof record.claim !== "string" || record.claim.trim().length === 0) {
    throw new ToolError("invalid_input", "claim is required and must be a non-empty string");
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }
  return {
    sourceId: record.sourceId,
    claim: record.claim,
    excerpt: typeof record.excerpt === "string" ? record.excerpt : null,
    confidence: typeof record.confidence === "string" ? record.confidence : null,
    relevanceNote: typeof record.relevanceNote === "string" ? record.relevanceNote : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createAddEvidenceTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "add_evidence",
    description:
      "Accepts a specific claim (with a bounded excerpt/reference) supported by an EXISTING project Source, and adds it to the current project's World Model as real, audited ResearchEvidence. Rejects a sourceId that does not name a Source already in the project. This is a real mutation: it is recorded as an audited Change and requires approval like any other.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toAddEvidenceToolInput(rawInput);
    const state = getState();

    if (!state.project.sources.some((source) => source.id === input.sourceId)) {
      throw new ToolError("invalid_input", `unknown_source: "${input.sourceId}" does not name a Source in the current project`);
    }

    let evidenceInput;
    try {
      evidenceInput = {
        sourceId: input.sourceId,
        claim: input.claim,
        excerpt: input.excerpt,
        confidence: (input.confidence ?? undefined) as ResearchEvidenceConfidence | undefined,
        relevanceNote: input.relevanceNote,
        source: input.provenance ?? "research"
      };
      createResearchEvidence(evidenceInput); // pre-validate before ever recording a transition
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `evidence is invalid: ${error.message}`);
      }
      throw error;
    }

    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "add_evidence", evidence: evidenceInput },
      { source: "agent", cause: { kind: "tool_execution", description: `add_evidence: "${input.claim}" (source "${input.sourceId}")` } }
    );
    setState(nextState);

    const added = nextState.project.researchEvidence.at(-1);
    if (!added) {
      throw new ToolError("execution_failure", "evidence unexpectedly missing after being added");
    }
    return added;
  };

  return { tool, handler };
}
