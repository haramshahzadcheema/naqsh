import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  type ModelInvocationResult,
  type ModelErrorKind,
  type ModelRequest,
  type ModelResponseInput
} from "@naqsh/schemas";
import { validateStructuredResult, type ModelProvider } from "@naqsh/core";
import { createDeterministicClock, createDeterministicIdGenerator } from "./deterministic.js";

/** What a `respond` callback returns for one `generate()` call: either the
 * response the mock should produce, or a simulated PROVIDER-level failure
 * (never a thrown exception — see `createMockModelProvider`'s doc comment).
 * `requestId` is omitted from `response` -- `generate()` fills it in from
 * the actual request, so a `respond` callback can't (and doesn't need to)
 * supply a value that must always match the request it was called with. */
export type MockModelOutcome =
  | { response: Omit<ModelResponseInput, "requestId"> }
  | { error: { kind: ModelErrorKind; message: string } };

export type MockModelResponder = (request: ModelRequest) => MockModelOutcome;

export interface MockModelProviderOptions {
  modelId?: string;
  /** Called once per `generate()` invocation to decide what that call
   * returns. Defaults to `defaultMockResponder` (see below) — a simple,
   * deterministic rule, not a language model. Tests that need to exercise
   * a SPECIFIC response shape (a tool call, a clarification request, a
   * simulated timeout, ...) should supply their own. */
  respond?: MockModelResponder;
  generateId?: (prefix: string) => string;
  now?: () => string;
}

/**
 * If the instruction names a declared tool, emit a tool-call intent for it
 * with empty arguments; otherwise emit a plain acknowledgment. Exists only
 * so the mock is usable with zero configuration — real test coverage of
 * specific behaviors (tool calls with real arguments, clarification
 * requests, structured results, simulated errors) should supply an
 * explicit `respond` instead of relying on this default.
 */
function defaultMockResponder(request: ModelRequest): MockModelOutcome {
  const mentioned = request.tools.find((tool) => request.instruction.toLowerCase().includes(tool.name.toLowerCase()));
  if (mentioned) {
    return { response: { kind: "tool_call", toolCall: { toolName: mentioned.name, arguments: {} } } };
  }
  return { response: { kind: "text", text: `Acknowledged: ${request.instruction}` } };
}

/**
 * A deterministic, network-free `ModelProvider` (P7 brief §12/§13): no
 * `@google/genai` import, no HTTP call, no wall-clock/random ids by
 * default. Exists so every other layer (context building, tool-call
 * validation, the P4/P3 execution boundary) can be tested without live
 * Gemini credentials, and so this repository stays fully testable without
 * external API access.
 *
 * `generate()` never throws: `respond` is called inside a try/catch, and
 * both an uncaught exception from `respond` and an explicit `{error}`
 * outcome become a structured `ModelInvocationResult` with `status:
 * "error"` — the same "never throw for an expected failure" discipline
 * `EnvironmentAdapter`'s in-memory engine was fixed to follow after the P6
 * audit found it violated for malformed input.
 */
export function createMockModelProvider(options: MockModelProviderOptions = {}): ModelProvider {
  const modelId = options.modelId ?? "mock-v1";
  const respond = options.respond ?? defaultMockResponder;
  const generateId = options.generateId ?? createDeterministicIdGenerator();
  const now = options.now ?? createDeterministicClock();

  const descriptor = createModelProviderDescriptor({
    providerId: "mock",
    modelId,
    supportsToolCalling: true,
    supportsStructuredOutput: true
  });

  return {
    describe: () => descriptor,

    async generate(request: ModelRequest): Promise<ModelInvocationResult> {
      const startedAt = now();
      let outcome: MockModelOutcome;
      try {
        outcome = respond(request);
      } catch (error) {
        return createModelInvocationResult({
          id: generateId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId,
          sessionId: request.sessionId,
          status: "error",
          error: { kind: "provider_error", message: error instanceof Error ? error.message : String(error) },
          startedAt,
          completedAt: now()
        });
      }

      if ("error" in outcome) {
        return createModelInvocationResult({
          id: generateId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId,
          sessionId: request.sessionId,
          status: "error",
          error: outcome.error,
          startedAt,
          completedAt: now()
        });
      }

      try {
        const toolCall = outcome.response.toolCall
          ? { ...outcome.response.toolCall, id: outcome.response.toolCall.id ?? generateId("modelcall") }
          : undefined;
        const response = createModelResponse({
          ...outcome.response,
          toolCall,
          id: generateId("modelresp"),
          requestId: request.id,
          createdAt: now()
        });
        const schemaErrors = validateStructuredResult(response, request);
        if (schemaErrors.length > 0) {
          return createModelInvocationResult({
            id: generateId("modelinv"),
            requestId: request.id,
            providerId: descriptor.providerId,
            modelId,
            sessionId: request.sessionId,
            status: "error",
            error: { kind: "schema_validation_failed", message: schemaErrors.join("; ") },
            startedAt,
            completedAt: now()
          });
        }
        return createModelInvocationResult({
          id: generateId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId,
          sessionId: request.sessionId,
          status: "success",
          response,
          startedAt,
          completedAt: now()
        });
      } catch (error) {
        return createModelInvocationResult({
          id: generateId("modelinv"),
          requestId: request.id,
          providerId: descriptor.providerId,
          modelId,
          sessionId: request.sessionId,
          status: "error",
          error: {
            kind: "schema_validation_failed",
            message: error instanceof Error ? error.message : String(error)
          },
          startedAt,
          completedAt: now()
        });
      }
    }
  };
}
