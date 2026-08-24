import { WorldModelValidationError, type AgentLoopRun } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `AgentLoopRun` audit records (P11) --
 * mirrors `CheckpointStore`'s exact shape and "immutable once created"
 * discipline. A caller of this integration only ever saves a run ONCE, in
 * its final terminal state (`resumeAgentLoopRunAfterApproval`'s return
 * value) -- the intermediate `"awaiting_approval"` state is never persisted
 * here, because in this codebase the approval decision already happened
 * synchronously (via the existing chat-triggered approve/reject actions)
 * before `executeProposal` ever constructs and resumes a run; there is no
 * caller that needs to read back a still-pending run.
 */
export interface AgentLoopRunStore {
  save(run: AgentLoopRun): void;
  getById(id: string): AgentLoopRun | undefined;
  list(): readonly AgentLoopRun[];
  listForProject(projectId: string): readonly AgentLoopRun[];
  serialize(): string;
}

export function createAgentLoopRunStore(): AgentLoopRunStore {
  const runs = new Map<string, AgentLoopRun>();

  return {
    save(run) {
      if (runs.has(run.id)) {
        throw new WorldModelValidationError("invalid_shape", `AgentLoopRun "${run.id}" already exists -- runs are immutable once saved`);
      }
      runs.set(run.id, run);
    },
    getById: (id) => runs.get(id),
    list: () => Array.from(runs.values()),
    listForProject: (projectId) => Array.from(runs.values()).filter((run) => run.projectId === projectId),
    serialize: () => JSON.stringify(Array.from(runs.values()))
  };
}

/** Rebuilds an `AgentLoopRunStore` from `serialize()`'s output -- each entry
 * is re-validated via `save()`'s own duplicate-id guard, matching
 * `deserializeCheckpointStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. */
export function deserializeAgentLoopRunStore(serialized: string): AgentLoopRunStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized agent loop run store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized agent loop run store must be an array");
  }
  const store = createAgentLoopRunStore();
  for (const entry of parsed as AgentLoopRun[]) {
    store.save(entry);
  }
  return store;
}
