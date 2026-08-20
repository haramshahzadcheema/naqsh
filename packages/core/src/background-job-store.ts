import { createBackgroundJob, isJobStatusTransitionAllowed, toIsoTimestamp, WorldModelValidationError, type BackgroundJob, type JobResult, type JobStatus } from "@naqsh/schemas";

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "cancelled", "failed"]);

/**
 * AUDIT FIX: what a lifecycle TRANSITION is allowed to set, deliberately
 * NOT `Partial<BackgroundJob>`. The original signature let a caller patch
 * in ANY field -- `budget`, `autonomyLevel`, `allowedTools`, `projectId`,
 * `candidateIds`, even `id` -- through the one function that is supposed
 * to be a pure STATUS transition. Nothing in this repository's actual call
 * graph exploits that today (every real caller only ever passes
 * `consumption`/`result`/`failureReason`), but the brief's own explicit
 * "budgets cannot be silently increased during execution" is a structural
 * requirement, not a convention to trust -- exactly the same "the API
 * surface itself must not be ABLE to do the unsafe thing" discipline prior
 * phase audits in this repo already established. A transition can update
 * the RESULT of running (how much budget was consumed, what the outcome
 * was, why it failed) -- never the job's own SCOPE or AUTHORITY.
 */
export interface BackgroundJobTransitionPatch {
  consumption?: BackgroundJob["consumption"];
  result?: JobResult | null;
  failureReason?: string | null;
}

/**
 * Deterministic, in-memory store for `BackgroundJob` (P25) -- mirrors
 * `MemoryStore`'s (P24) exact shape: a plain `Map` behind a typed
 * interface, MUTABLE-IN-PLACE for LIFECYCLE transitions only, because a
 * job's `status` genuinely transitions over its run (`queued` ->
 * `running` -> ... -> a terminal state). Every transition replaces the
 * stored record with a new frozen snapshot (via `createBackgroundJob`);
 * this store never hands out a mutable reference.
 *
 * NOT part of `WorldModelState` -- a `BackgroundJob` is a process/
 * execution record, exactly like `Candidate`/`OptimizationProblem`/
 * `MemoryRecord` are not `Project` entities either. The one canonical
 * project state remains `WorldModelState`; this store no more competes
 * with it than any of those already-audited stores do.
 *
 * `transition` is the ONE place a `JobStatus` ever actually changes --
 * it consults `isJobStatusTransitionAllowed` (schemas) before applying
 * anything, so `completed -> running` (or any other nonsense transition)
 * is rejected here, structurally, not merely by caller discipline.
 * Lifecycle TIMESTAMPS (`startedAt`/`completedAt`/`cancelRequestedAt`)
 * are computed HERE, freshly, at the moment of the real transition --
 * never left to `createBackgroundJob`'s own construction-time defaulting,
 * which would incorrectly reuse the ORIGINAL `createdAt` for a job
 * transitioning long after it was first queued.
 */
export interface BackgroundJobStore {
  /** Always starts "queued" -- rejects an input that already claims a
   * different status (use `transition` for lifecycle changes instead of
   * constructing a pre-resolved record). Rejects a duplicate id. */
  save(job: BackgroundJob): void;
  getById(id: string): BackgroundJob | undefined;
  list(): readonly BackgroundJob[];
  listForProject(projectId: string): readonly BackgroundJob[];
  /** The CONCURRENCY POLICY seam (brief: "one mutating job per project at
   * a time"): returns the job currently `"running"` for this project, or
   * `undefined` if none. `background-job-runner.ts` consults this before
   * transitioning a job to `"running"` and refuses to start a second one. */
  getRunningJobForProject(projectId: string): BackgroundJob | undefined;
  /** Throws `WorldModelValidationError` for a missing id or an illegal
   * transition (`isJobStatusTransitionAllowed` says no) -- a transition
   * can only ever move the job exactly one legal step. `patch` carries
   * ONLY the lifecycle-OUTCOME fields this specific transition needs to
   * set (`result`/`failureReason` when moving to a terminal status,
   * `consumption` to record budget usage so far) -- see
   * `BackgroundJobTransitionPatch`'s own doc comment for why this is
   * deliberately narrower than `Partial<BackgroundJob>`. Lifecycle
   * TIMESTAMPS are always computed internally, from the real clock, never
   * caller-suppliable. */
  transition(id: string, to: JobStatus, patch?: BackgroundJobTransitionPatch): BackgroundJob;
  serialize(): string;
}

function requireJob(jobs: Map<string, BackgroundJob>, id: string): BackgroundJob {
  const job = jobs.get(id);
  if (!job) {
    throw new WorldModelValidationError("invalid_shape", `No background job with id "${id}" exists`);
  }
  return job;
}

/** Builds a `BackgroundJobStore` around an already-populated `Map` -- the
 * one implementation both `createBackgroundJobStore` (starts empty) and
 * `deserializeBackgroundJobStore` (starts pre-populated from validated
 * JSON) share, so the lifecycle-transition logic exists in exactly one
 * place. */
function buildStore(jobs: Map<string, BackgroundJob>): BackgroundJobStore {
  return {
    save(job) {
      if (job.status !== "queued") {
        throw new WorldModelValidationError("invalid_shape", `A new background job must be saved as "queued", got "${job.status}"`);
      }
      if (jobs.has(job.id)) {
        throw new WorldModelValidationError("invalid_shape", `BackgroundJob "${job.id}" already exists`);
      }
      jobs.set(job.id, job);
    },
    getById: (id) => jobs.get(id),
    list: () => Array.from(jobs.values()),
    listForProject: (projectId) => Array.from(jobs.values()).filter((job) => job.projectId === projectId),
    getRunningJobForProject: (projectId) => Array.from(jobs.values()).find((job) => job.projectId === projectId && job.status === "running"),
    transition(id, to, patch = {}) {
      const current = requireJob(jobs, id);
      if (!isJobStatusTransitionAllowed(current.status, to)) {
        throw new WorldModelValidationError("invalid_shape", `BackgroundJob "${id}" cannot transition from "${current.status}" to "${to}"`);
      }
      const now = toIsoTimestamp();
      const startingNow = to === "running" && current.startedAt === null;
      const enteringTerminal = TERMINAL_STATUSES.has(to);
      const cancellationJustRequested = (to === "cancelling" || to === "cancelled") && current.cancelRequestedAt === null;

      // Defense in depth, not just the type signature above: pick ONLY
      // the three sanctioned fields out of `patch` by name, rather than
      // spreading it wholesale -- a runtime-bypassed call (e.g. `as any`,
      // or a patch object built from untrusted/deserialized data) still
      // cannot smuggle `budget`/`autonomyLevel`/`allowedTools`/`projectId`/
      // `candidateIds`/`id` through, even though JS's own spread operator
      // has no concept of TypeScript's narrower `BackgroundJobTransitionPatch`.
      const updated = createBackgroundJob({
        ...current,
        status: to,
        startedAt: startingNow ? now : current.startedAt,
        completedAt: enteringTerminal ? now : current.completedAt,
        cancelRequestedAt: cancellationJustRequested ? now : current.cancelRequestedAt,
        consumption: patch.consumption ?? current.consumption,
        result: patch.result !== undefined ? patch.result : current.result,
        failureReason: patch.failureReason !== undefined ? patch.failureReason : current.failureReason
      });
      jobs.set(id, updated);
      return updated;
    },
    serialize: () => JSON.stringify(Array.from(jobs.values()))
  };
}

export function createBackgroundJobStore(): BackgroundJobStore {
  return buildStore(new Map());
}

/** Rebuilds a `BackgroundJobStore` from `serialize()`'s output, matching
 * `deserializeMemoryStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent. Populates the map directly (not
 * via `.save()`, which rejects non-"queued" records) since a serialized
 * store may legitimately contain jobs at any lifecycle stage. */
export function deserializeBackgroundJobStore(serialized: string): BackgroundJobStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized background job store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized background job store must be an array");
  }
  const jobs = new Map<string, BackgroundJob>();
  for (const entry of parsed as BackgroundJob[]) {
    const validated = createBackgroundJob(entry);
    jobs.set(validated.id, validated);
  }
  return buildStore(jobs);
}
