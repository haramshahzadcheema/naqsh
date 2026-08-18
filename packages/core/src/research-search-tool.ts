import { assertResearchSearchInvocationResult, createResearchSearchRequest, createTool, ToolError, WorldModelValidationError, type SourceType, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { ResearchProvider } from "./research-provider.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * `research_search` -- P21's first explicit research capability (brief
 * Section 3: "Do not allow Gemini to simply 'know' external information.
 * Research must be an explicit tool/action."). Unlike Gemini itself
 * (P7-P20, always called directly by an orchestrating core function, never
 * wrapped as a `Tool`), a `ResearchProvider` genuinely needs to be a
 * TOOL: the agent, not a fixed pipeline, decides WHEN research is needed,
 * so it must be reachable through the same `executeTool`/P4 boundary any
 * other agent-invoked action goes through.
 *
 * Classified `mutation: "suggest"`, `target: "research"` (P3's own
 * `ToolTarget` enum has named `"research"` since Phase 3, unmodified here)
 * -- an external network call is a real side effect, but it does not
 * mutate `WorldModelState`, exactly like `interpret_requirement` (P18,
 * also an external network call, also `"suggest"`). Returns CANDIDATES
 * only (`ResearchSourceCandidate[]`) -- never a `Source`, never something
 * a caller could mistake for accepted project knowledge. Only
 * `add_source`/`add_evidence` (both `mutation: "mutate"`, gated by real
 * P4 approval) can turn a candidate into World Model state.
 *
 * Holds a plain `ResearchProvider` reference in closure -- no
 * `WorldModelState`, no `ToolRegistry`, no session concept (unlike
 * `EnvironmentAdapter`, a `ResearchProvider` is stateless request/response,
 * so there is nothing to "connect" first).
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "number", nullable: true },
    preferredSourceTypes: { type: "array", items: { type: "string" }, nullable: true }
  },
  required: ["query"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          locator: { type: "string", nullable: true },
          title: { type: "string" },
          publisher: { type: "string", nullable: true },
          sourceType: { type: "string" },
          publishedAt: { type: "string", nullable: true },
          snippet: { type: "string" }
        },
        required: ["locator", "title", "publisher", "sourceType", "publishedAt", "snippet"]
      }
    }
  },
  required: ["results"]
};

interface ResearchSearchToolInput {
  query: string;
  maxResults?: number | null;
  preferredSourceTypes?: SourceType[] | null;
}

function toResearchSearchToolInput(input: unknown): ResearchSearchToolInput {
  const record = input as { query?: unknown; maxResults?: unknown; preferredSourceTypes?: unknown };
  if (typeof record.query !== "string" || record.query.trim().length === 0) {
    throw new ToolError("invalid_input", "query is required and must be a non-empty string");
  }
  return {
    query: record.query,
    maxResults: typeof record.maxResults === "number" ? record.maxResults : null,
    preferredSourceTypes: Array.isArray(record.preferredSourceTypes) ? (record.preferredSourceTypes as SourceType[]) : null
  };
}

export function createResearchSearchTool(provider: ResearchProvider): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "research_search",
    description:
      "Searches for candidate external sources relevant to a query, through a ResearchProvider. Returns lightweight candidates (title/publisher/type/snippet) -- never full content, never authoritative project state. A candidate only becomes real, traceable World Model knowledge via add_source/add_evidence, which require separate approval.",
    target: "research",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toResearchSearchToolInput(rawInput);
    const request = createResearchSearchRequest({
      query: input.query,
      maxResults: input.maxResults ?? undefined,
      preferredSourceTypes: input.preferredSourceTypes ?? undefined
    });
    const result = await provider.search(request);
    // The provider's ENVELOPE is re-validated here, not merely trusted --
    // a provider is untrusted external code from this tool's point of
    // view, exactly like fetched web content is untrusted DATA (P21 brief
    // Section 21). This is what turns "oversized/malformed provider
    // output" into an explicit execution_failure instead of silently
    // flowing through to whatever calls this tool next (e.g. a model's
    // context window).
    try {
      assertResearchSearchInvocationResult(result);
    } catch (error) {
      throw new ToolError("execution_failure", error instanceof WorldModelValidationError ? `research provider returned a malformed result: ${error.message}` : String(error));
    }
    if (result.status === "error") {
      throw new ToolError("execution_failure", result.error?.message ?? "research provider search failed");
    }
    return { results: result.results };
  };

  return { tool, handler };
}
