import { ApiError, GoogleGenAI, type FunctionCall, type GenerateContentConfig, type GenerateContentParameters, type Part } from "@google/genai";
import {
  createId,
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  ModelError,
  toIsoTimestamp,
  type ModelAttachment,
  type ModelContext,
  type ModelErrorKind,
  type ModelInvocationResult,
  type ModelProviderDescriptor,
  type ModelRequest,
  type ModelResponseInput
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "@naqsh/core";
import type { GeminiProviderConfig } from "./config.js";
import { toGeminiFunctionDeclaration, toGeminiJsonSchema } from "./schema-bridge.js";

/**
 * The real Gemini adapter (P7 brief §13) — the ONE file in this repository
 * allowed to import `@google/genai` (enforced in
 * packages/core/test/repo-boundaries.test.ts). Everything provider-facing
 * (the raw SDK response shape, `ApiError`, HTTP status codes) is mapped
 * into the provider-independent `ModelResponse`/`ModelInvocationResult`
 * contracts (packages/schemas) before this function returns — nothing
 * downstream of `generate()` ever sees a `@google/genai` type.
 *
 * UNVERIFIED against the live Gemini API: no credentials are available in
 * this environment (confirmed — no `GEMINI_API_KEY`, no `.env`), so this
 * has been typechecked against the SDK's own published types and unit
 * tested at the pure request/response-MAPPING and retry-CONTROL-FLOW level
 * (see gemini-model-provider.test.ts, which injects a fake
 * `generateContent` — see `GeminiModelProviderDependencies` below), but the
 * real network call has never been exercised end-to-end. Do not treat this
 * as proven working against the real API until it has been.
 */

const AUTH_STATUS_CODES = new Set([401, 403]);
const RETRYABLE_KINDS = new Set<ModelErrorKind>(["rate_limit", "timeout", "api_unavailable"]);

export function summarizeContextForPrompt(context: ModelContext): string {
  const lines: string[] = [];
  if (context.projectName) lines.push(`Project: ${context.projectName}`);
  if (context.projectSummary) lines.push(`Description: ${context.projectSummary}`);
  if (context.objectiveSummary) lines.push(`Objective: ${context.objectiveSummary}`);
  lines.push(
    `Requirements: ${context.requirementCount}, Constraints: ${context.constraintCount}, ` +
      `Objects: ${context.objectCount}, Decisions: ${context.decisionCount}`
  );
  if (context.sessionMode) lines.push(`Session mode: ${context.sessionMode}`);
  if (context.focusObjectIds.length > 0) lines.push(`Focus objects: ${context.focusObjectIds.join(", ")}`);
  return lines.join("\n");
}

/** Pure: `ModelRequest` (+ this provider's own default config) -> the SDK's
 * own parameter shape. Never touches the network. */
export function mapModelRequestToGeminiParams(
  request: ModelRequest,
  config: GeminiProviderConfig
): GenerateContentParameters {
  const generationConfig: GenerateContentConfig = {
    httpOptions: { timeout: request.config.timeoutMs ?? config.timeoutMs }
  };
  if (request.config.temperature !== null) generationConfig.temperature = request.config.temperature;
  if (request.config.maxOutputTokens !== null) generationConfig.maxOutputTokens = request.config.maxOutputTokens;
  if (request.systemInstruction) generationConfig.systemInstruction = request.systemInstruction;
  if (request.tools.length > 0) {
    generationConfig.tools = [{ functionDeclarations: request.tools.map(toGeminiFunctionDeclaration) }];
  }
  if (request.outputSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = toGeminiJsonSchema(request.outputSchema);
  }

  const contextText = summarizeContextForPrompt(request.context);
  const promptText = [contextText, request.instruction].filter((part) => part.length > 0).join("\n\n");

  // Plain string when there's nothing to attach (unchanged from before
  // P22's frame-analysis feature -- every existing caller/test still sees
  // exactly the same `contents` shape). Only switches to the SDK's
  // `Content[]` shape -- text part + one `inlineData` part per attachment
  // -- when a request actually carries an image (LiveViewPanel's captured
  // frame, via the frame-analysis endpoint).
  const contents: GenerateContentParameters["contents"] =
    request.attachments.length > 0
      ? [{ role: "user", parts: [{ text: promptText }, ...request.attachments.map(toGeminiInlineDataPart)] }]
      : promptText;

  return {
    model: request.config.modelId || config.modelId,
    contents,
    config: generationConfig
  };
}

function toGeminiInlineDataPart(attachment: ModelAttachment): Part {
  return { inlineData: { mimeType: attachment.mimeType, data: attachment.dataBase64 } };
}

/** The minimal shape this provider actually reads off a raw SDK response —
 * a subset of `GenerateContentResponse`, not the whole class, specifically
 * so this function is unit-testable with a hand-built plain object and
 * never needs a live API call to exercise. */
export interface RawGeminiResponseLike {
  text?: string;
  functionCalls?: FunctionCall[];
}

function isPlainArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure: raw Gemini output -> `ModelResponseInput`. Takes the full
 * `ModelRequest` (not just its id) because Gemini's structured-output
 * feature (`responseMimeType: "application/json"` + `responseJsonSchema`,
 * wired in `mapModelRequestToGeminiParams` whenever `request.outputSchema`
 * is set) returns its JSON payload through the ORDINARY `text` field, not
 * as a distinguishable "structured" field on the raw response — so
 * whether a text reply should become `kind: "text"` or `kind:
 * "structured_result"` depends on whether structured output was actually
 * requested. Getting this wrong would mean `ModelRequest.outputSchema`
 * silently did nothing on the response side even though it was wired into
 * the request: exactly the kind of half-finished feature this audit exists
 * to catch.
 *
 * Throws `ModelError` (never a bare `Error`) with a precise `kind` on any
 * shape this provider cannot interpret — `generate()` catches this and
 * reuses `error.kind` directly rather than collapsing every failure into
 * one generic "malformed_response" bucket:
 *   - more than one function call in a single turn -> "unexpected_output"
 *     (P7's `ModelResponse.toolCall` supports exactly one; silently
 *     keeping only the first would discard information the model thinks
 *     it sent, which is exactly the "multiple conflicting actions" hazard
 *     the P7 audit calls out)
 *   - a function call with no name, or non-object arguments ->
 *     "tool_call_schema_failure"
 *   - structured output was requested but the text isn't valid JSON, or
 *     doesn't parse to an object -> "malformed_response" (schema
 *     CONFORMANCE, once parsed, is `validateStructuredResult`'s job --
 *     this only guards that it is even parseable, structured data)
 *   - neither text nor a function call -> "malformed_response"
 * None of these are allowed to escape as an unhandled rejection.
 */
export function mapGeminiResponseToModelResponseInput(raw: RawGeminiResponseLike, request: ModelRequest): ModelResponseInput {
  const requestId = request.id;
  if (raw.functionCalls && raw.functionCalls.length > 1) {
    throw new ModelError(
      "unexpected_output",
      `Gemini returned ${raw.functionCalls.length} function calls in one turn; NAQSH's ModelResponse supports at most one tool call per turn`
    );
  }
  const call = raw.functionCalls?.[0];
  if (call) {
    if (!call.name) {
      throw new ModelError("tool_call_schema_failure", "Gemini returned a function call with no name");
    }
    if (call.args !== undefined && !isPlainArgsObject(call.args)) {
      throw new ModelError(
        "tool_call_schema_failure",
        `Gemini returned function call "${call.name}" with non-object arguments`
      );
    }
    return {
      requestId,
      kind: "tool_call",
      toolCall: { toolName: call.name, arguments: call.args ?? {} }
    };
  }
  if (raw.text !== undefined && raw.text.length > 0) {
    if (request.outputSchema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.text);
      } catch {
        throw new ModelError("malformed_response", "Gemini's structured-output text was not valid JSON");
      }
      if (!isPlainArgsObject(parsed)) {
        throw new ModelError("malformed_response", "Gemini's structured-output JSON did not parse to an object");
      }
      return { requestId, kind: "structured_result", structuredResult: parsed };
    }
    return { requestId, kind: "text", text: raw.text };
  }
  throw new ModelError("malformed_response", "Gemini response contained neither text nor a function call");
}

/** Pure: classifies whatever `generateContent` threw into one of this
 * repo's `ModelErrorKind`s, so a network/SDK failure never reaches a
 * caller as an unclassified `Error`. */
export function classifyGeminiError(error: unknown): { kind: ModelErrorKind; message: string } {
  if (error instanceof ApiError) {
    if (AUTH_STATUS_CODES.has(error.status)) {
      return { kind: "authentication_failure", message: error.message };
    }
    if (error.status === 429) {
      return { kind: "rate_limit", message: error.message };
    }
    if (error.status === 408 || error.status === 504) {
      return { kind: "timeout", message: error.message };
    }
    if (error.status >= 500) {
      return { kind: "api_unavailable", message: error.message };
    }
    return { kind: "provider_error", message: error.message };
  }
  if (error instanceof Error && (error.name === "AbortError" || /timeout/i.test(error.message))) {
    return { kind: "timeout", message: error.message };
  }
  return { kind: "provider_error", message: error instanceof Error ? error.message : String(error) };
}

/** Injectable seam for the actual network call, so `generate()`'s full
 * control flow (including the retry loop below) can be exercised by a
 * test with a hand-written fake, never a live API call. Defaults to the
 * real `@google/genai` client — production code never needs to pass this. */
export interface GeminiModelProviderDependencies {
  generateContent?: (params: GenerateContentParameters) => Promise<RawGeminiResponseLike>;
  /** Same injectable-seam discipline as `generateContent`, for the
   * streaming path — a test supplies a fake async-iterable of chunks
   * rather than exercising a live network call. Matches the real SDK's
   * own shape: `generateContentStream` itself resolves to an async
   * iterator, rather than being one. */
  generateContentStream?: (params: GenerateContentParameters) => Promise<AsyncIterable<RawGeminiResponseLike>>;
}

function defaultGenerateContent(config: GeminiProviderConfig): (params: GenerateContentParameters) => Promise<RawGeminiResponseLike> {
  const client = new GoogleGenAI({ apiKey: config.apiKey });
  return (params) => client.models.generateContent(params);
}

function defaultGenerateContentStream(config: GeminiProviderConfig): (params: GenerateContentParameters) => Promise<AsyncIterable<RawGeminiResponseLike>> {
  const client = new GoogleGenAI({ apiKey: config.apiKey });
  return (params) => client.models.generateContentStream(params);
}

/** Shared by `generate()` and `generateStream()`: raw Gemini output (once
 * fully known, whether obtained in one call or accumulated chunk by
 * chunk) -> the final `ModelInvocationResult`. Kept as ONE function so the
 * schema-validation/error-mapping discipline is never duplicated (and
 * never allowed to drift) between the two call paths. */
function finalizeResult(
  raw: RawGeminiResponseLike,
  request: ModelRequest,
  descriptor: ModelProviderDescriptor,
  config: GeminiProviderConfig,
  startedAt: string,
  attempts: number
): ModelInvocationResult {
  try {
    const response = createModelResponse(mapGeminiResponseToModelResponseInput(raw, request));
    const schemaErrors = validateStructuredResult(response, request);
    if (schemaErrors.length > 0) {
      return createModelInvocationResult({
        id: createId("modelinv"),
        requestId: request.id,
        providerId: descriptor.providerId,
        modelId: config.modelId,
        sessionId: request.sessionId,
        status: "error",
        error: { kind: "schema_validation_failed", message: schemaErrors.join("; ") },
        startedAt,
        completedAt: toIsoTimestamp(),
        metadata: { attempts }
      });
    }
    return createModelInvocationResult({
      id: createId("modelinv"),
      requestId: request.id,
      providerId: descriptor.providerId,
      modelId: config.modelId,
      sessionId: request.sessionId,
      status: "success",
      response,
      startedAt,
      completedAt: toIsoTimestamp(),
      metadata: { attempts }
    });
  } catch (error) {
    const kind = error instanceof ModelError ? error.kind : "malformed_response";
    return createModelInvocationResult({
      id: createId("modelinv"),
      requestId: request.id,
      providerId: descriptor.providerId,
      modelId: config.modelId,
      sessionId: request.sessionId,
      status: "error",
      error: { kind, message: error instanceof Error ? error.message : String(error) },
      startedAt,
      completedAt: toIsoTimestamp(),
      metadata: { attempts }
    });
  }
}

export function createGeminiModelProvider(
  config: GeminiProviderConfig,
  dependencies: GeminiModelProviderDependencies = {}
): ModelProvider {
  const generateContent = dependencies.generateContent ?? defaultGenerateContent(config);
  const generateContentStream = dependencies.generateContentStream ?? defaultGenerateContentStream(config);
  const descriptor = createModelProviderDescriptor({
    providerId: "gemini",
    modelId: config.modelId,
    supportsToolCalling: true,
    supportsStructuredOutput: true
  });

  return {
    describe: () => descriptor,

    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = toIsoTimestamp();
      const maxAttempts = 1 + Math.max(0, config.maxRetries);
      const params = mapModelRequestToGeminiParams(request, config);

      let raw: RawGeminiResponseLike | undefined;
      let classified: { kind: ModelErrorKind; message: string } | undefined;
      let attempts = 0;

      for (attempts = 1; attempts <= maxAttempts; attempts++) {
        try {
          raw = await generateContent(params);
          classified = undefined;
          break;
        } catch (error) {
          classified = classifyGeminiError(error);
          if (RETRYABLE_KINDS.has(classified.kind) && attempts < maxAttempts) {
            continue;
          }
          break;
        }
      }

      if (classified) {
        return createModelInvocationResult({
          id: createId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: config.modelId,
          sessionId: request.sessionId,
          status: "error",
          error: classified,
          startedAt,
          completedAt: toIsoTimestamp(),
          metadata: { attempts }
        });
      }

      // `raw` is guaranteed defined here: the loop only exits without
      // `classified` set after a successful `generateContent` call.
      return finalizeResult(raw!, request, descriptor, config, startedAt, attempts);
    },

    /**
     * No retry loop here (unlike `generate()`): once a chunk has already
     * been delivered to `onChunk`, silently retrying the whole call over
     * would mean the caller saw text from a first, discarded attempt
     * mixed with a second, real one -- worse than just surfacing the
     * failure. A transient network error mid-stream is reported as a real
     * `status: "error"` result, exactly like a non-retryable `generate()`
     * failure; the caller (chatReply.ts) already handles that uniformly.
     */
    async generateStream(request: ModelRequest, onChunk: (deltaText: string) => void): Promise<ModelInvocationResult> {
      const startedAt = toIsoTimestamp();
      const params = mapModelRequestToGeminiParams(request, config);

      let accumulatedText = "";
      const functionCalls: FunctionCall[] = [];
      try {
        for await (const chunk of await generateContentStream(params)) {
          if (chunk.text) {
            accumulatedText += chunk.text;
            onChunk(chunk.text);
          }
          if (chunk.functionCalls && chunk.functionCalls.length > 0) functionCalls.push(...chunk.functionCalls);
        }
      } catch (error) {
        const classified = classifyGeminiError(error);
        return createModelInvocationResult({
          id: createId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: config.modelId,
          sessionId: request.sessionId,
          status: "error",
          error: classified,
          startedAt,
          completedAt: toIsoTimestamp(),
          metadata: { attempts: 1, streamed: true }
        });
      }

      const raw: RawGeminiResponseLike = { text: accumulatedText || undefined, functionCalls: functionCalls.length > 0 ? functionCalls : undefined };
      return finalizeResult(raw, request, descriptor, config, startedAt, 1);
    }
  };
}
