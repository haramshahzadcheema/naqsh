import {
  createAddEvidenceTool,
  createAddExperimentTool,
  createAddRequirementTool,
  createAddSourceTool,
  createAnalyzeRequirementCompletenessTool,
  createAnswerClarificationTool,
  createApprovalStore,
  createArtifactStore,
  createAutonomyGrantStore,
  createBackgroundJobStore,
  createBuildResultStore,
  createCancelBackgroundJobTool,
  createCandidateMetricValueStore,
  createCandidateStore,
  createChangeHistory,
  createCheckStore,
  createCheckpointStore,
  createClarificationStore,
  createCompareCandidatesTool,
  createCreateCandidateTool,
  createCreateCheckTool,
  createCreateCheckpointTool,
  createCreateEnvironmentObjectTool,
  createCreateOptimizationProblemTool,
  createDesignSpecificationStore,
  createDismissClarificationTool,
  createEvaluateObjectiveSatisfactionTool,
  createExecuteToolAuthorizer,
  createGetBackgroundJobTool,
  createJobEventStore,
  createMemoryAddTool,
  createMemoryStore,
  createModifyEnvironmentObjectTool,
  createObjectiveSatisfactionStore,
  createOptimizationProblemStore,
  createOptimizationResultStore,
  createRecordCandidateMetricValueTool,
  createResearchFetchTool,
  createResearchSearchTool,
  createRestoreCheckpointTool,
  createRunOptimizationTool,
  createRunVerificationTool,
  createSaveDesignSpecificationTool,
  createAgentLoopRunStore,
  createSubmitBackgroundJobTool,
  createToolRegistry,
  createUpdateExperimentTool,
  createVerificationResultStore,
  deserializeAgentLoopRunStore,
  deserializeApprovalStore,
  deserializeArtifactStore,
  deserializeAutonomyGrantStore,
  deserializeBackgroundJobStore,
  deserializeBuildResultStore,
  deserializeCandidateMetricValueStore,
  deserializeCandidateStore,
  deserializeChangeHistory,
  deserializeCheckStore,
  deserializeCheckpointStore,
  deserializeClarificationStore,
  deserializeDesignSpecificationStore,
  deserializeJobEventStore,
  deserializeMemoryStore,
  deserializeObjectiveSatisfactionStore,
  deserializeOptimizationProblemStore,
  deserializeOptimizationResultStore,
  deserializeVerificationResultStore,
  executeTool,
  interpretRequirementFromText,
  recordTransition,
  type AgentLoopRunStore,
  type ApprovalStore,
  type ArtifactStore,
  type AutonomyGrantStore,
  type BackgroundJobStore,
  type BuildResultStore,
  type CandidateMetricValueStore,
  type CandidateStore,
  type ChangeHistory,
  type CheckStore,
  type CheckpointStore,
  type ClarificationStore,
  type DesignSpecificationStore,
  type EnvironmentAdapter,
  type JobEventStore,
  type MemoryStore,
  type ModelProvider,
  type ObjectiveSatisfactionStore,
  type OptimizationProblemStore,
  type OptimizationResultStore,
  type ResearchProvider,
  type ToolHandler,
  type ToolRegistry,
  type VerificationResultStore
} from "@naqsh/core";
// Deliberately named imports of the two GENERIC mock adapters only --
// never the environment registry, never anything FreeCAD-specific. P12's
// boundary (packages/core/test/repo-boundaries.test.ts) forbids apps/api
// from importing anything with "freecad" in the module specifier or
// importing node:child_process at all; FreeCAD stays reachable only
// through @naqsh/adapters' own subprocess boundary, never from here.
// `createHttpResearchProvider` is the SAME kind of import: a generic,
// vendor-independent implementation of a core-defined interface (P21's
// ResearchProvider), not a specific search engine's SDK.
import { createFreeCadAdapter, createHttpResearchProvider, createMockCadEnvironment, createMockSimulationEnvironment } from "@naqsh/adapters";
import {
  createJobResult,
  createTool,
  ToolError,
  type AuthorizationDecision,
  type Clarification,
  type EnvironmentSession,
  type ModelRequestConfigInput,
  type Plan,
  type Proposal,
  type Requirement,
  type RequirementCandidate,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import { DEFAULT_ENVIRONMENT_KIND, type EnvironmentKind, type ProjectRepository, type RuntimeStateRecord, type RuntimeStateRepository } from "./db/repositories.js";
import { existsSync } from "node:fs";
import { candidateCommandPaths } from "./environmentDiscovery.js";

export type { EnvironmentKind };

export interface ActivityEvent {
  id: string;
  kind: "observed" | "reasoning" | "recommendation" | "proposal" | "verification" | "note";
  title: string;
  body: string;
  createdAt: string;
}

let activityCounter = 0;
function activityId(): string {
  activityCounter += 1;
  return `activity_${Date.now().toString(36)}_${activityCounter}`;
}

/**
 * One live runtime per project: the `WorldModelState` (persisted back to
 * `ProjectRepository` after every mutation), a real `ToolRegistry`/
 * `ApprovalStore`/`AutonomyGrantStore`/`ChangeHistory` (P1-P4, unmodified),
 * and a real activity log (Phase R) -- appended to as real actions
 * actually happen, never pre-populated demo data.
 *
 * Held IN-MEMORY per server process, same as ever -- but no longer
 * DURABLE-only-in-memory. `RuntimeStateRepository` persists a full
 * snapshot of every substore below (everything except `WorldModelState`
 * itself, which already had its own persistence path via `setState`) to
 * disk after each mutating request (see `server.ts`'s `res.on("finish")`
 * hook), and `getOrCreateProjectRuntime` hydrates from that snapshot on a
 * cold cache miss (a genuinely fresh project, OR a project whose runtime
 * was evicted by a server restart) instead of always starting empty. A
 * `BackgroundJob` still "running" or "queued" in a hydrated snapshot is
 * honestly transitioned to "failed" (see `recoverInterruptedJobs` below)
 * -- nothing actually resumes executing it, so leaving it stuck at
 * "running" forever would be a silent lie about what's actually happening.
 * The tool registry and environment session remain genuinely ephemeral
 * (rebuilt/reconnected fresh every time; a session is a live connection,
 * not data) -- persisting either would be pretending a server process
 * that no longer exists is still holding a connection open.
 */
/** One tracked engineering proposal: the real `Proposal` (P10) plus the
 * id of the real `Approval` (P4) requested for it at generation time --
 * looking either up always goes through this pair, never a bare boolean. */
export interface TrackedProposal {
  proposal: Proposal;
  approvalId: string;
}

export interface ProjectRuntime {
  projectId: string;
  getState: () => WorldModelState;
  setState: (next: WorldModelState) => void;
  registry: ToolRegistry;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  history: ChangeHistory;
  /** Real, currently-empty-for-a-fresh-project `MemoryStore` (P24) --
   * nothing in this pass writes engineering memory records yet, so
   * `GET /projects/:id/memory` honestly returns an empty list for a new
   * project rather than fabricating demo entries. */
  memory: MemoryStore;
  activity: ActivityEvent[];
  logActivity: (kind: ActivityEvent["kind"], title: string, body: string) => ActivityEvent;

  /** Part 2: the smallest safe environment-session abstraction -- every
   * project gets a real, connectable adapter (mock CAD by default; mock
   * simulation is supported but never assumed). FreeCAD is deliberately
   * NOT an option here; it stays reachable only through its own real
   * adapter/session machinery once that's wired up as a separate,
   * explicit choice -- never implicitly through this generic path. */
  environmentKind: EnvironmentKind;
  environmentAdapter: EnvironmentAdapter;
  getSession: () => EnvironmentSession | null;
  setSession: (session: EnvironmentSession | null) => void;

  /** Part 15/16/9: real P15/P16/P17 stores, one set per project, backing
   * `create_checkpoint`/`restore_checkpoint`/`create_check`/
   * `run_verification`/`evaluate_objective_satisfaction` -- registered as
   * real tools below, never called directly outside `executeTool`. */
  checkpointStore: CheckpointStore;
  artifactStore: ArtifactStore;
  checkStore: CheckStore;
  verificationResultStore: VerificationResultStore;
  objectiveSatisfactionStore: ObjectiveSatisfactionStore;
  /** P11's real, persisted audit trail for the controlled agent loop
   * (OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE -> OBSERVE) --
   * `executeProposal` (engineeringWorkflow.ts) saves one real `AgentLoopRun`
   * here per execution, built via `resumeAgentLoopRunAfterApproval`
   * (@naqsh/core), never a bespoke second execution mechanism. */
  agentLoopRuns: AgentLoopRunStore;

  /** Part 1: Plans/Proposals have no dedicated core-level store (a
   * documented P9/P10 deferral -- see proposal-tool.ts's own note) --
   * holding them here, in the application/service layer, is exactly
   * where that responsibility belongs, not a workaround. */
  plans: Map<string, Plan>;
  proposals: Map<string, TrackedProposal>;

  /** Part 22/23/25: real, per-project stores backing
   * `create_candidate`/`compare_candidates`/`create_optimization_problem`/
   * `run_optimization`/`record_candidate_metric_value`/
   * `submit_background_job`/`get_background_job`/`cancel_background_job`
   * -- registered as real tools below, and `backgroundJobStore`/
   * `jobEventStore` also passed directly to `runBackgroundJob` (the real
   * executor) by `jobsWorkflow.ts`. */
  candidateStore: CandidateStore;
  designSpecificationStore: DesignSpecificationStore;
  buildResultStore: BuildResultStore;
  optimizationProblemStore: OptimizationProblemStore;
  candidateMetricValueStore: CandidateMetricValueStore;
  optimizationResultStore: OptimizationResultStore;
  backgroundJobStore: BackgroundJobStore;
  jobEventStore: JobEventStore;

  /** Part 19: real `ClarificationStore` backing `analyze_requirement_completeness`/
   * `dismiss_clarification` (registered as real tools below) and
   * `answer_clarification` (built fresh per call in `answerClarification`
   * below, since it needs the CALLER's chosen model provider -- see that
   * function's own doc comment for why it can't be a permanently
   * registered tool like the other two). */
  clarificationStore: ClarificationStore;
}

/** Insertion order == recency: `getOrCreateProjectRuntime` re-inserts a
 * cache HIT (delete then set) so it moves to the end, making the FIRST
 * entry always the least-recently-used one -- the classic Map-as-LRU
 * trick, no extra bookkeeping structure needed. */
const runtimes = new Map<string, ProjectRuntime>();

/** Bounds how many projects' full runtimes (tool registry, every
 * `@naqsh/core` store, activity log -- real objects, not just cache keys)
 * this ONE process holds in memory at once. Without a cap, a long-running
 * server that has ever merely been ASKED ABOUT N distinct projects holds
 * all N forever, growing without bound for the life of the process --
 * fine for a handful of projects in a demo session, a genuine unbounded-
 * memory-growth bug for a server meant to serve a large, ever-changing
 * population of real projects over a long process lifetime. Safe to evict
 * past this cap ONLY because eviction is already a first-class, tested
 * scenario in this codebase: it is EXACTLY what "cold cache miss" already
 * means after a real server restart (see this function's own doc comment)
 * -- `WorldModelState` persists via `setState` on every mutation, and
 * everything else persists via `persistRuntimeState` (`server.ts`'s
 * `res.on("finish")` hook). Overridable via `setMaxCachedRuntimes` (only
 * `server.ts`, from `CreateServerOptions.maxCachedRuntimes`, calls it) so
 * a real deployment can tune it without a code change; test suites that
 * create many short-lived projects never trip it at this default. */
let maxCachedRuntimes = 500;
export function setMaxCachedRuntimes(max: number): void {
  maxCachedRuntimes = max;
}

/**
 * Frees exactly one cached runtime to make room for a new one -- called
 * only once `runtimes.size` has already reached `maxCachedRuntimes`.
 * Walks from the least-recently-used end and skips any project with a
 * background job whose status is genuinely `"running"` IN THIS PROCESS
 * right now (`jobsWorkflow.ts`'s `runBackgroundJob`, a real detached async
 * task that closes over this exact `ProjectRuntime` object): evicting that
 * one would let a LATER request for the same project rehydrate a SECOND,
 * independent `ProjectRuntime` while the first is still actively mutating
 * its own in-memory stores, silently diverging the two into two different
 * "truths" for one project. Explicitly persists the chosen victim's state
 * before dropping it -- `res.on("finish")` already does this after every
 * mutating request, but paying for one extra synchronous write here (rare:
 * only on eviction, never on the hot path) removes any doubt about
 * ordering rather than relying on that timing assumption. If every single
 * cached runtime currently has a running job, this is a no-op for this
 * call -- temporarily exceeding the cap is the honest, safe outcome, never
 * corrupting state to enforce it; the next eviction attempt retries.
 */
function evictLeastRecentlyUsedRuntime(runtimeStates: RuntimeStateRepository): void {
  for (const [candidateId, candidate] of runtimes) {
    const hasRunningJob = candidate.backgroundJobStore.listForProject(candidateId).some((job) => job.status === "running");
    if (hasRunningJob) continue;
    persistRuntimeState(candidateId, runtimeStates);
    runtimes.delete(candidateId);
    return;
  }
}

/** Global proposalId -> projectId index, so `/proposals/:proposalId/*`
 * routes (which don't carry a projectId in their URL) can find the right
 * runtime without trusting anything the client claims -- resolution goes
 * through this index and then the per-runtime `proposals` map, so a
 * fabricated or cross-project id simply isn't found, never mismatched. */
const proposalProjectIndex = new Map<string, string>();

export function indexProposal(proposalId: string, projectId: string): void {
  proposalProjectIndex.set(proposalId, projectId);
}

export function findProjectIdForProposal(proposalId: string): string | undefined {
  return proposalProjectIndex.get(proposalId);
}

/** AUDIT FIX: `createFreeCadAdapter` with no `freecadCmdPath` falls back to
 * a bare "freecadcmd" (PATH-only) lookup -- reproduced live: a real
 * install existed at a real, standard path (`C:\Program Files\FreeCAD
 * 1.1\bin\freecadcmd.exe`), `environmentDiscovery.ts`'s own discovery
 * correctly found and reported it, and the ACTUAL connect attempt still
 * failed with "command not found at 'freecadcmd'" because it never
 * consulted that same resolution. Reuses `candidateCommandPaths()` (the
 * identical env-var-then-standard-install-dir search discovery already
 * performs) and picks the first candidate that genuinely exists on disk
 * -- the bare "freecadcmd" PATH fallback is always the last candidate in
 * that list, so this never removes it as a final resort, it just stops
 * skipping the better answers that come before it. */
function resolveFreecadCmdPath(): string | undefined {
  return candidateCommandPaths().find((candidate) => !/[\\/]/.test(candidate) || existsSync(candidate));
}

function createEnvironmentAdapterFor(kind: EnvironmentKind, documentPath?: string): EnvironmentAdapter {
  if (kind === "freecad") return createFreeCadAdapter({ defaultDocumentPath: documentPath, freecadCmdPath: resolveFreecadCmdPath() });
  return kind === "mock_simulation" ? createMockSimulationEnvironment() : createMockCadEnvironment();
}

/** Lazily connects (and caches) the project's environment session --
 * called by any workflow step that needs a live session (observing
 * environment objects for a proposal, executing a modification,
 * verifying, checkpointing). Never connects eagerly at project-creation
 * time: a project that never gets past chat/requirements shouldn't pay
 * for -- or depend on -- a live session it never uses. */
export async function ensureEnvironmentSession(runtime: ProjectRuntime): Promise<EnvironmentSession> {
  const existing = runtime.getSession();
  if (existing && existing.status === "connected") return existing;
  const result = await runtime.environmentAdapter.connect();
  if (result.status !== "success" || !result.data) {
    throw new Error(`environment_unavailable: could not connect to the "${runtime.environmentKind}" environment -- ${result.error?.message ?? "unknown error"}`);
  }
  const session = result.data as EnvironmentSession;
  runtime.setSession(session);
  return session;
}

/**
 * A real tool -- registered in the same registry, executed through the
 * same `executeTool`/`authorize` boundary as every other mutation -- that
 * records an object the connected environment ACTUALLY reports as a real
 * `EngineeringObject` in the World Model, using the environment's own
 * object id as the World Model id too (one shared identifier, no mapping
 * table). This is real, existing P1/P2 machinery (`recordTransition`'s
 * `add_object` transition, unmodified) -- never a bespoke second WorldModel
 * write path.
 *
 * Why this exists: `generateProposal` (P10) requires a proposal's target
 * to be an id its originating plan step already cited in
 * `relevantObjectIds` (`proposal-semantics.ts`), and `generatePlanProposal`
 * (P9) in turn only lets a step cite ids that already exist in the
 * observation it was built from (`plan-semantics.ts`). Both checks are
 * exactly the anti-fabrication discipline P9/P10 are FOR -- neither should
 * be loosened. What was actually missing is the one thing P8's own doc
 * comment already named as deferred: reconciling what the environment
 * reports into the World Model. This tool is the smallest, real,
 * properly-authorized version of that reconciliation -- purely
 * descriptive bookkeeping (it never creates/modifies/deletes anything in
 * the environment itself), called before planning so a plan can
 * legitimately reference a real object, and a later proposal can
 * legitimately target it.
 */
function createSyncEnvironmentObjectTool(getState: () => WorldModelState, setState: (next: WorldModelState) => void, history: ChangeHistory): { tool: Tool; handler: ToolHandler } {
  const inputSchema: ToolValueSchema = {
    type: "object",
    properties: {
      id: { type: "string", description: "The environment's own object id -- reused as-is for the World Model EngineeringObject id." },
      type: { type: "string" },
      name: { type: "string" },
      properties: { type: "object", properties: {}, additionalProperties: true }
    },
    required: ["id", "type", "name"]
  };
  const outputSchema: ToolValueSchema = {
    type: "object",
    properties: { object: { type: "object", properties: {}, additionalProperties: true } },
    required: ["object"]
  };
  const tool = createTool({
    name: "sync_environment_object",
    description:
      "Records an object the connected environment actually reports as a real EngineeringObject in the World Model, using the environment's own id. Purely descriptive bookkeeping -- never creates, modifies, or deletes anything in the environment itself. Idempotent: syncing an already-synced id returns the existing record unchanged.",
    target: "world_model",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = rawInput as { id?: unknown; type?: unknown; name?: unknown; properties?: unknown };
    if (typeof input.id !== "string" || input.id.trim().length === 0) throw new ToolError("invalid_input", "id is required and must be a non-empty string");
    if (typeof input.type !== "string" || typeof input.name !== "string") throw new ToolError("invalid_input", "type and name are required strings");

    const state = getState();
    const existing = state.project.objects.find((object) => object.id === input.id);
    if (existing) return { object: existing };

    const { state: nextState } = recordTransition(
      history,
      state,
      { kind: "add_object", object: { id: input.id, type: input.type, name: input.name, description: "", properties: (input.properties as Record<string, unknown>) ?? {}, relationships: [], metadata: { syncedFromEnvironment: true } } },
      { source: "agent", cause: { kind: "system", description: `Synced environment object "${input.id}" into the World Model.` } }
    );
    setState(nextState);
    const added = nextState.project.objects.find((object) => object.id === input.id);
    if (!added) throw new ToolError("execution_failure", "object unexpectedly missing after being synced");
    return { object: added };
  };

  return { tool, handler };
}

/** Pre-authorizes `add_requirement`, `sync_environment_object`,
 * `add_source`, `add_evidence`, and `memory_add` -- all five are low-risk,
 * non-destructive BOOKKEEPING (recording what the user already said, what
 * the environment already contains, what research already found, or what
 * was already decided/learned elsewhere); none of them touch the live
 * engineering environment or overwrite anything. Pre-authorized so
 * ordinary conversation/planning/research doesn't require a per-call
 * approval click. Anything that would modify the engineering environment
 * itself (`modify_environment_object`, `restore_checkpoint`) is
 * deliberately NOT granted here -- those remain gated behind real human
 * `Approval` records, per Phase L. */
function grantChatRequirementCaptureAutonomy(autonomyGrants: AutonomyGrantStore): void {
  autonomyGrants.create({
    toolNames: [
      "add_requirement",
      "sync_environment_object",
      "add_source",
      "add_evidence",
      "memory_add",
      "save_design_specification",
      "create_candidate",
      "analyze_requirement_completeness",
      "answer_clarification",
      "dismiss_clarification"
    ],
    targetType: null,
    targetId: null,
    reason:
      "Chat-driven requirement capture, environment-object bookkeeping, research citation recording, memory recording, generating/recording conceptual design alternatives, and requirement-completeness analysis/clarification handling all record what already exists/was already found/decided/conceived/asked as structured project state -- none of them modify the engineering environment or execute anything. Pre-authorized so ordinary conversation/planning/research/exploration/clarification doesn't require a per-call approval click; EXECUTING a proposal that would actually modify the environment still requires a real human Approval, unaffected by this grant.",
    grantedBy: "human",
    expiresAt: null,
    maxUses: null,
    metadata: {}
  });
}

/** Hydrates from `serialized` when present, falling back to a fresh empty
 * store when there's nothing to hydrate from OR the persisted bytes are
 * corrupt/unreadable -- a damaged runtime-state snapshot degrades that ONE
 * project back to "acts like a fresh project" rather than making the
 * project (or the whole server) fail to start. Every corruption is logged
 * loudly (never silently swallowed) so it's diagnosable. */
function hydrateOrCreate<T>(projectId: string, label: string, serialized: string | undefined, deserialize: (s: string) => T, create: () => T): T {
  if (!serialized) return create();
  try {
    return deserialize(serialized);
  } catch (error) {
    console.error(`[runtime-state] project "${projectId}": failed to restore ${label} from its persisted snapshot -- starting empty. ${error instanceof Error ? error.message : String(error)}`);
    return create();
  }
}

function parseJsonArray<T>(projectId: string, label: string, serialized: string | undefined): T[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error) {
    console.error(`[runtime-state] project "${projectId}": failed to parse persisted ${label} -- starting empty. ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** A `BackgroundJob` frozen at "queued"/"running" in a persisted snapshot
 * has nothing actually executing it anymore -- the in-process async task
 * that was running it (`runBackgroundJob`, jobsWorkflow.ts) died with the
 * previous server process. Silently leaving it "running" forever would be
 * exactly the kind of mysterious, undiagnosable hang this application's
 * own principles rule out; transitioning it to "failed" with an honest
 * reason is a real recovery action, not a cosmetic one. */
function recoverInterruptedJobs(projectId: string, store: BackgroundJobStore, activity: ActivityEvent[]): void {
  for (const job of store.listForProject(projectId)) {
    if (job.status !== "queued" && job.status !== "running") continue;
    // Both "failed" and "cancelled" are TERMINAL statuses -- `createBackgroundJob`
    // requires a non-null `result` whenever status is terminal, exactly the
    // same "cannot construct a terminal job with no result" discipline
    // `createBackgroundJob`'s own factory doc comment describes. A job that
    // was still "queued" never actually started, so "cancelled" (a legal
    // "queued" -> "cancelled" transition) is the honest status; a job
    // already "running" genuinely failed to finish, so "failed" (a legal
    // "running" -> "failed" transition) is.
    const to = job.status === "queued" ? "cancelled" : "failed";
    const reasonText = "Interrupted by a server restart before this job could finish.";
    const result = createJobResult({ stopReason: "failed", candidateResults: [], summary: reasonText });
    const recovered = store.transition(job.id, to, { result, failureReason: to === "failed" ? reasonText : null });
    activity.push({ id: activityId(), kind: "note", title: "Job interrupted", body: `"${recovered.objective}" was still ${job.status} when the server restarted and could not resume -- marked ${to}.`, createdAt: new Date().toISOString() });
  }
}

export function getOrCreateProjectRuntime(
  projectId: string,
  projects: ProjectRepository,
  environmentKind: EnvironmentKind = DEFAULT_ENVIRONMENT_KIND,
  runtimeStates?: RuntimeStateRepository
): ProjectRuntime {
  const existing = runtimes.get(projectId);
  if (existing) {
    // Cache hit -- move to the most-recently-used end (see `runtimes`'s
    // own doc comment for why re-inserting is enough).
    runtimes.delete(projectId);
    runtimes.set(projectId, existing);
    return existing;
  }

  const record = projects.get(projectId);
  if (!record) {
    throw new Error(`No project with id "${projectId}"`);
  }

  const snapshot: RuntimeStateRecord | null = runtimeStates?.get(projectId) ?? null;

  let state = record.worldModelState;
  const history = hydrateOrCreate(projectId, "change history", snapshot?.history, deserializeChangeHistory, createChangeHistory);
  const registry = createToolRegistry();
  const approvals = hydrateOrCreate(projectId, "approvals", snapshot?.approvals, deserializeApprovalStore, createApprovalStore);
  const autonomyGrants = hydrateOrCreate(projectId, "autonomy grants", snapshot?.autonomyGrants, deserializeAutonomyGrantStore, createAutonomyGrantStore);
  const memory = hydrateOrCreate(projectId, "memory", snapshot?.memory, deserializeMemoryStore, createMemoryStore);
  const activity: ActivityEvent[] = parseJsonArray<ActivityEvent>(projectId, "activity log", snapshot?.activity);

  const checkpointStore = hydrateOrCreate(projectId, "checkpoints", snapshot?.checkpoints, deserializeCheckpointStore, createCheckpointStore);
  const artifactStore = hydrateOrCreate(projectId, "artifacts", snapshot?.artifacts, deserializeArtifactStore, createArtifactStore);
  const checkStore = hydrateOrCreate(projectId, "checks", snapshot?.checks, deserializeCheckStore, createCheckStore);
  const verificationResultStore = hydrateOrCreate(projectId, "verification results", snapshot?.verificationResults, deserializeVerificationResultStore, createVerificationResultStore);
  const objectiveSatisfactionStore = hydrateOrCreate(projectId, "objective satisfaction", snapshot?.objectiveSatisfactions, deserializeObjectiveSatisfactionStore, createObjectiveSatisfactionStore);
  const agentLoopRuns = hydrateOrCreate(projectId, "agent loop runs", snapshot?.agentLoopRuns, deserializeAgentLoopRunStore, createAgentLoopRunStore);
  const clarificationStore = hydrateOrCreate(projectId, "clarifications", snapshot?.clarifications, deserializeClarificationStore, createClarificationStore);
  const environmentAdapter = createEnvironmentAdapterFor(environmentKind, record.documentPath);

  const plans = new Map<string, Plan>();
  for (const plan of parseJsonArray<Plan>(projectId, "plans", snapshot?.plans)) plans.set(plan.id, plan);

  const proposals = new Map<string, TrackedProposal>();
  for (const entry of parseJsonArray<{ id: string; proposal: Proposal; approvalId: string }>(projectId, "proposals", snapshot?.proposals)) {
    proposals.set(entry.id, { proposal: entry.proposal, approvalId: entry.approvalId });
    // Every hydrated proposal needs its cross-project lookup entry back --
    // normally set by `indexProposal` at generation time (engineeringWorkflow.ts),
    // which never runs again for a proposal that already existed before
    // this restart. Without this, `/proposals/:proposalId/*` routes would
    // 404 for every proposal that predates the current server process.
    proposalProjectIndex.set(entry.id, projectId);
  }

  const candidateStore = hydrateOrCreate(projectId, "candidates", snapshot?.candidates, deserializeCandidateStore, createCandidateStore);
  const designSpecificationStore = hydrateOrCreate(projectId, "design specifications", snapshot?.designSpecifications, deserializeDesignSpecificationStore, createDesignSpecificationStore);
  const buildResultStore = hydrateOrCreate(projectId, "build results", snapshot?.buildResults, deserializeBuildResultStore, createBuildResultStore);
  const optimizationProblemStore = hydrateOrCreate(projectId, "optimization problems", snapshot?.optimizationProblems, deserializeOptimizationProblemStore, createOptimizationProblemStore);
  const candidateMetricValueStore = hydrateOrCreate(projectId, "candidate metric values", snapshot?.candidateMetricValues, deserializeCandidateMetricValueStore, createCandidateMetricValueStore);
  const optimizationResultStore = hydrateOrCreate(projectId, "optimization results", snapshot?.optimizationResults, deserializeOptimizationResultStore, createOptimizationResultStore);
  const backgroundJobStore = hydrateOrCreate(projectId, "background jobs", snapshot?.backgroundJobs, deserializeBackgroundJobStore, createBackgroundJobStore);
  const jobEventStore = hydrateOrCreate(projectId, "job events", snapshot?.jobEvents, deserializeJobEventStore, createJobEventStore);
  if (snapshot) recoverInterruptedJobs(projectId, backgroundJobStore, activity);

  const getState = (): WorldModelState => state;
  const setState = (next: WorldModelState): void => {
    state = next;
    projects.save({ ...record, worldModelState: next, updatedAt: new Date().toISOString() });
  };

  let environmentSession: EnvironmentSession | null = null;
  const getSession = (): EnvironmentSession | null => environmentSession;
  const setSession = (next: EnvironmentSession | null): void => {
    environmentSession = next;
  };

  // ---- Register every tool this runtime's workflow needs. One registry,
  // matching beginAgentLoopRun's (P11) own precedent -- generateProposal
  // shows the model every registered tool's name/description/schema so it
  // can pick the one that actually realizes a given plan step.
  const addRequirementTool = createAddRequirementTool(getState, setState, history);
  registry.register(addRequirementTool.tool, addRequirementTool.handler);

  const analyzeRequirementCompletenessTool = createAnalyzeRequirementCompletenessTool(getState, clarificationStore);
  registry.register(analyzeRequirementCompletenessTool.tool, analyzeRequirementCompletenessTool.handler);

  const dismissClarificationTool = createDismissClarificationTool(clarificationStore);
  registry.register(dismissClarificationTool.tool, dismissClarificationTool.handler);
  // `answer_clarification` is deliberately NOT registered here -- it needs
  // the CALLER's chosen model provider (re-interpretation is a real Gemini
  // call), which varies per HTTP request, unlike every tool above (fixed
  // for this runtime's whole lifetime). See `answerClarification` below.

  const syncEnvironmentObjectTool = createSyncEnvironmentObjectTool(getState, setState, history);
  registry.register(syncEnvironmentObjectTool.tool, syncEnvironmentObjectTool.handler);
  // Only for a genuinely fresh project -- a hydrated `autonomyGrants`
  // already contains this exact grant from when the project was first
  // created (`AutonomyGrantStore` has no "does an equivalent grant already
  // exist" query, so re-granting on every restart would silently pile up
  // a duplicate active grant per restart otherwise).
  if (!snapshot) grantChatRequirementCaptureAutonomy(autonomyGrants);

  const modifyEnvironmentObjectTool = createModifyEnvironmentObjectTool(getSession, environmentAdapter);
  registry.register(modifyEnvironmentObjectTool.tool, modifyEnvironmentObjectTool.handler);

  // AUDIT FIX: this was never registered here even though P20's
  // build-executor.ts (planBuildOperations) targets it by name for every
  // ExpectedBuildOutput with targetObjectId === null -- the default, and
  // most common, shape (see design-specification-types.ts's own doc
  // comment: "the original, and still default, shape"). Without this, EVERY
  // DesignSpecification/Candidate build that creates a new object (rather
  // than modifying an existing one) failed with "unknown_tool" the moment
  // it reached executeBuildForDesignSpecification -- silently defeating
  // the entire P20/P22/P25 build pipeline for its default case.
  const createEnvironmentObjectTool = createCreateEnvironmentObjectTool(getSession, environmentAdapter);
  registry.register(createEnvironmentObjectTool.tool, createEnvironmentObjectTool.handler);

  const createCheckpointToolPair = createCreateCheckpointTool(getState, history, getSession, environmentAdapter, checkpointStore, artifactStore);
  registry.register(createCheckpointToolPair.tool, createCheckpointToolPair.handler);

  const restoreCheckpointTool = createRestoreCheckpointTool(getState, setState, history, getSession, environmentAdapter, checkpointStore, artifactStore);
  registry.register(restoreCheckpointTool.tool, restoreCheckpointTool.handler);

  const createCheckToolPair = createCreateCheckTool(checkStore, getState);
  registry.register(createCheckToolPair.tool, createCheckToolPair.handler);

  const runVerificationTool = createRunVerificationTool(getState, getSession, environmentAdapter, checkStore, verificationResultStore);
  registry.register(runVerificationTool.tool, runVerificationTool.handler);

  const evaluateObjectiveSatisfactionTool = createEvaluateObjectiveSatisfactionTool(getState, verificationResultStore, objectiveSatisfactionStore);
  registry.register(evaluateObjectiveSatisfactionTool.tool, evaluateObjectiveSatisfactionTool.handler);

  // ---- Part J/K: research (P21) and memory (P24), for real -- a single
  // real HttpResearchProvider per project (real, SSRF-guarded fetch of a
  // specific locator; honestly "unavailable" for open-web search -- see
  // http-research-provider.ts's own doc comment), plus the tools that turn
  // an accepted candidate/fetch into real, audited project knowledge.
  const researchProvider: ResearchProvider = createHttpResearchProvider();

  const researchSearchTool = createResearchSearchTool(researchProvider);
  registry.register(researchSearchTool.tool, researchSearchTool.handler);

  const researchFetchTool = createResearchFetchTool(researchProvider);
  registry.register(researchFetchTool.tool, researchFetchTool.handler);

  const addSourceTool = createAddSourceTool(getState, setState, history);
  registry.register(addSourceTool.tool, addSourceTool.handler);

  const addEvidenceTool = createAddEvidenceTool(getState, setState, history);
  registry.register(addEvidenceTool.tool, addEvidenceTool.handler);

  const memoryAddTool = createMemoryAddTool(memory, getState, { checkpointStore, verificationResultStore, candidateStore, optimizationResultStore });
  registry.register(memoryAddTool.tool, memoryAddTool.handler);

  // ---- Part L: experiments/optimization/background jobs (P22/23/25) --
  // real stores, real tools, all reachable via executeTool for the first
  // time (the audit found zero of these registered anywhere). Full
  // candidate GENERATION from a natural-language request ("try five
  // variations") is NOT wired this pass -- that depends on a
  // design-specification-generation pipeline this phase doesn't add (see
  // the final report's "remaining limitations"); what IS real here is the
  // entire downstream chain once real Candidate ids exist: define ->
  // submit -> run (a genuine async execution, not merely a stored intent)
  // -> compare -> optimize.
  const createCandidateToolPair = createCreateCandidateTool(candidateStore, getState, designSpecificationStore);
  registry.register(createCandidateToolPair.tool, createCandidateToolPair.handler);

  const saveDesignSpecificationToolPair = createSaveDesignSpecificationTool(designSpecificationStore);
  registry.register(saveDesignSpecificationToolPair.tool, saveDesignSpecificationToolPair.handler);

  const addExperimentTool = createAddExperimentTool(getState, setState, history);
  registry.register(addExperimentTool.tool, addExperimentTool.handler);

  const updateExperimentTool = createUpdateExperimentTool(getState, setState, history);
  registry.register(updateExperimentTool.tool, updateExperimentTool.handler);

  const compareCandidatesTool = createCompareCandidatesTool(candidateStore, getState, verificationResultStore);
  registry.register(compareCandidatesTool.tool, compareCandidatesTool.handler);

  const createOptimizationProblemToolPair = createCreateOptimizationProblemTool(candidateStore, optimizationProblemStore, getState);
  registry.register(createOptimizationProblemToolPair.tool, createOptimizationProblemToolPair.handler);

  const recordCandidateMetricValueTool = createRecordCandidateMetricValueTool(candidateStore, verificationResultStore, getState, candidateMetricValueStore);
  registry.register(recordCandidateMetricValueTool.tool, recordCandidateMetricValueTool.handler);

  const runOptimizationTool = createRunOptimizationTool(optimizationProblemStore, candidateMetricValueStore, optimizationResultStore);
  registry.register(runOptimizationTool.tool, runOptimizationTool.handler);

  // A background job can never carry more authority than the session that
  // submits it -- "approved_modify" is this app's own general ceiling
  // (matching engineeringWorkflow.ts's `authorizerFor`); a job can never
  // request "autonomous".
  const submitBackgroundJobTool = createSubmitBackgroundJobTool(candidateStore, backgroundJobStore, jobEventStore, getState, "approved_modify");
  registry.register(submitBackgroundJobTool.tool, submitBackgroundJobTool.handler);

  const getBackgroundJobTool = createGetBackgroundJobTool(backgroundJobStore, jobEventStore, getState);
  registry.register(getBackgroundJobTool.tool, getBackgroundJobTool.handler);

  const cancelBackgroundJobTool = createCancelBackgroundJobTool(backgroundJobStore, jobEventStore, getState);
  registry.register(cancelBackgroundJobTool.tool, cancelBackgroundJobTool.handler);

  const runtime: ProjectRuntime = {
    projectId,
    getState,
    setState,
    registry,
    approvals,
    autonomyGrants,
    history,
    memory,
    activity,
    logActivity(kind, title, body) {
      const event: ActivityEvent = { id: activityId(), kind, title, body, createdAt: new Date().toISOString() };
      activity.push(event);
      return event;
    },
    environmentKind,
    environmentAdapter,
    getSession,
    setSession,
    checkpointStore,
    artifactStore,
    checkStore,
    verificationResultStore,
    objectiveSatisfactionStore,
    agentLoopRuns,
    plans,
    proposals,
    candidateStore,
    designSpecificationStore,
    buildResultStore,
    optimizationProblemStore,
    candidateMetricValueStore,
    optimizationResultStore,
    backgroundJobStore,
    jobEventStore,
    clarificationStore
  };
  if (runtimeStates && runtimes.size >= maxCachedRuntimes) {
    evictLeastRecentlyUsedRuntime(runtimeStates);
  }
  runtimes.set(projectId, runtime);
  return runtime;
}

/** Removes a project's live runtime (e.g. after the project itself is
 * deleted) so a later re-creation under the same id starts clean. */
export function discardProjectRuntime(projectId: string): void {
  runtimes.delete(projectId);
}

/** Test-only introspection into the LRU cache's actual contents -- lets a
 * test prove eviction genuinely happened (a specific project's id is no
 * longer cached) rather than only observing that rehydration still works
 * (which would pass whether or not eviction ever actually ran). Not used
 * by any request-handling code path. */
export function isProjectRuntimeCached(projectId: string): boolean {
  return runtimes.has(projectId);
}

/**
 * Snapshots everything a live `ProjectRuntime` holds beyond
 * `WorldModelState` (which already persists via `setState`) and writes it
 * to `runtimeStates`. Called from `server.ts`'s `res.on("finish")` hook
 * after any request that could have mutated a project's runtime -- see
 * that file's own doc comment for exactly which requests trigger it.
 *
 * A no-op when no runtime is currently cached for `projectId` (nothing to
 * snapshot -- e.g. a GET-only request for a project whose runtime was
 * never instantiated this process, or a project that was just deleted).
 */
export function persistRuntimeState(projectId: string, runtimeStates: RuntimeStateRepository): void {
  const runtime = runtimes.get(projectId);
  if (!runtime) return;

  const record: RuntimeStateRecord = {
    id: projectId,
    history: runtime.history.serialize(),
    approvals: runtime.approvals.serialize(),
    autonomyGrants: runtime.autonomyGrants.serialize(),
    checkpoints: runtime.checkpointStore.serialize(),
    artifacts: runtime.artifactStore.serialize(),
    checks: runtime.checkStore.serialize(),
    verificationResults: runtime.verificationResultStore.serialize(),
    objectiveSatisfactions: runtime.objectiveSatisfactionStore.serialize(),
    agentLoopRuns: runtime.agentLoopRuns.serialize(),
    memory: runtime.memory.serialize(),
    activity: JSON.stringify(runtime.activity),
    plans: JSON.stringify(Array.from(runtime.plans.values())),
    proposals: JSON.stringify(Array.from(runtime.proposals.entries()).map(([id, tracked]) => ({ id, ...tracked }))),
    candidates: runtime.candidateStore.serialize(),
    designSpecifications: runtime.designSpecificationStore.serialize(),
    buildResults: runtime.buildResultStore.serialize(),
    optimizationProblems: runtime.optimizationProblemStore.serialize(),
    candidateMetricValues: runtime.candidateMetricValueStore.serialize(),
    optimizationResults: runtime.optimizationResultStore.serialize(),
    backgroundJobs: runtime.backgroundJobStore.serialize(),
    jobEvents: runtime.jobEventStore.serialize(),
    clarifications: runtime.clarificationStore.serialize(),
    updatedAt: new Date().toISOString()
  };
  runtimeStates.save(record);
}

export type RequirementCaptureOutcome =
  | { kind: "requirement_added"; requirement: Requirement }
  | { kind: "clarification_needed"; clarifications: Clarification[] }
  | { kind: "interpretation_failed"; message: string }
  | { kind: "execution_denied"; reason: string };

function autonomousRuntimeAuthorizer(runtime: ProjectRuntime, onDecision?: (decision: AuthorizationDecision) => void) {
  return createExecuteToolAuthorizer({
    autonomyLevel: "autonomous",
    approvals: runtime.approvals,
    autonomyGrants: runtime.autonomyGrants,
    onDecision
  });
}

/**
 * Shared by `captureRequirementFromStatement` (a fresh statement) and
 * `answerClarification` (a re-interpreted candidate after a clarification
 * answer) -- both need the SAME decision after a candidate exists: run P19
 * completeness analysis (deterministic, real `Clarification` records
 * persisted via `ClarificationStore` -- never a transient in-memory
 * signal), and only call `add_requirement` when nothing needs asking.
 */
async function resolveRequirementCandidate(runtime: ProjectRuntime, candidate: RequirementCandidate): Promise<RequirementCaptureOutcome> {
  const analyzed = await executeTool(runtime.registry, {
    toolName: "analyze_requirement_completeness",
    input: { candidate },
    source: "agent",
    target: null,
    authorize: autonomousRuntimeAuthorizer(runtime)
  });

  if (analyzed.result.status === "error") {
    const error = analyzed.result.error ?? { kind: "execution_failure", message: "Completeness analysis failed with no error detail." };
    runtime.logActivity("note", "Could not analyze requirement completeness", error.message);
    return { kind: "interpretation_failed", message: error.message };
  }

  const { needsClarification, clarifications } = analyzed.result.output as { needsClarification: boolean; clarifications: Clarification[] };
  if (needsClarification) {
    runtime.logActivity("reasoning", "Needs clarification", clarifications.map((c) => c.question).join(" "));
    return { kind: "clarification_needed", clarifications };
  }

  runtime.logActivity("reasoning", "Interpreted", `${candidate.description}${candidate.value !== null ? ` (${String(candidate.value)}${candidate.unit ? ` ${candidate.unit}` : ""})` : ""}`);

  let decision: AuthorizationDecision | undefined;
  const executed = await executeTool(runtime.registry, {
    toolName: "add_requirement",
    input: { candidate },
    source: "agent",
    target: null,
    authorize: autonomousRuntimeAuthorizer(runtime, (d) => {
      decision = d;
    })
  });

  if (executed.result.status === "error") {
    const error = executed.result.error ?? { kind: "execution_failure", message: "Tool execution failed with no error detail." };
    if (error.kind === "policy_rejected") {
      runtime.logActivity("note", "Not authorized", error.message);
      return { kind: "execution_denied", reason: error.message };
    }
    runtime.logActivity("note", "Could not record requirement", error.message);
    return { kind: "interpretation_failed", message: error.message };
  }

  if (decision?.matchedAutonomyGrantId) {
    runtime.autonomyGrants.recordUse(decision.matchedAutonomyGrantId);
  }

  const requirement = executed.result.output as Requirement;
  runtime.logActivity("recommendation", "Requirement recorded", requirement.description);
  return { kind: "requirement_added", requirement };
}

/**
 * The real Phase J flow: free text -> Gemini (`interpretUserRequirement`,
 * P18) -> a validated `RequirementCandidate` -> P19 completeness analysis
 * -> (if nothing needs asking) the real `add_requirement` tool, through the
 * SAME `executeTool`/`authorize` boundary (P3/P4) every other World Model
 * mutation goes through. The model never touches `WorldModelState`
 * directly -- it only ever produces a candidate; this function
 * (deterministic code) decides whether that candidate becomes real project
 * state.
 */
export async function captureRequirementFromStatement(
  runtime: ProjectRuntime,
  provider: ModelProvider,
  statementText: string,
  modelConfig: ModelRequestConfigInput
): Promise<RequirementCaptureOutcome> {
  runtime.logActivity("observed", "Observing", `Reading: "${statementText}"`);

  const interpretation = await interpretRequirementFromText(provider, runtime.getState(), statementText, { config: modelConfig });

  if (interpretation.status === "error") {
    runtime.logActivity("note", "Interpretation failed", interpretation.error.message);
    return { kind: "interpretation_failed", message: interpretation.error.message };
  }

  return resolveRequirementCandidate(runtime, interpretation.candidate);
}

export type AnswerClarificationOutcome = { kind: "answered"; clarification: Clarification; outcome: RequirementCaptureOutcome } | { kind: "answer_rejected"; message: string };

/**
 * Phase 19's ANSWER half, wired into a live `ProjectRuntime`. Unlike every
 * other tool this runtime registers once at construction time,
 * `answer_clarification` needs the CALLER's chosen model provider (it
 * re-interprets the clarification's question + the user's answer via a
 * real Gemini call, P18's unchanged pipeline) -- and the model a request
 * picks can vary call to call. Building a fresh one-tool `ToolRegistry` per
 * call is cheap (no I/O, just closures) and keeps this on the exact same
 * `executeTool`/`authorize` boundary as everything else, using the SAME
 * `runtime.approvals`/`runtime.autonomyGrants` (pre-authorized via
 * `grantChatRequirementCaptureAutonomy`) so answering a clarification
 * doesn't require a per-call approval click, matching ordinary requirement
 * capture.
 */
export async function answerClarification(runtime: ProjectRuntime, provider: ModelProvider, clarificationId: string, answerText: string, modelId: string): Promise<AnswerClarificationOutcome> {
  const throwawayRegistry = createToolRegistry();
  const answerTool = createAnswerClarificationTool(runtime.getState, provider, runtime.clarificationStore);
  throwawayRegistry.register(answerTool.tool, answerTool.handler);

  const executed = await executeTool(throwawayRegistry, {
    toolName: "answer_clarification",
    input: { clarificationId, answerText, modelId },
    source: "human",
    target: null,
    authorize: autonomousRuntimeAuthorizer(runtime)
  });

  if (executed.result.status === "error") {
    const error = executed.result.error ?? { kind: "execution_failure", message: "Answering the clarification failed with no error detail." };
    runtime.logActivity("note", "Could not answer clarification", error.message);
    return { kind: "answer_rejected", message: error.message };
  }

  const { clarification, updatedCandidate } = executed.result.output as { clarification: Clarification; updatedCandidate: RequirementCandidate };
  runtime.logActivity("observed", "Clarification answered", `"${clarification.question}" -> "${answerText}"`);
  const outcome = await resolveRequirementCandidate(runtime, updatedCandidate);
  return { kind: "answered", clarification, outcome };
}

/** Phase 19's DISMISS half, wired into a live `ProjectRuntime` -- trivial
 * by design (no model call, `dismiss_clarification` is a permanently
 * registered tool like `analyze_requirement_completeness`). */
export async function dismissClarification(runtime: ProjectRuntime, clarificationId: string, reason?: string): Promise<{ status: "success"; clarification: Clarification } | { status: "error"; message: string }> {
  const executed = await executeTool(runtime.registry, {
    toolName: "dismiss_clarification",
    input: { clarificationId, reason },
    source: "human",
    target: null,
    authorize: autonomousRuntimeAuthorizer(runtime)
  });

  if (executed.result.status === "error") {
    const error = executed.result.error ?? { kind: "execution_failure", message: "Dismissing the clarification failed with no error detail." };
    return { status: "error", message: error.message };
  }

  const { clarification } = executed.result.output as { clarification: Clarification };
  runtime.logActivity("note", "Clarification dismissed", clarification.question);
  return { status: "success", clarification };
}
