import type { WorldModelState } from "@naqsh/schemas";
import { JsonCollectionStore } from "./jsonStore.js";
import { LOCAL_DEV_USER_ID } from "../auth.js";

/** Every environment kind a project can genuinely be connected to in this
 * deployment -- the complete, real value space `projectRuntime.ts`'s
 * `createEnvironmentAdapterFor` actually switches on. A real FreeCAD
 * adapter exists in `@naqsh/adapters` but is deliberately not one of
 * these: nothing in this pass drives a live FreeCAD session from the
 * server (see that adapter's own doc comment), so offering it here would
 * be a selectable control that silently does nothing -- exactly what this
 * application's own principles rule out. Defined here (not
 * `projectRuntime.ts`) because it's fundamentally a property of the
 * PROJECT RECORD now (chosen once at creation, persisted, never
 * silently reset to a default on every server restart the way it
 * effectively was before `ProjectRecord.environmentKind` existed). */
/** "freecad" is a REAL, selectable kind -- but selectable does not mean
 * always available. Unlike the two mock kinds (always constructible,
 * always connectable, no external dependency), a project can only
 * actually be CREATED with `environmentKind: "freecad"` once
 * `environmentDiscovery.ts`'s real, bounded health check has confirmed an
 * actual FreeCAD installation answers (see `POST /projects` in
 * server.ts) -- this type only says "a real adapter exists for this
 * kind," never "this machine has it right now." */
export type EnvironmentKind = "mock_cad" | "mock_simulation" | "freecad";
export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = ["mock_cad", "mock_simulation", "freecad"];
export const DEFAULT_ENVIRONMENT_KIND: EnvironmentKind = "mock_cad";

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Which identity (`AuthContext.userId`, see auth.ts) owns this project
   * -- the real, structural basis for project isolation (Part 30's "strict
   * project isolation" requirement). Optional on the wire/at-rest shape
   * (older on-disk records predate this field); `createProjectRepository`
   * below backfills it to `LOCAL_DEV_USER_ID` on read so every in-memory
   * `ProjectRecord` a caller ever sees always has a real `ownerId`. */
  ownerId?: string;
  /** Chosen once, at project-creation time (`POST /projects`), and never
   * changed afterward -- swapping a project's connected environment kind
   * mid-project would invalidate every checkpoint/environment-synced
   * object already recorded against the old one, which no route
   * currently supports doing safely. Optional on the wire/at-rest shape
   * for the same reason `ownerId` is (older on-disk records predate this
   * field); backfilled to `DEFAULT_ENVIRONMENT_KIND` on read. */
  environmentKind?: EnvironmentKind;
  /** The absolute path, ON THE SAME MACHINE apps/api runs on, to the real
   * FreeCAD document (.FCStd) this project connects to -- ONLY meaningful
   * when `environmentKind === "freecad"`; `undefined` for every mock-
   * backed project. Required at creation time for a FreeCAD project (see
   * `POST /projects`): the adapter's `connect()` has no document to open
   * without it, and there is no "current file" concept a subprocess-per-
   * call adapter could otherwise infer. Chosen once, same immutability
   * reasoning as `environmentKind` itself. */
  documentPath?: string;
  /** The ENTIRE engineering state for this project -- requirements,
   * constraints, proposals, checks, verification results, experiments,
   * memory, everything. This is a real `@naqsh/schemas` `WorldModelState`,
   * the same type every P0-P26 core function already operates on -- never
   * a parallel/simplified shape invented for HTTP transport. */
  worldModelState: WorldModelState;
}

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  fileIds?: string[];
  /** Set only on error responses -- an honest failure marker, never a
   * silently-empty assistant message standing in for one. */
  error?: { kind: string; message: string };
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type FileExtractionStatus = "success" | "failed" | "unsupported";

export interface FileRecord {
  id: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  extractionStatus: FileExtractionStatus;
  extractedText: string | null;
  extractionError: string | null;
  /** Relative path under the API's data directory where the original
   * bytes are stored -- never the extracted text itself, so a caller can
   * always re-derive/re-serve the original file. */
  storedAt: string;
}

export interface Repository<T extends { id: string }> {
  get(id: string): T | null;
  list(): T[];
  save(record: T): T;
  delete(id: string): boolean;
}

export interface ProjectRepository extends Repository<ProjectRecord> {
  /** Every project owned by `ownerId` -- backed by an in-memory secondary
   * index (see `JsonCollectionStore`'s own doc comment), so this costs
   * O(this owner's own project count), never O(every project this server
   * has ever stored across every user). */
  listByOwner(ownerId: string): ProjectRecord[];
}
export interface ConversationRepository extends Repository<ConversationRecord> {
  listForProject(projectId: string): ConversationRecord[];
}
export interface MessageRepository extends Repository<MessageRecord> {
  listForConversation(conversationId: string): MessageRecord[];
}
export interface FileRepository extends Repository<FileRecord> {
  listForProject(projectId: string): FileRecord[];
}

/**
 * One record per project, `id` === the project's own id -- everything a
 * live `ProjectRuntime` (projectRuntime.ts) holds that ISN'T already part
 * of `ProjectRecord.worldModelState` (which persists through `save()`/
 * `setState` on every mutation already): plans, proposals, approvals,
 * autonomy grants, the change-history audit trail, checkpoints,
 * checkpoint artifact blobs, checks, verification results, objective-
 * satisfaction evaluations, memory records, the activity log, and the
 * experiment/optimization/background-job stores. Every field is the
 * literal `serialize()` output of the matching `@naqsh/core` store (see
 * that package's `deserializeXStore` counterparts) -- this repository
 * never re-interprets the bytes, only stores and returns them, exactly
 * like `ProjectRecord.worldModelState` already does for the World Model.
 *
 * Before this record existed, everything it now holds lived ONLY in the
 * `runtimes` in-memory Map (projectRuntime.ts) -- durable across a browser
 * refresh, but silently lost on every server restart. That gap is real:
 * pending proposals, approval history, checkpoints (the rollback safety
 * net Part 15 exists for), verification results, and recorded memory are
 * all product-critical, user-visible state, not disposable cache.
 */
export interface RuntimeStateRecord {
  id: string;
  history: string;
  approvals: string;
  autonomyGrants: string;
  checkpoints: string;
  artifacts: string;
  checks: string;
  verificationResults: string;
  objectiveSatisfactions: string;
  agentLoopRuns: string;
  memory: string;
  /** Plain JSON (`ActivityEvent[]`) -- no `@naqsh/core` store backs the
   * activity log; `projectRuntime.ts` owns it directly as a plain array. */
  activity: string;
  /** Plain JSON (`Plan[]`) -- Plans have no dedicated core-level store
   * (a documented P9/P10 deferral); `projectRuntime.ts` holds them
   * directly as a `Map<string, Plan>`. */
  plans: string;
  /** Plain JSON (`Array<{ id: string; proposal: Proposal; approvalId:
   * string }>`) -- same deferral as `plans`, held as `Map<string,
   * TrackedProposal>`. */
  proposals: string;
  candidates: string;
  designSpecifications: string;
  buildResults: string;
  optimizationProblems: string;
  candidateMetricValues: string;
  optimizationResults: string;
  backgroundJobs: string;
  jobEvents: string;
  clarifications: string;
  updatedAt: string;
}

export interface RuntimeStateRepository extends Repository<RuntimeStateRecord> {}

export function createRuntimeStateRepository(dataDir: string): RuntimeStateRepository {
  const store = new JsonCollectionStore<RuntimeStateRecord>(dataDir, "runtime-state");
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (record) => store.save(record),
    delete: (id) => store.delete(id)
  };
}

function withDefaults(record: ProjectRecord): ProjectRecord {
  const ownerId = record.ownerId ?? LOCAL_DEV_USER_ID;
  const environmentKind = record.environmentKind ?? DEFAULT_ENVIRONMENT_KIND;
  return record.ownerId && record.environmentKind ? record : { ...record, ownerId, environmentKind };
}

export function createProjectRepository(dataDir: string): ProjectRepository {
  // Indexed by the SAME backfill `withDefaults` applies on read -- an
  // on-disk record from before `ownerId` existed must land in
  // `LOCAL_DEV_USER_ID`'s bucket, exactly like `withDefaults` already
  // makes it appear to belong to that owner everywhere else.
  const store = new JsonCollectionStore<ProjectRecord>(dataDir, "projects", { indexBy: (record) => record.ownerId ?? LOCAL_DEV_USER_ID });
  return {
    get: (id) => {
      const record = store.get(id);
      return record ? withDefaults(record) : null;
    },
    list: () => store.list().map(withDefaults),
    listByOwner: (ownerId) => store.listByIndex(ownerId).map(withDefaults),
    save: (record) => store.save(withDefaults(record)),
    delete: (id) => store.delete(id)
  };
}

export function createConversationRepository(dataDir: string): ConversationRepository {
  const store = new JsonCollectionStore<ConversationRecord>(dataDir, "conversations", { indexBy: (record) => record.projectId });
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (record) => store.save(record),
    delete: (id) => store.delete(id),
    listForProject: (projectId) => store.listByIndex(projectId)
  };
}

export function createMessageRepository(dataDir: string): MessageRepository {
  const store = new JsonCollectionStore<MessageRecord>(dataDir, "messages", { indexBy: (record) => record.conversationId });
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (record) => store.save(record),
    delete: (id) => store.delete(id),
    listForConversation: (conversationId) => store.listByIndex(conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  };
}

export function createFileRepository(dataDir: string): FileRepository {
  const store = new JsonCollectionStore<FileRecord>(dataDir, "files", { indexBy: (record) => record.projectId });
  return {
    get: (id) => store.get(id),
    list: () => store.list(),
    save: (record) => store.save(record),
    delete: (id) => store.delete(id),
    listForProject: (projectId) => store.listByIndex(projectId)
  };
}
