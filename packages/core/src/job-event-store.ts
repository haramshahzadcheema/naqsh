import { WorldModelValidationError, type JobEvent } from "@naqsh/schemas";

/**
 * Deterministic, in-memory, APPEND-ONLY store for `JobEvent` (P25) --
 * mirrors `VerificationResultStore`/`CandidateMetricValueStore`'s exact
 * shape: a `JobEvent` is a fact that already happened and is never
 * mutated or deleted after being recorded, the same discipline every
 * other append-only audit-trail record in this repo already follows.
 *
 * This is P25's own AUDITABLE TRAIL of significant job lifecycle
 * transitions (`submitted`/`started`/`candidate_started`/
 * `budget_exhausted`/`cancelled`/... -- see `JobEventKind`, schemas) --
 * deliberately a SEPARATE record kind from `Change` (P2), never a second,
 * incompatible audit mechanism: a job event is a process/execution fact
 * about BACKGROUND ORCHESTRATION, not a `WorldModelTransition`, so it does
 * not belong in the Change Model any more than a `VerificationResult` or
 * `OptimizationResult` does -- but it follows Change's own "sequential,
 * append-only, never rewritten" discipline exactly.
 */
export interface JobEventStore {
  save(event: JobEvent): void;
  getById(id: string): JobEvent | undefined;
  list(): readonly JobEvent[];
  /** Events for one job, in the order they were recorded -- the
   * deterministic audit trail for that job's run. */
  listForJob(jobId: string): readonly JobEvent[];
  listForProject(projectId: string): readonly JobEvent[];
  serialize(): string;
}

function buildStore(events: Map<string, JobEvent>): JobEventStore {
  return {
    save(event) {
      if (events.has(event.id)) {
        throw new WorldModelValidationError("invalid_shape", `JobEvent "${event.id}" already exists`);
      }
      events.set(event.id, event);
    },
    getById: (id) => events.get(id),
    list: () => Array.from(events.values()),
    listForJob: (jobId) => Array.from(events.values()).filter((event) => event.jobId === jobId),
    listForProject: (projectId) => Array.from(events.values()).filter((event) => event.projectId === projectId),
    serialize: () => JSON.stringify(Array.from(events.values()))
  };
}

export function createJobEventStore(): JobEventStore {
  return buildStore(new Map());
}

export function deserializeJobEventStore(serialized: string): JobEventStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized job event store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized job event store must be an array");
  }
  const store = createJobEventStore();
  for (const entry of parsed as JobEvent[]) {
    store.save(entry);
  }
  return store;
}
