/**
 * THE integration seam. Every view in this application reads project data
 * exclusively through this shape — never by importing `demoProject.ts`
 * directly, and never by hand-rolling a fetch call inline in a component.
 *
 * Two implementations exist: `data/demo/demoDataSource.ts` (the original
 * offline/demo fallback, used only when the real API is unreachable) and
 * `data/HttpDataSource.ts` (Phase B -- the real one, composing a
 * `ProjectSnapshot` from `apps/api`'s real HTTP routes via `api/client.ts`).
 * `ProjectDataProvider.tsx` picks between them the same way the chat
 * layer already does (`apiConnected ? real : offline fallback`) -- no
 * component above this seam needs to know which one is active.
 *
 * `HttpDataSource` leaves genuinely-unbuilt fields honestly empty/null
 * (`clarifications`, `candidates`, `designSpecifications`,
 * `objectiveSatisfaction`, `decisions` -- see that file's own doc comment
 * for exactly which backend capability each one is still missing) rather
 * than fabricating placeholder data.
 *
 * Every field/type below is a REAL `@naqsh/schemas` entity type, reused
 * directly rather than re-declared — the UI never invents a parallel
 * domain model.
 */
import type {
  BackgroundJob,
  Candidate,
  Check,
  Clarification,
  Constraint,
  Decision,
  DesignSpecification,
  EngineeringObject,
  Experiment,
  JobEvent,
  MemoryRecord,
  ObjectiveSatisfactionResult,
  Plan,
  Proposal,
  Requirement,
  ResearchEvidence,
  Source,
  VerificationResult
} from "@naqsh/schemas";

export interface ProjectSummary {
  id: string;
  name: string;
  version: number;
  createdAt: string;
}

/** A real uploaded file's metadata -- not a `@naqsh/schemas` entity (file
 * storage lives entirely in `apps/api`'s own repository layer, see
 * `FileRecord`), so this is the minimal wire shape the Files tab actually
 * needs. Deliberately excludes the full `extractedText` body (kept out of
 * the snapshot payload; nothing today reads it back from here). */
export interface ProjectFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  extractionStatus: "success" | "failed" | "unsupported";
  extractionError: string | null;
}

export interface ProjectSnapshot {
  project: ProjectSummary;
  requirements: Requirement[];
  constraints: Constraint[];
  clarifications: Clarification[];
  /** The World Model's real engineering objects -- lets a view resolve a
   * pending Proposal's CURRENT property value (e.g. `holeOffsetMm: 2.4`)
   * against what it would become if approved, for a genuine Before →
   * After diff (`ProposalCard`) rather than only showing the "after" side
   * `Proposal.input` carries on its own. */
  objects: EngineeringObject[];
  plan: Plan | null;
  sources: Source[];
  evidence: ResearchEvidence[];
  candidates: Candidate[];
  designSpecifications: DesignSpecification[];
  checks: Check[];
  verificationResults: VerificationResult[];
  experiments: Experiment[];
  objectiveSatisfaction: ObjectiveSatisfactionResult | null;
  proposals: Proposal[];
  decisions: Decision[];
  memoryRecords: MemoryRecord[];
  backgroundJobs: BackgroundJob[];
  jobEvents: JobEvent[];
  files: ProjectFile[];
}

export type EnvironmentConnectionStatus = "connected" | "disconnected" | "connecting";

export interface EnvironmentStatus {
  kind: string;
  name: string;
  status: EnvironmentConnectionStatus;
  /** Real `EnvironmentDescriptor.capabilities` for the connected
   * environment kind -- e.g. `["modify", "save", "checkpoint"]`. Never a
   * fabricated "Observe/Analyze/Suggest/Verify" list: those are NAQSH's
   * own tool-layer behaviors, not properties of the environment, so a
   * view rendering "what Naqsh can do here" must derive it from this
   * real, closed set (`create`/`modify`/`delete`/`save`/`checkpoint`)
   * plus baseline read access, never invent capability names. */
  capabilities: string[];
  /** The connected session's real document name, or `null` -- no
   * session connected yet, or a mock environment connected with none
   * set. There is deliberately no "current selection"/"current
   * operation" field anywhere in this data source: neither concept
   * exists in the backend (no adapter tracks selection state, and every
   * environment operation is fire-and-forget request/response with no
   * persisted in-progress state) -- surfacing either would be fabricated
   * UI, which this codebase does not do. */
  documentName: string | null;
}

/** A single structured agent-activity entry — mirrors how the backend
 * already narrates its own reasoning in this codebase's own doc comments
 * (Observed / Reasoning / Recommendation / Proposal), not a chat
 * transcript. `proposalId`, when set, lets the panel deep-link straight to
 * the matching `ProposalCard`. */
export type AgentEventKind = "observed" | "reasoning" | "recommendation" | "proposal" | "verification" | "note";

export interface AgentEvent {
  id: string;
  kind: AgentEventKind;
  title: string;
  body: string;
  createdAt: string;
  proposalId?: string;
}

export interface NaqshDataSource {
  /** `projectId`, when supplied, asks for THAT project's real environment
   * (each real project has its own connection/session) -- optional only
   * so the single-environment demo implementation can ignore it. */
  getEnvironmentStatus(projectId?: string): Promise<EnvironmentStatus>;
  /** Explicitly triggers the real connect (never eagerly done on its own
   * -- see `ensureEnvironmentSession`'s own doc comment) -- lets a
   * "Connect"/"Reconnect" control in the UI show a genuine connection
   * moment on demand, reusing the exact same lazy-connect path every
   * other engineering action already goes through. A no-op resolve for
   * the offline demo (there is no real session to establish). */
  connectEnvironment(projectId: string): Promise<void>;
  /** ONE captured live-view frame + a question, answered by a real model
   * provider -- see `LiveViewPanel`'s own doc comment for why this only
   * ever fires on an explicit user action, never automatically. Rejects
   * for the offline demo (there is no real backend/model call to make). */
  analyzeFrame(projectId: string, imageDataUrl: string, question: string, modelId: string): Promise<string>;
  /** Every project this data source can currently open -- populates the
   * chat sidebar's project list. */
  listProjects(): Promise<ProjectSummary[]>;
  getProjectSnapshot(projectId: string): Promise<ProjectSnapshot>;
  getAgentEvents(projectId: string): Promise<AgentEvent[]>;
  /** Resolves the proposal to `"approved"`/`"rejected"`. In the demo
   * implementation this only updates in-memory state for the current
   * session — never anything persisted, never anything real. */
  decideProposal(proposalId: string, decision: "approved" | "rejected"): Promise<Proposal>;
  /** Re-interprets the clarification's question + the user's answer (a
   * real Gemini call server-side, P18's unchanged interpretation pipeline)
   * into either a fresh Requirement (the answer resolved things) or a
   * genuine rejection (the answer didn't). `projectId`/`modelId` are
   * required by the real implementation (the route is project-scoped and
   * re-interpretation needs a model); the demo implementation ignores
   * both. */
  answerClarification(projectId: string, clarificationId: string, answerText: string, modelId: string): Promise<Clarification>;
  /** `projectId`, when supplied, is required by the real implementation
   * (jobs are scoped under `/projects/:id/jobs/:jobId`) -- optional only
   * for the demo implementation's single-project world. */
  cancelBackgroundJob(jobId: string, projectId?: string): Promise<BackgroundJob>;
  /** A real lifecycle transition (`MemoryStore.archive`, `@naqsh/core`) --
   * `status: "rejected"` records the memory was found INCORRECT, distinct
   * from `"archived"` (no longer needed). There is no "edit" here: a
   * memory's content is immutable once created, so this data source never
   * pretends otherwise. */
  archiveMemory(projectId: string, memoryId: string, status: "archived" | "rejected", reason?: string): Promise<MemoryRecord>;
  /** Real Gemini calls (`generateDesignSpecification`, `@naqsh/core`),
   * one per requested variation -- genuinely unavailable for the offline
   * demo (there is no live model connection to fake this with), so
   * `demoDataSource` throws rather than pretending to generate anything.
   * A caller should only ever invoke this when `isRealProject` is true
   * (`ProjectDataProvider`). */
  generateCandidates(projectId: string, planId: string, planStepId: string, count: number, modelId: string): Promise<{ generatedCount: number; failedCount: number }>;
}
