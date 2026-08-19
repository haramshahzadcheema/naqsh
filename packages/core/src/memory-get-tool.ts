import { ToolError, createTool, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { MemoryStore } from "./memory-store.js";
import { getRelatedMemoryRecords } from "./memory-semantics.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 24's single-record memory lookup, ALSO answering the brief's own
 * "getRelatedMemory" operation as part of the same call rather than a
 * sixth separate tool (brief: "Only add tools that are actually
 * necessary") -- `related` is populated via the pure, deterministic
 * `getRelatedMemoryRecords` (memory-semantics.ts): the direct supersession
 * neighbors (what this memory supersedes / is superseded by) plus any
 * OTHER active-or-not memory in the same project that shares at least one
 * reference id. This is what lets a caller answer "why was Candidate B
 * selected?" starting from one memory id and walking outward through real,
 * typed links -- never a second, free-text "explanation" disconnected from
 * the evidence.
 *
 * Both the target lookup and every related candidate are scoped to the
 * CURRENT project (`memoryStore.listForProject`, never `memoryStore.list()`)
 * -- a memory belonging to a different project is treated as not found,
 * exactly like `record-candidate-metric-value-tool.ts`'s (P23 audit)
 * `verification_result_wrong_project` precedent for a single-record
 * cross-reference.
 *
 * `mutation: "observe"` -- read-only.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: { memoryId: { type: "string" } },
  required: ["memoryId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    memory: { type: "object", properties: {}, additionalProperties: true },
    related: {
      type: "array",
      items: {
        type: "object",
        properties: {
          memory: { type: "object", properties: {}, additionalProperties: true },
          relation: { type: "string", enum: ["shares_reference", "supersedes", "superseded_by"] }
        },
        required: ["memory", "relation"]
      }
    }
  },
  required: ["memory", "related"]
};

function toMemoryGetToolInput(rawInput: unknown): { memoryId: string } {
  const record = rawInput as { memoryId?: unknown };
  if (typeof record.memoryId !== "string" || record.memoryId.trim().length === 0) {
    throw new ToolError("invalid_input", "memoryId is required and must be a non-empty string");
  }
  return { memoryId: record.memoryId };
}

export function createMemoryGetTool(memoryStore: MemoryStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "memory_get",
    description:
      "Retrieves a single MemoryRecord by id, along with related memory (supersession neighbors and any other memory sharing a reference), scoped to the current project. Read-only.",
    target: "memory",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const { memoryId } = toMemoryGetToolInput(rawInput);
    const state = getState();
    const memory = memoryStore.getById(memoryId);
    if (!memory || memory.projectId !== state.project.id) {
      throw new ToolError("invalid_input", `memory_not_found: no memory record "${memoryId}" exists in the current project`);
    }
    const projectRecords = memoryStore.listForProject(state.project.id);
    const related = getRelatedMemoryRecords(projectRecords, memoryId).map((entry) => ({ memory: entry.record, relation: entry.relation }));
    return { memory, related };
  };

  return { tool, handler };
}
