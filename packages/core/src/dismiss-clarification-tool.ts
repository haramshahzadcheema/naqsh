import { createTool, ToolError, WorldModelValidationError, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import type { ClarificationStore } from "./clarification-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Explicitly closes a pending `Clarification` WITHOUT an answer -- the
 * `"dismissed"` lifecycle state Step 4 requires, distinct from
 * `"answered"` so a reader can never mistake "we chose not to ask this"
 * for "this was resolved." Trivial by design: no Gemini call, no
 * re-interpretation, no World Model interaction -- just a store state
 * transition, classified identically to the other two P19 tools
 * (`mutation: "suggest"`) for the same reason.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    clarificationId: { type: "string" },
    reason: { type: "string", nullable: true, description: "Optional: why this clarification is being dismissed." }
  },
  required: ["clarificationId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { clarification: { type: "object", properties: {}, additionalProperties: true } },
  required: ["clarification"]
};

function toDismissInput(rawInput: unknown): { clarificationId: string; reason?: string } {
  const record = rawInput as { clarificationId?: unknown; reason?: unknown };
  if (typeof record.clarificationId !== "string" || record.clarificationId.trim().length === 0) {
    throw new ToolError("invalid_input", "clarificationId is required and must be a non-empty string");
  }
  return { clarificationId: record.clarificationId, reason: typeof record.reason === "string" ? record.reason : undefined };
}

export function createDismissClarificationTool(clarificationStore: ClarificationStore): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "dismiss_clarification",
    description: "Closes a pending Clarification (P19) without an answer. Never mutates the World Model.",
    target: "world_model",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const { clarificationId, reason } = toDismissInput(rawInput);
    try {
      const clarification = clarificationStore.dismiss(clarificationId, reason);
      return { clarification };
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", error.message);
      }
      throw error;
    }
  };

  return { tool, handler };
}
