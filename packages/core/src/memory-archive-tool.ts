import { ToolError, WorldModelValidationError, createTool, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { MemoryStore } from "./memory-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 24's archival/rejection tool -- transitions an `"active"` memory to
 * `"archived"` (no longer relevant, but was valid) or `"rejected"` (found
 * to be incorrect after creation), per `MemoryStatus`'s own doc comment.
 * Trivial by design, mirroring `dismiss_clarification`'s (P19) exact shape:
 * no re-computation, no World Model interaction -- just a store lifecycle
 * transition, scoped to the current project.
 *
 * The memory's own CONTENT (`title`/`content`/`references`) is never
 * touched -- only `status`/`updatedAt`/`metadata.archiveReason` change,
 * enforced by `MemoryStore.archive` (core), not by this tool trusting a
 * caller.
 *
 * Classified `mutation: "suggest"` -- `MemoryRecord` lives in its own
 * store, never `WorldModelState`, the same classification
 * `dismiss_clarification`/`answer_clarification` use for the identical
 * reason.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    memoryId: { type: "string" },
    status: { type: "string", enum: ["archived", "rejected"], nullable: true, description: "Defaults to 'archived'." },
    reason: { type: "string", nullable: true }
  },
  required: ["memoryId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { memory: { type: "object", properties: {}, additionalProperties: true } },
  required: ["memory"]
};

interface MemoryArchiveToolInput {
  memoryId: string;
  status: "archived" | "rejected" | null;
  reason: string | null;
}

function toMemoryArchiveToolInput(rawInput: unknown): MemoryArchiveToolInput {
  const record = rawInput as { memoryId?: unknown; status?: unknown; reason?: unknown };
  if (typeof record.memoryId !== "string" || record.memoryId.trim().length === 0) {
    throw new ToolError("invalid_input", "memoryId is required and must be a non-empty string");
  }
  if (record.status !== undefined && record.status !== null && record.status !== "archived" && record.status !== "rejected") {
    throw new ToolError("invalid_input", 'status must be "archived" or "rejected" when supplied');
  }
  return {
    memoryId: record.memoryId,
    status: (record.status as "archived" | "rejected" | undefined) ?? null,
    reason: typeof record.reason === "string" ? record.reason : null
  };
}

export function createMemoryArchiveTool(memoryStore: MemoryStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "memory_archive",
    description: "Transitions an active MemoryRecord to 'archived' (no longer relevant) or 'rejected' (found incorrect). Never deletes the record -- it remains retrievable as historical context.",
    target: "memory",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toMemoryArchiveToolInput(rawInput);
    const state = getState();
    const existing = memoryStore.getById(input.memoryId);
    if (!existing || existing.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `memory_not_found: no memory record "${input.memoryId}" exists in the current project`);
    }
    try {
      const memory = memoryStore.archive(input.memoryId, { status: input.status ?? undefined, reason: input.reason ?? undefined });
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
