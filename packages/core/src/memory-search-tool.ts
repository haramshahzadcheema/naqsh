import { MEMORY_KINDS, MEMORY_PROVENANCE_KINDS, MEMORY_STATUSES, ToolError, createTool, type MemoryKind, type MemoryProvenanceKind, type MemoryStatus, type Tool, type ToolValueSchema, type WorldModelState } from "@naqsh/schemas";
import type { MemoryStore } from "./memory-store.js";
import { DEFAULT_MEMORY_SEARCH_LIMIT, MAX_MEMORY_SEARCH_RESULTS, searchMemoryRecords } from "./memory-semantics.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 24's memory-RETRIEVAL tool -- deterministic structured search over
 * the CURRENT project's memory only. `projectId` is NOT a caller-supplied
 * input -- it is always read from LIVE `WorldModelState`, exactly like
 * `create_optimization_problem`'s identical anti-spoofing precedent, and is
 * what makes cross-project memory leakage structurally impossible through
 * this tool: there is no field a caller could set to ask for another
 * project's memory.
 *
 * A thin wrapper around the pure `searchMemoryRecords` (memory-semantics.ts)
 * -- this file's only job is the tool-boundary concerns (input validation,
 * reading live state, calling `memoryStore.listForProject` rather than
 * `memoryStore.list()` for defense-in-depth project scoping even before the
 * pure function's own filter runs).
 *
 * `mutation: "observe"` -- read-only, matching every other read-only tool
 * in this repo (`inspect_environment_objects`, `candidate-comparison`-tool,
 * etc.).
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: MEMORY_KINDS as string[], nullable: true },
    status: { type: "string", enum: MEMORY_STATUSES as string[], nullable: true, description: "Defaults to 'active' -- pass explicitly to retrieve superseded/archived/rejected history." },
    provenanceKind: { type: "string", enum: MEMORY_PROVENANCE_KINDS as string[], nullable: true },
    source: { type: "string", nullable: true },
    referencedEntityId: { type: "string", nullable: true, description: "Matches a memory whose any reference field contains this id." },
    textQuery: { type: "string", nullable: true, description: "Case-insensitive substring match against title or content." },
    limit: { type: "number", nullable: true, description: `Defaults to ${DEFAULT_MEMORY_SEARCH_LIMIT}, capped at ${MAX_MEMORY_SEARCH_RESULTS}.` }
  },
  required: []
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    records: { type: "array", items: { type: "object", properties: {}, additionalProperties: true } },
    totalMatched: { type: "number" },
    limit: { type: "number" }
  },
  required: ["records", "totalMatched", "limit"]
};

interface MemorySearchToolInput {
  kind: MemoryKind | null;
  status: MemoryStatus | null;
  provenanceKind: MemoryProvenanceKind | null;
  source: string | null;
  referencedEntityId: string | null;
  textQuery: string | null;
  limit: number | null;
}

function toMemorySearchToolInput(rawInput: unknown): MemorySearchToolInput {
  const record = (rawInput ?? {}) as {
    kind?: unknown;
    status?: unknown;
    provenanceKind?: unknown;
    source?: unknown;
    referencedEntityId?: unknown;
    textQuery?: unknown;
    limit?: unknown;
  };
  if (record.kind !== undefined && record.kind !== null && !(MEMORY_KINDS as readonly string[]).includes(record.kind as string)) {
    throw new ToolError("invalid_input", `kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  if (record.status !== undefined && record.status !== null && !(MEMORY_STATUSES as readonly string[]).includes(record.status as string)) {
    throw new ToolError("invalid_input", `status must be one of: ${MEMORY_STATUSES.join(", ")}`);
  }
  if (record.provenanceKind !== undefined && record.provenanceKind !== null && !(MEMORY_PROVENANCE_KINDS as readonly string[]).includes(record.provenanceKind as string)) {
    throw new ToolError("invalid_input", `provenanceKind must be one of: ${MEMORY_PROVENANCE_KINDS.join(", ")}`);
  }
  if (record.limit !== undefined && record.limit !== null && (typeof record.limit !== "number" || !Number.isFinite(record.limit) || record.limit < 1)) {
    throw new ToolError("invalid_input", "limit must be a positive number when supplied");
  }

  return {
    kind: typeof record.kind === "string" ? (record.kind as MemoryKind) : null,
    status: typeof record.status === "string" ? (record.status as MemoryStatus) : null,
    provenanceKind: typeof record.provenanceKind === "string" ? (record.provenanceKind as MemoryProvenanceKind) : null,
    source: typeof record.source === "string" ? record.source : null,
    referencedEntityId: typeof record.referencedEntityId === "string" ? record.referencedEntityId : null,
    textQuery: typeof record.textQuery === "string" ? record.textQuery : null,
    limit: typeof record.limit === "number" ? record.limit : null
  };
}

export function createMemorySearchTool(memoryStore: MemoryStore, getState: () => WorldModelState): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "memory_search",
    description:
      "Deterministic, bounded, project-scoped search over MemoryRecords: filter by kind/status/provenanceKind/source/referencedEntityId, optionally a title/content text query. Read-only; never touches the World Model or the environment.",
    target: "memory",
    mutation: "observe",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toMemorySearchToolInput(rawInput);
    const state = getState();
    const projectRecords = memoryStore.listForProject(state.project.id);
    const result = searchMemoryRecords(projectRecords, {
      projectId: state.project.id,
      kind: input.kind ?? undefined,
      status: input.status ?? undefined,
      provenanceKind: input.provenanceKind ?? undefined,
      source: input.source ?? undefined,
      referencedEntityId: input.referencedEntityId ?? undefined,
      textQuery: input.textQuery ?? undefined,
      limit: input.limit ?? undefined
    });
    return result;
  };

  return { tool, handler };
}
