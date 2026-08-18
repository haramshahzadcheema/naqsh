import { createSource, createTool, ENTITY_SOURCES, ToolError, WorldModelValidationError, type EntitySource, type SourceReliability, type SourceType, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * `ResearchSourceCandidate` (untrusted, `research_search`/`research_fetch`
 * output) -> real, audited `Source` (P21). Mirrors `add_requirement`'s
 * (P18) exact shape and reasoning: a real `mutation: "mutate"` tool, gated
 * by the same P3/P4 approval boundary every World Model write goes
 * through -- a candidate never becomes traceable project knowledge just
 * because a provider returned something plausible-shaped.
 *
 * `provenance` (optional tool input, defaults to `"research"`) becomes the
 * accepted `Source.source` field -- named `provenance` at the tool
 * boundary specifically to avoid the "Source the entity" / "source the
 * provenance field" ambiguity a bare `source` input parameter would read
 * as. This is what makes a human-supplied citation (brief Section 18)
 * genuinely traceable AS human-provided (`provenance: "human"`) rather
 * than every accepted Source silently claiming it came from research
 * regardless of who actually supplied it (an earlier, audit-caught defect
 * in this file -- the README's own "only source: 'human' differs" claim
 * was false until this field existed).
 *
 * The World Model changes ONLY through the EXISTING `add_source`
 * `WorldModelTransition` (unmodified) via `recordTransition` -- never a
 * direct array push onto `project.sources`, never a second write path.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    locator: { type: "string", nullable: true },
    title: { type: "string" },
    publisher: { type: "string", nullable: true },
    sourceType: { type: "string" },
    reliability: { type: "string", nullable: true },
    publishedAt: { type: "string", nullable: true },
    contentHash: { type: "string", nullable: true },
    provenance: { type: "string", nullable: true, description: "Who/what supplied this source -- one of EntitySource (e.g. 'research', 'human'). Defaults to 'research' when omitted." }
  },
  required: ["title", "sourceType"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    locator: { type: "string", nullable: true },
    title: { type: "string" },
    publisher: { type: "string", nullable: true },
    sourceType: { type: "string" },
    reliability: { type: "string" },
    status: { type: "string" },
    source: { type: "string" },
    metadata: { type: "object", properties: {}, additionalProperties: true }
  },
  required: ["id", "locator", "title", "publisher", "sourceType", "reliability", "status", "source", "metadata"]
};

interface AddSourceToolInput {
  locator: string | null;
  title: string;
  publisher: string | null;
  sourceType: SourceType;
  reliability?: string | null;
  publishedAt: string | null;
  contentHash: string | null;
  provenance: EntitySource | null;
}

function toAddSourceToolInput(input: unknown): AddSourceToolInput {
  const record = input as { locator?: unknown; title?: unknown; publisher?: unknown; sourceType?: unknown; reliability?: unknown; publishedAt?: unknown; contentHash?: unknown; provenance?: unknown };
  if (typeof record.title !== "string" || record.title.trim().length === 0) {
    throw new ToolError("invalid_input", "title is required and must be a non-empty string");
  }
  if (typeof record.sourceType !== "string" || record.sourceType.trim().length === 0) {
    throw new ToolError("invalid_input", "sourceType is required and must be a non-empty string");
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }
  return {
    locator: typeof record.locator === "string" ? record.locator : null,
    title: record.title,
    publisher: typeof record.publisher === "string" ? record.publisher : null,
    sourceType: record.sourceType as SourceType,
    reliability: typeof record.reliability === "string" ? record.reliability : null,
    publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : null,
    contentHash: typeof record.contentHash === "string" ? record.contentHash : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createAddSourceTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "add_source",
    description:
      "Accepts a candidate source (typically from research_search/research_fetch, or a human-provided citation) and adds it to the current project's World Model as a real, audited Source. This is a real mutation: it is recorded as an audited Change and requires approval like any other.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toAddSourceToolInput(rawInput);
    const state = getState();

    let sourceInput;
    try {
      sourceInput = {
        locator: input.locator,
        title: input.title,
        publisher: input.publisher,
        sourceType: input.sourceType,
        reliability: (input.reliability ?? undefined) as SourceReliability | undefined,
        publishedAt: input.publishedAt,
        contentHash: input.contentHash,
        source: input.provenance ?? "research"
      };
      createSource(sourceInput); // pre-validate before ever recording a transition
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `source is invalid: ${error.message}`);
      }
      throw error;
    }

    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "add_source", source: sourceInput },
      { source: "agent", cause: { kind: "tool_execution", description: `add_source: "${input.title}"` } }
    );
    setState(nextState);

    const added = nextState.project.sources.at(-1);
    if (!added) {
      throw new ToolError("execution_failure", "source unexpectedly missing after being added");
    }
    return added;
  };

  return { tool, handler };
}
