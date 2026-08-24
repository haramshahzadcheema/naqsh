import type {
  Approval,
  AutonomyLevel,
  BackgroundJob,
  Candidate,
  Check,
  Clarification,
  DesignSpecification,
  Experiment,
  JobBudgetInput,
  JobEvent,
  MemoryKind,
  MemoryRecord,
  MemoryReferencesInput,
  ObjectiveSatisfactionResult,
  Plan,
  Proposal,
  Requirement,
  ResearchEvidence,
  ResearchFetchContent,
  Source,
  SourceType,
  VerificationResult,
  WorldModelState
} from "@naqsh/schemas";
import type { ExecutionReport } from "../chat/workflowEvents.js";
import { getLocalUserId } from "./localIdentity.js";

/**
 * The ONE place `apps/web` talks HTTP to the real `@naqsh/api` server.
 * Every function here is a thin `fetch` wrapper -- no business logic, no
 * duplicated validation, matching the same "the API layer is thin, core
 * does the work" discipline the server itself follows. Nothing in this
 * file imports `@naqsh/core`/`@google/genai`/anything server-side: the
 * browser reaches the real architecture ONLY through HTTP, never directly.
 */
const API_BASE = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL ?? "http://localhost:3001";

/** The real, complete environment-kind value space this server can
 * actually connect a project to -- see `apps/api/src/db/repositories.ts`'s
 * own doc comment for exactly why this excludes "freecad" (a real adapter
 * exists in `@naqsh/adapters`, but nothing in this deployment drives a
 * live session from it yet). Redeclared here rather than imported: the
 * browser never imports server-side packages, matching this file's own
 * "reaches the real architecture only through HTTP" discipline. */
export type ApiEnvironmentKind = "mock_cad" | "mock_simulation" | "freecad";

export interface ApiProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  requirementCount: number;
  version: number;
  environmentKind: ApiEnvironmentKind;
}

export interface ApiConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  fileIds?: string[];
  error?: { kind: string; message: string };
}

export type ApiRequirementOutcome =
  | { kind: "requirement_added"; requirement: Requirement }
  | { kind: "clarification_needed"; clarifications: Clarification[] }
  | { kind: "interpretation_failed"; message: string }
  | { kind: "execution_denied"; reason: string }
  | null;

/** The raw wire shape of `apps/api/src/workflowEvents.ts`'s
 * `ChatWorkflowEvent` -- redeclared here (never imported across the HTTP
 * boundary) exactly as `POST /conversations/:id/messages` actually
 * returns it. `chat/workflowEvents.ts`'s `ChatWorkflowUiEvent` is the
 * thread-local version of this, with a `messageId` added once it's
 * attached to a specific assistant message. */
export type ApiChatWorkflowEvent =
  | { kind: "plan_created"; plan: Plan }
  | { kind: "proposal_created"; proposal: Proposal; approvalId: string }
  | {
      kind: "exploration_prepared";
      planId: string;
      planStepId: string;
      candidates: Array<{ designSpecification: DesignSpecification; candidate: Candidate }>;
      failures: Array<{ kind: string; message: string }>;
      pendingApprovals: Approval[];
      allowedTools: string[];
    }
  | { kind: "workflow_failed"; stage: "planning" | "proposal" | "exploration"; message: string };

export interface ApiSendMessageResult {
  userMessage: ApiMessage;
  assistantMessage: ApiMessage;
  requirementOutcome: ApiRequirementOutcome;
  workflowEvents: ApiChatWorkflowEvent[];
}

export class ApiError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ApiError";
  }
}

export interface ApiFileRecord {
  id: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  extractionStatus: "success" | "failed" | "unsupported";
  extractedText: string | null;
  extractionError: string | null;
}

function withIdentity(headers?: HeadersInit): HeadersInit {
  return { ...headers, "x-naqsh-user": getLocalUserId() };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: withIdentity(init?.headers) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const kind = typeof body?.error?.kind === "string" ? body.error.kind : "http_error";
    const message = body?.error?.message ?? `Request to ${path} failed with status ${res.status}`;
    throw new ApiError(kind, message);
  }
  return (await res.json()) as T;
}

export async function checkApiHealth(timeoutMs = 1500): Promise<{ geminiConfigured: boolean } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${API_BASE}/health`, { signal: controller.signal, headers: withIdentity() });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as { geminiConfigured: boolean };
  } catch {
    return null;
  }
}

export function apiCreateProject(name: string, description: string, environmentKind?: ApiEnvironmentKind, documentPath?: string): Promise<ApiProjectSummary> {
  return request("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, environmentKind, documentPath }) });
}

export interface ApiEnvironmentAvailability {
  kind: string;
  name: string;
  status: "unavailable" | "connectable";
  reason: string | null;
  resolvedCommandPath: string | null;
  version: string | null;
  checkedAt: string;
  capabilities: string[];
}

/** Real, server-side discovery -- never a static "supported environments"
 * list. `forceRefresh` bypasses the server's own discovery cache (used by
 * an explicit "Recheck" action; ordinary reads should leave it `false`). */
export function apiDiscoverEnvironments(forceRefresh = false): Promise<{ environments: ApiEnvironmentAvailability[] }> {
  return request(`/environments/discover${forceRefresh ? "?refresh=true" : ""}`);
}

export function apiConnectEnvironment(projectId: string): Promise<{ status: "connected"; session: { id: string; documentName: string; openedAt: string } }> {
  return request(`/projects/${projectId}/environment/connect`, { method: "POST" });
}

/** ONE captured live-view frame (a `data:image/...;base64,...` string from
 * `LiveViewPanel`'s own `<canvas>.toDataURL()` grab) + a question, answered
 * by the real configured model provider. Never a continuous stream, never
 * anything sent without the user explicitly capturing a frame first. */
export function apiAnalyzeFrame(projectId: string, imageDataUrl: string, question: string, modelId: string): Promise<{ text: string }> {
  return request(`/projects/${projectId}/environment/frame-analysis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageDataUrl, question, modelId })
  });
}

export function apiCreateConversation(projectId: string, title?: string): Promise<ApiConversation> {
  return request("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, title }) });
}

export function apiSendMessage(conversationId: string, text: string, modelId: string, style: string, fileIds: string[]): Promise<ApiSendMessageResult> {
  return request(`/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, modelId, style, fileIds })
  });
}

/** Phase C: a real "Regenerate" for the most recent assistant reply --
 * see `apps/api/src/chatWorkflow.ts`'s `regenerateChatReply` doc comment
 * for exactly what it will and won't do. Throws `ApiError` with kind
 * `"unsupported"` (409) for a design-workflow reply and `"invalid_input"`
 * (422) for anything but the most recent message -- both real, honest
 * limitations the caller should surface, never silently swallow.
 */
export function apiRegenerateMessage(conversationId: string, messageId: string, modelId: string, style: string): Promise<{ assistantMessage: ApiMessage }> {
  return request(`/conversations/${conversationId}/messages/${messageId}/regenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId, style })
  });
}

export interface ApiModelCatalogEntry {
  provider: "gemini" | "mock";
  modelId: string;
  label: string;
  contextWindowTokens: number | null;
  capabilities: { multimodal: boolean; toolCalling: boolean; structuredOutput: boolean; streaming: boolean };
  available: boolean;
  availabilityReason: string | null;
}

export function apiGetModelCatalog(): Promise<ApiModelCatalogEntry[]> {
  return request("/models");
}

/**
 * Part 10: genuine streaming. Reads the real SSE body from `POST
 * .../messages/stream` -- `onDelta` fires only for text the server
 * ACTUALLY sent incrementally (see server.ts's own doc comment: the
 * deterministic model, or any provider without real streaming support,
 * delivers zero delta events and one `done` event, never a fake
 * drip-fed reveal of an already-complete string). `signal`, when
 * provided, lets a caller genuinely stop reading further chunks (a real
 * "Stop" action) -- whatever text arrived via `onDelta` before the abort
 * is already rendered and stays that way; this function then rejects
 * with a DOMException named "AbortError", which the caller should treat
 * as "stopped," not as a failure.
 */
export async function apiSendMessageStream(
  conversationId: string,
  text: string,
  modelId: string,
  style: string,
  fileIds: string[],
  onDelta: (deltaText: string) => void,
  signal?: AbortSignal
): Promise<ApiSendMessageResult> {
  const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: withIdentity({ "content-type": "application/json" }),
    body: JSON.stringify({ text, modelId, style, fileIds }),
    signal
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const kind = typeof body?.error?.kind === "string" ? body.error.kind : "http_error";
    const message = body?.error?.message ?? `Request to the streaming endpoint failed with status ${res.status}`;
    throw new ApiError(kind, message);
  }
  if (!res.body) {
    throw new ApiError("stream_unsupported", "This browser does not support reading a streamed response body.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: ApiSendMessageResult | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = raw.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice("event: ".length);
      const data = JSON.parse(dataLine.slice("data: ".length)) as { text: string } | ApiSendMessageResult;
      if (event === "delta") onDelta((data as { text: string }).text);
      else if (event === "done") finalResult = data as ApiSendMessageResult;
    }
  }

  if (!finalResult) throw new ApiError("stream_incomplete", "The stream ended before a final result arrived.");
  return finalResult;
}

export async function apiUploadFiles(projectId: string, files: File[]): Promise<ApiFileRecord[]> {
  const form = new FormData();
  form.append("projectId", projectId);
  for (const file of files) form.append("files", file);
  const res = await fetch(`${API_BASE}/files`, { method: "POST", headers: withIdentity(), body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `File upload failed with status ${res.status}`);
  }
  return (await res.json()) as ApiFileRecord[];
}

export function apiGetActivity(projectId: string): Promise<Array<{ id: string; kind: string; title: string; body: string; createdAt: string }>> {
  return request(`/projects/${projectId}/activity`);
}

/** Phase D: every file genuinely uploaded to this project -- the real
 * file workspace list, never a client-side guess at what was attached. */
export function apiListProjectFiles(projectId: string): Promise<ApiFileRecord[]> {
  return request(`/projects/${projectId}/files`);
}

/** The one real file preview seam: `GET /files/:fileId` already returns
 * the FULL record, including `extractedText` for a successfully-processed
 * text file -- the same real bytes a chat message that attached this file
 * was interpreted from. A binary/failed file's `extractedText` is
 * honestly `null`; the caller shows that as "no preview available," never
 * fabricated content. */
export function apiGetFile(fileId: string): Promise<ApiFileRecord> {
  return request(`/files/${fileId}`);
}

/** The real original bytes (`GET /files/:id/raw`) as a `Blob`, for a
 * genuine image/PDF preview -- not `request()` (which always parses
 * JSON) because this response body is the file itself. Goes through a
 * real authenticated `fetch()`, not a bare `<img src>`, because the
 * server's ownership check reads the `x-naqsh-user` header, which an
 * `<img>`/`<embed>` tag has no way to send; the caller turns the
 * resulting Blob into an object URL instead. */
export async function apiGetFileRawBlob(fileId: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/files/${fileId}/raw`, { headers: withIdentity() });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(typeof body?.error?.kind === "string" ? body.error.kind : "http_error", body?.error?.message ?? `Could not load this file's content (status ${res.status}).`);
  }
  return res.blob();
}

// ---- Engineering workflow: approve/reject/execute a Proposal, and offer
// rollback -- the human-in-the-loop half of Part 11's OBSERVE -> PLAN ->
// PROPOSE -> APPROVE -> EXECUTE -> VERIFY -> REPORT loop (plan/proposal
// GENERATION itself happens server-side, triggered by chat intent -- see
// `apps/api/src/server.ts`'s `hasDesignIntent` handling of
// `POST /conversations/:id/messages`).

export function apiApproveProposal(proposalId: string, reason?: string): Promise<{ proposal: Proposal; approval: Approval }> {
  return request(`/proposals/${proposalId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
}

export function apiRejectProposal(proposalId: string, reason?: string): Promise<{ proposal: Proposal; approval: Approval }> {
  return request(`/proposals/${proposalId}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
}

// ---- Section 5 "explore alternatives": generic Approvals (not born from
// one specific Proposal -- see prepareExploration/server.ts's generic
// /projects/:projectId/approvals routes) + starting the real background
// job once every one of them is approved.

export function apiApproveApproval(projectId: string, approvalId: string, reason?: string): Promise<Approval> {
  return request(`/projects/${projectId}/approvals/${approvalId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
}

export function apiRejectApproval(projectId: string, approvalId: string, reason?: string): Promise<Approval> {
  return request(`/projects/${projectId}/approvals/${approvalId}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
}

export interface ApiSubmitJobInput {
  objective: string;
  candidateIds: string[];
  autonomyLevel: AutonomyLevel;
  allowedTools: string[];
  budget: JobBudgetInput;
}

export function apiSubmitJob(projectId: string, input: ApiSubmitJobInput): Promise<BackgroundJob> {
  return request(`/projects/${projectId}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

/** Revalidates freshness/authorization/environment capability, creates a
 * checkpoint, performs the real mutation, then runs deterministic
 * verification and objective evaluation -- all server-side, in one call.
 * The frontend never claims any of these steps happened before this
 * promise resolves. */
export function apiExecuteProposal(proposalId: string): Promise<ExecutionReport> {
  return request(`/proposals/${proposalId}/execute`, { method: "POST" });
}

export function apiRollback(projectId: string, checkpointId: string, reason?: string): Promise<{ mismatchDetected?: boolean; warnings?: string[] }> {
  return request(`/projects/${projectId}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checkpointId, reason })
  });
}

// ---- Phase B/F: the real project snapshot -- every one of these is a
// thin GET wrapper around a route that already exists (or was added this
// phase specifically to close a snapshot gap); `data/HttpDataSource.ts`
// composes them into one `ProjectSnapshot`, never fabricating a field this
// backend genuinely doesn't have yet.

export function apiListProjects(): Promise<ApiProjectSummary[]> {
  return request("/projects");
}

export interface ApiProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  worldModelState: WorldModelState;
}

export function apiGetProject(projectId: string): Promise<ApiProjectRecord> {
  return request(`/projects/${projectId}`);
}

export function apiGetPlans(projectId: string): Promise<Plan[]> {
  return request(`/projects/${projectId}/plans`);
}

export function apiGetProposalsForProject(projectId: string): Promise<Array<{ proposal: Proposal; approvalId: string; approval: Approval | null }>> {
  return request(`/projects/${projectId}/proposals`);
}

export function apiGetCandidates(projectId: string): Promise<Candidate[]> {
  return request(`/projects/${projectId}/candidates`);
}

export function apiGetDesignSpecifications(projectId: string): Promise<DesignSpecification[]> {
  return request(`/projects/${projectId}/design-specifications`);
}

export interface ApiGeneratedCandidate {
  designSpecification: DesignSpecification;
  candidate: Candidate;
}

/** Real Gemini calls, one per requested variation -- `generateDesignSpecification`
 * (`@naqsh/core`) through a live server. Best-effort: `failures.length > 0`
 * with `candidates.length > 0` means SOME variations didn't come back as
 * valid structured output; the caller should show both honestly, never
 * silently drop the failure count. */
export function apiGenerateCandidates(
  projectId: string,
  planId: string,
  planStepId: string,
  count: number,
  modelId: string
): Promise<{ candidates: ApiGeneratedCandidate[]; failures: Array<{ kind: string; message: string }> }> {
  return request(`/projects/${projectId}/plans/${planId}/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planStepId, count, modelId })
  });
}

export function apiGetChecks(projectId: string): Promise<Check[]> {
  return request(`/projects/${projectId}/checks`);
}

export function apiGetVerificationResults(projectId: string): Promise<VerificationResult[]> {
  return request(`/projects/${projectId}/verification-results`);
}

export function apiGetObjectiveSatisfactionResults(projectId: string): Promise<ObjectiveSatisfactionResult[]> {
  return request(`/projects/${projectId}/objective-satisfaction`);
}

export interface ApiEnvironmentStatus {
  kind: string;
  name: string;
  capabilities: string[];
  status: "connected" | "disconnected";
  /** The connected session's real document name, or `null` when nothing
   * is connected yet, or when a mock environment was connected with no
   * explicit name -- never a fabricated placeholder. */
  documentName: string | null;
}

export function apiGetEnvironment(projectId: string): Promise<ApiEnvironmentStatus> {
  return request(`/projects/${projectId}/environment`);
}

export function apiGetResearch(projectId: string): Promise<{ sources: Source[]; evidence: ResearchEvidence[] }> {
  return request(`/projects/${projectId}/research`);
}

export function apiFetchResearchLocator(projectId: string, locator: string): Promise<ResearchFetchContent> {
  return request(`/projects/${projectId}/research/fetch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locator }) });
}

export function apiAcceptResearchSource(
  projectId: string,
  input: { locator: string | null; title: string; publisher: string | null; sourceType: SourceType; publishedAt: string | null; contentHash: string | null }
): Promise<Source> {
  return request(`/projects/${projectId}/research/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function apiAddResearchEvidence(
  projectId: string,
  input: { sourceId: string; claim: string; excerpt?: string | null; confidence?: string | null; relevanceNote?: string | null }
): Promise<ResearchEvidence> {
  return request(`/projects/${projectId}/research/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export function apiGetExperiments(projectId: string): Promise<Experiment[]> {
  return request(`/projects/${projectId}/experiments`);
}

export function apiGetMemory(projectId: string): Promise<MemoryRecord[]> {
  return request(`/projects/${projectId}/memory`);
}

export function apiAddMemory(projectId: string, input: { kind: MemoryKind; title: string; content: string; references?: MemoryReferencesInput | null }): Promise<MemoryRecord> {
  return request(`/projects/${projectId}/memory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

/** A real lifecycle transition (`MemoryStore.archive`, @naqsh/core) -- not
 * a client-side "hide this row." `status: "rejected"` records the memory
 * was found INCORRECT rather than merely no-longer-needed. */
export function apiArchiveMemory(projectId: string, memoryId: string, status: "archived" | "rejected", reason?: string): Promise<MemoryRecord> {
  return request(`/projects/${projectId}/memory/${memoryId}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, reason }) });
}

export function apiGetJobs(projectId: string): Promise<BackgroundJob[]> {
  return request(`/projects/${projectId}/jobs`);
}

export function apiGetJob(projectId: string, jobId: string): Promise<{ job: BackgroundJob; events: JobEvent[] }> {
  return request(`/projects/${projectId}/jobs/${jobId}`);
}

export function apiCancelJob(projectId: string, jobId: string, reason?: string): Promise<BackgroundJob> {
  return request(`/projects/${projectId}/jobs/${jobId}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
}

export function apiGetRequirements(projectId: string): Promise<Requirement[]> {
  return request(`/projects/${projectId}/requirements`);
}

export function apiGetClarifications(projectId: string): Promise<Clarification[]> {
  return request(`/projects/${projectId}/clarifications`);
}

export interface ApiAnswerClarificationResult {
  kind: "answered";
  clarification: Clarification;
  outcome: Exclude<ApiRequirementOutcome, null>;
}

export function apiAnswerClarification(projectId: string, clarificationId: string, answerText: string, modelId: string): Promise<ApiAnswerClarificationResult> {
  return request(`/projects/${projectId}/clarifications/${clarificationId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answerText, modelId })
  });
}
