import type { SessionMode, ToolMutationKind, ToolTarget, ToolValueSchema } from "./types.js";

/**
 * The Gemini/model-provider data contracts (P7).
 *
 * These types describe the CONTROLLED boundary between NAQSH and a large
 * language model — what NAQSH is willing to send (`ModelRequest`) and what
 * it will accept back (`ModelResponse`/`ModelInvocationResult`). They do
 * NOT describe Gemini's own SDK types: nothing here imports `@google/genai`
 * or any provider package, and nothing provider-specific (an API key, an
 * SDK response shape, a vendor error code) appears in this file. That
 * mapping is each concrete provider's own job (packages/model-providers),
 * exactly like `EnvironmentObject` (P5) is a provider-independent contract
 * that a concrete `EnvironmentAdapter` implementation maps a real
 * environment's data into.
 *
 * Tool schemas are NOT reinvented here. `ModelToolDeclaration.inputSchema`
 * is the exact same `ToolValueSchema` a `Tool` (P3) already carries — the
 * "P7 hands this to Gemini's function-calling `parameters` field unchanged"
 * design types.ts already documents for `ToolValueSchema`. One canonical
 * schema type, not a fourth manually-maintained copy.
 */

// ---------------------------------------------------------------------------
// Model request configuration
// ---------------------------------------------------------------------------

/** Generation parameters, centralized here rather than scattered as magic
 * numbers through provider code. `null` means "let the provider use its
 * own default" — this type does not invent a default temperature/token
 * limit of its own. */
export interface ModelRequestConfig {
  modelId: string;
  temperature: number | null;
  maxOutputTokens: number | null;
  timeoutMs: number | null;
}

export interface ModelRequestConfigInput {
  modelId: string;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  timeoutMs?: number | null;
}

// ---------------------------------------------------------------------------
// Tool declarations (what NAQSH tells the model it may ask to call)
// ---------------------------------------------------------------------------

/** What a model is told about ONE callable tool. Deliberately a subset/
 * projection of `Tool` (P3), not a copy of the whole entity: a model never
 * needs `Tool.id`/`version`/`source`, and must never see anything that
 * could be mistaken for a handler. `mutation`/`target` are included
 * un-renamed from `ToolMutationKind`/`ToolTarget` specifically so a future
 * P9/P10 planner can reason about "is this tool safe to suggest here"
 * using the SAME classification P4 authorization already gates on. */
export interface ModelToolDeclaration {
  name: string;
  description: string;
  inputSchema: ToolValueSchema;
  mutation: ToolMutationKind;
  target: ToolTarget;
}

export type ModelToolDeclarationInput = ModelToolDeclaration;

// ---------------------------------------------------------------------------
// Context (the bounded, structured slice of World Model state sent to the model)
// ---------------------------------------------------------------------------

/**
 * A CONTROLLED, bounded summary of relevant World Model state — never the
 * raw `Project`/`WorldModelState` dumped into a prompt. Deliberately shallow
 * for P7: counts and identifiers, not full entity bodies. Deep, selective
 * "what's actually relevant right now" extraction is P8's job (Observation
 * & Understanding); P7 only needs to prove the context-building BOUNDARY
 * exists and is deterministic/serializable/bounded, not to solve relevance.
 */
export interface ModelContext {
  projectId: string | null;
  projectName: string | null;
  projectSummary: string | null;
  objectiveSummary: string | null;
  requirementCount: number;
  constraintCount: number;
  objectCount: number;
  decisionCount: number;
  sessionMode: SessionMode | null;
  focusObjectIds: string[];
  metadata: Record<string, unknown>;
}

export interface ModelContextInput {
  projectId?: string | null;
  projectName?: string | null;
  projectSummary?: string | null;
  objectiveSummary?: string | null;
  requirementCount?: number;
  constraintCount?: number;
  objectCount?: number;
  decisionCount?: number;
  sessionMode?: SessionMode | null;
  focusObjectIds?: string[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Attachments (bounded binary content attached to a request — currently
// only a captured live-view frame, P22's frame-analysis feature)
// ---------------------------------------------------------------------------

export type ModelAttachmentKind = "image";

export const MODEL_ATTACHMENT_KINDS: readonly ModelAttachmentKind[] = ["image"];

/** The mime types a provider is asked to accept inline — deliberately an
 * allowlist of the formats a browser `<canvas>.toDataURL()` capture
 * (LiveViewPanel's frame grab) actually produces, not "whatever the
 * caller sends". */
export const MODEL_ATTACHMENT_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];

/** A bounded, JSON-safe binary attachment — base64, never a raw Buffer/
 * Blob, so `ModelRequest` stays serializable the same way every other P7
 * type is (`serializeModelRequest`/`deserializeModelRequest`). Size is
 * capped at construction (`assertModelAttachment`) at a few MB decoded —
 * comfortably over a live-view frame capture, nowhere near "accept
 * arbitrary large uploads through the model-request path". */
export interface ModelAttachment {
  kind: ModelAttachmentKind;
  mimeType: string;
  dataBase64: string;
}

export type ModelAttachmentInput = ModelAttachment;

// ---------------------------------------------------------------------------
// Model request
// ---------------------------------------------------------------------------

/** Everything a `ModelProvider.generate()` call needs, and nothing it
 * doesn't: no live World Model reference, no database handle, no
 * environment adapter — only data, already extracted and bounded by a
 * context builder (core's `buildModelContext`). `outputSchema`, when
 * present, is a `ToolValueSchema` a provider should ask the model to
 * conform its structured output to (Gemini's `responseSchema` feature) —
 * the SAME schema type as tool input, not a separate one. `attachments` is
 * bounded (see `assertModelRequest`) and empty for every P7-P21 caller;
 * only P22's frame-analysis endpoint populates it. */
export interface ModelRequest {
  id: string;
  systemInstruction: string | null;
  context: ModelContext;
  instruction: string;
  tools: ModelToolDeclaration[];
  outputSchema: ToolValueSchema | null;
  attachments: ModelAttachment[];
  config: ModelRequestConfig;
  sessionId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ModelRequestInput {
  id?: string;
  systemInstruction?: string | null;
  context: ModelContextInput;
  instruction: string;
  tools?: ModelToolDeclarationInput[];
  outputSchema?: ToolValueSchema | null;
  attachments?: ModelAttachmentInput[];
  config: ModelRequestConfigInput;
  sessionId?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool call intent (inert data, never a live function reference)
// ---------------------------------------------------------------------------

/** What the model asked for — a NAME and JSON-safe ARGUMENTS, structurally
 * incapable of carrying executable code (same reasoning `Tool` never
 * carries a handler: this type has no field a function could occupy). This
 * is UNVALIDATED against any specific tool's schema; that happens where
 * `Tool`/`ToolRegistry` already live (core's `executeTool`), not here. */
export interface ModelToolCallIntent {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ModelToolCallIntentInput {
  id?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Model response (typed, kind-discriminated -- never raw provider JSON)
// ---------------------------------------------------------------------------

/**
 * What a model's turn can represent. Kept intentionally small — this is
 * the extension point future phases grow, not their behavior:
 *   "text"                  -> a plain natural-language reply
 *   "structured_result"     -> JSON-safe structured output (validated
 *                              against `ModelRequest.outputSchema` when one
 *                              was provided)
 *   "tool_call"              -> an intent to call ONE declared tool
 *   "clarification_request" -> the model is asking a question instead of
 *                              answering (P19's eventual hook; P7 only
 *                              reserves the shape)
 *   "error"                  -> the model itself reported it could not
 *                              produce a usable answer (DISTINCT from a
 *                              provider-level failure -- see
 *                              `ModelInvocationResult.error` for that)
 */
export type ModelResponseKind = "text" | "structured_result" | "tool_call" | "clarification_request" | "error";

export const MODEL_RESPONSE_KINDS: readonly ModelResponseKind[] = [
  "text",
  "structured_result",
  "tool_call",
  "clarification_request",
  "error"
];

/** Flat, kind-discriminated shape (same family as `ToolResult`/
 * `EnvironmentOperationResult`): exactly the field matching `kind` is
 * non-null, every other field is null. Validated, not merely typed —
 * `assertModelResponse` enforces this so "a response claims kind:'text'
 * but text is null" fails at construction, not somewhere downstream. */
export interface ModelResponse {
  id: string;
  requestId: string;
  kind: ModelResponseKind;
  text: string | null;
  structuredResult: Record<string, unknown> | null;
  toolCall: ModelToolCallIntent | null;
  errorMessage: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ModelResponseInput {
  id?: string;
  requestId: string;
  kind: ModelResponseKind;
  text?: string | null;
  structuredResult?: Record<string, unknown> | null;
  toolCall?: ModelToolCallIntentInput | null;
  errorMessage?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider-level invocation result and errors
// ---------------------------------------------------------------------------

/** Every distinct way a `ModelProvider.generate()` call can fail BEFORE a
 * usable `ModelResponse` exists — never a bare `Error("AI failed")`. */
export type ModelErrorKind =
  | "api_unavailable"
  | "authentication_failure"
  | "timeout"
  | "rate_limit"
  | "malformed_response"
  | "schema_validation_failed"
  | "unexpected_output"
  | "tool_call_schema_failure"
  | "provider_error";

export const MODEL_ERROR_KINDS: readonly ModelErrorKind[] = [
  "api_unavailable",
  "authentication_failure",
  "timeout",
  "rate_limit",
  "malformed_response",
  "schema_validation_failed",
  "unexpected_output",
  "tool_call_schema_failure",
  "provider_error"
];

export interface ModelInvocationError {
  kind: ModelErrorKind;
  message: string;
}

export type ModelInvocationStatus = "success" | "error";

/**
 * The ONE result shape every `ModelProvider.generate()` call resolves to —
 * never a thrown exception for an expected failure, exactly the discipline
 * `ToolResult` (P3) and `EnvironmentOperationResult` (P5) already
 * established. `providerId`/`modelId`/`sessionId` are duplicated from the
 * request/provider onto the result deliberately, so this single record is
 * self-contained enough to log/audit without joining back to the request
 * that produced it (P7 §10's traceability requirement). Latency and
 * tool-call count are NOT stored — both are trivially derivable
 * (`completedAt - startedAt`, `response?.toolCall != null`) and storing
 * them would just be a second, driftable copy of data already present.
 */
export interface ModelInvocationResult {
  id: string;
  requestId: string;
  providerId: string;
  modelId: string;
  sessionId: string | null;
  status: ModelInvocationStatus;
  response: ModelResponse | null;
  error: ModelInvocationError | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface ModelInvocationResultInput {
  id?: string;
  requestId: string;
  providerId: string;
  modelId: string;
  sessionId?: string | null;
  status: ModelInvocationStatus;
  response?: ModelResponse | null;
  error?: ModelInvocationError | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Static provider identity + capabilities — the model-provider analogue of
 * `EnvironmentDescriptor`. Synchronous, cannot fail, checkable before ever
 * calling `generate()`. */
export interface ModelProviderDescriptor {
  providerId: string;
  modelId: string;
  supportsToolCalling: boolean;
  supportsStructuredOutput: boolean;
  metadata: Record<string, unknown>;
}

export interface ModelProviderDescriptorInput {
  providerId: string;
  modelId: string;
  supportsToolCalling?: boolean;
  supportsStructuredOutput?: boolean;
  metadata?: Record<string, unknown>;
}
