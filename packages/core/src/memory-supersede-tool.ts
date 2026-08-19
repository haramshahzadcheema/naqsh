import { ToolError, WorldModelValidationError, createTool, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { MemoryStore } from "./memory-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 24's explicit supersession tool -- the ONLY place a memory actually
 * transitions from `"active"` to `"superseded"`. Both records must already
 * exist and belong to the CURRENT project (closes the same cross-project
 * leakage `memory_get`/`memory_archive` already close); the OLD record's
 * content is never touched -- only `status`/`supersededByMemoryId`/
 * `updatedAt` change, applied by `MemoryStore.supersede` (core), which also
 * rejects a cycle (see that file's own doc comment for the exact
 * algorithm). Neither record is ever deleted -- both remain retrievable
 * (brief: "Do not delete historical knowledge merely because it is no
 * longer current").
 *
 * Deliberately separate from `memory_add` (which only accepts a
 * `supersedesMemoryId` DECLARATION, never applies the transition itself) --
 * see that file's own doc comment for why keeping this a single-purpose,
 * always-succeeds-or-cleanly-fails operation matters more than saving one
 * extra tool call.
 *
 * Classified `mutation: "suggest"` for the identical reason
 * `memory_archive`/`dismiss_clarification`/`answer_clarification` are.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    oldMemoryId: { type: "string" },
    newMemoryId: { type: "string" }
  },
  required: ["oldMemoryId", "newMemoryId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { memory: { type: "object", properties: {}, additionalProperties: true } },
  required: ["memory"]
};

function toMemorySupersedeToolInput(rawInput: unknown): { oldMemoryId: string; newMemoryId: string } {
  const record = rawInput as { oldMemoryId?: unknown; newMemoryId?: unknown };
  if (typeof record.oldMemoryId !== "string" || record.oldMemoryId.trim().length === 0) {
    throw new ToolError("invalid_input", "oldMemoryId is required and must be a non-empty string");
  }
  if (typeof record.newMemoryId !== "string" || record.newMemoryId.trim().length === 0) {
    throw new ToolError("invalid_input", "newMemoryId is required and must be a non-empty string");
  }
  return { oldMemoryId: record.oldMemoryId, newMemoryId: record.newMemoryId };
}

export function createMemorySupersedeTool(memoryStore: MemoryStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "memory_supersede",
    description:
      "Marks an active MemoryRecord as superseded by a newer one. Neither record is deleted; the old record remains retrievable, forever historically valid, and its content is never rewritten -- only its lifecycle status changes.",
    target: "memory",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const { oldMemoryId, newMemoryId } = toMemorySupersedeToolInput(rawInput);
    const state = getState();

    const old = memoryStore.getById(oldMemoryId);
    if (!old || old.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `memory_not_found: no memory record "${oldMemoryId}" exists in the current project`);
    }
    const replacement = memoryStore.getById(newMemoryId);
    if (!replacement || replacement.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `memory_not_found: no memory record "${newMemoryId}" exists in the current project`);
    }

    try {
      const memory = memoryStore.supersede(oldMemoryId, newMemoryId);
      return { memory };
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", error.message);
      }
      throw error;
    }
  };

  return { tool, handler };
}
