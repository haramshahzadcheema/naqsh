import { ApiError, GoogleGenAI, type FunctionCall, type GenerateContentConfig, type GenerateContentParameters } from "@google/genai";
import {
  createId,
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  toIsoTimestamp,
  type ModelContext,
  type ModelErrorKind,
  type ModelInvocationResult,
  type ModelRequest,
  type ModelResponseInput
} from "@naqsh/schemas";
import type { ModelProvider } from "@naqsh/core";
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
 * tested at the pure request/response-MAPPING level (see
 * gemini-model-provider.test.ts), but `generate()`'s actual network call
 * has never been exercised end-to-end. Do not treat this as proven working
 * against the real API until it has been.
 */

const AUTH_STATUS_CODES = new Set([401, 403]);

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
  const contents = [contextText, request.instruction].filter((part) => part.length > 0).join("\n\n");

  return {
    model: request.config.modelId || config.modelId,
    contents,
    config: generationConfig
  };
}

/** The minimal shape this provider actually reads off a raw SDK response —
 * a subset of `GenerateContentResponse`, not the whole class, specifically
 * so this function is unit-testable with a hand-built plain object and
 * never needs a live API call to exercise. */
export interface RawGeminiResponseLike {
  text?: string;
  functionCalls?: FunctionCall[];
}

/** Pure: raw Gemini output -> `ModelResponseInput`. Throws a plain `Error`
 * on a shape this provider cannot interpret (neither text nor a function
 * call, or a function call with no name) — `generate()` catches this and
 * turns it into a structured `malformed_response` result; it is never
 * allowed to escape as an unhandled rejection. */
export function mapGeminiResponseToModelResponseInput(raw: RawGeminiResponseLike, requestId: string): ModelResponseInput {
  const call = raw.functionCalls?.[0];
  if (call) {
    if (!call.name) {
      throw new Error("Gemini returned a function call with no name");
    }
    return {
      requestId,
      kind: "tool_call",
      toolCall: { toolName: call.name, arguments: call.args ?? {} }
    };
  }
  if (raw.text !== undefined && raw.text.length > 0) {
    return { requestId, kind: "text", text: raw.text };
  }
  throw new Error("Gemini response contained neither text nor a function call");
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

export function createGeminiModelProvider(config: GeminiProviderConfig): ModelProvider {
  const client = new GoogleGenAI({ apiKey: config.apiKey });
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

      let raw: RawGeminiResponseLike;
      try {
        raw = await client.models.generateContent(mapModelRequestToGeminiParams(request, config));
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
          completedAt: toIsoTimestamp()
        });
      }

      try {
        const response = createModelResponse(mapGeminiResponseToModelResponseInput(raw, request.id));
        return createModelInvocationResult({
          id: createId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: config.modelId,
          sessionId: request.sessionId,
          status: "success",
          response,
          startedAt,
          completedAt: toIsoTimestamp()
        });
      } catch (error) {
        return createModelInvocationResult({
          id: createId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId: config.modelId,
          sessionId: request.sessionId,
          status: "error",
          error: {
            kind: "malformed_response",
            message: error instanceof Error ? error.message : String(error)
          },
          startedAt,
          completedAt: toIsoTimestamp()
        });
      }
    }
  };
}
