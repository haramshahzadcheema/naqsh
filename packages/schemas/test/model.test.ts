import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelContext,
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelRequest,
  createModelRequestConfig,
  createModelResponse,
  createModelToolCallIntent,
  createModelToolDeclaration,
  deserializeModelInvocationResult,
  deserializeModelRequest,
  deserializeModelResponse,
  serializeModelInvocationResult,
  serializeModelRequest,
  serializeModelResponse,
  WorldModelValidationError,
  type ModelRequestInput
} from "../src/index.js";

function buildRequestInput(overrides: Partial<ModelRequestInput> = {}): ModelRequestInput {
  return {
    context: { projectName: "Bracket Study" },
    instruction: "Reduce mass by 20%.",
    config: { modelId: "mock-v1" },
    ...overrides
  };
}

describe("ModelRequestConfig: creation and validation", () => {
  it("creates a config with null defaults for unset generation parameters", () => {
    const config = createModelRequestConfig({ modelId: "mock-v1" });
    assert.equal(config.temperature, null);
    assert.equal(config.maxOutputTokens, null);
    assert.equal(config.timeoutMs, null);
  });

  it("rejects an empty modelId", () => {
    assert.throws(() => createModelRequestConfig({ modelId: "" }), /modelRequestConfig.modelId is required/);
  });

  it("rejects a non-positive maxOutputTokens", () => {
    assert.throws(
      () => createModelRequestConfig({ modelId: "x", maxOutputTokens: 0 }),
      /maxOutputTokens must be a positive integer or null/
    );
  });

  it("rejects a non-integer timeoutMs", () => {
    assert.throws(
      () => createModelRequestConfig({ modelId: "x", timeoutMs: 12.5 }),
      /timeoutMs must be a positive integer or null/
    );
  });
});

describe("ModelToolDeclaration: creation and validation", () => {
  const base = {
    name: "inspect_project",
    description: "d",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    mutation: "observe" as const,
    target: "world_model" as const
  };

  it("creates a valid declaration", () => {
    const declaration = createModelToolDeclaration(base);
    assert.equal(declaration.name, "inspect_project");
  });

  it("rejects an invalid mutation kind", () => {
    assert.throws(
      () => createModelToolDeclaration({ ...base, mutation: "delete" as never }),
      /invalid model tool declaration mutation kind/
    );
  });

  it("rejects an invalid target", () => {
    assert.throws(() => createModelToolDeclaration({ ...base, target: "freecad" as never }), /invalid model tool declaration target/);
  });

  it("rejects a malformed inputSchema", () => {
    assert.throws(
      () => createModelToolDeclaration({ ...base, inputSchema: { type: "bogus" } as never }),
      WorldModelValidationError
    );
  });

  it("freezes the returned declaration", () => {
    const declaration = createModelToolDeclaration(base);
    assert.throws(() => {
      (declaration as { name: string }).name = "renamed";
    }, TypeError);
  });
});

describe("ModelContext: creation and validation", () => {
  it("defaults every field to a bounded, empty value", () => {
    const context = createModelContext();
    assert.equal(context.projectId, null);
    assert.equal(context.requirementCount, 0);
    assert.deepEqual(context.focusObjectIds, []);
    assert.deepEqual(context.metadata, {});
  });

  it("rejects a negative count", () => {
    assert.throws(
      () => createModelContext({ requirementCount: -1 }),
      /requirementCount must be a non-negative integer/
    );
  });

  it("rejects an invalid sessionMode", () => {
    assert.throws(
      () => createModelContext({ sessionMode: "sleeping" as never }),
      /modelContext.sessionMode must be a valid SessionMode or null/
    );
  });

  it("rejects a non-JSON-safe metadata field", () => {
    assert.throws(
      () => createModelContext({ metadata: { onDone: () => {} } as never }),
      /modelContext.metadata must be a JSON-serializable object/
    );
  });
});

describe("ModelRequest: creation, validation, and round-trip", () => {
  it("creates a valid request with defaults", () => {
    const request = createModelRequest(buildRequestInput());
    assert.match(request.id, /^modelreq_/);
    assert.deepEqual(request.tools, []);
    assert.equal(request.outputSchema, null);
    assert.equal(request.sessionId, null);
  });

  it("rejects an empty instruction", () => {
    assert.throws(() => createModelRequest(buildRequestInput({ instruction: "" })), /modelRequest.instruction is required/);
  });

  it("rejects two tools declaring the same name", () => {
    const tool = {
      name: "dup",
      description: "d",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
      mutation: "observe" as const,
      target: "world_model" as const
    };
    assert.throws(
      () => createModelRequest(buildRequestInput({ tools: [tool, tool] })),
      /modelRequest.tools must not declare the same tool name twice/
    );
  });

  it("rejects a malformed outputSchema", () => {
    assert.throws(
      () => createModelRequest(buildRequestInput({ outputSchema: { type: "bogus" } as never })),
      WorldModelValidationError
    );
  });

  it("freezes the returned request", () => {
    const request = createModelRequest(buildRequestInput());
    assert.throws(() => {
      (request as { instruction: string }).instruction = "renamed";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const request = createModelRequest(buildRequestInput());
    assert.deepEqual(deserializeModelRequest(serializeModelRequest(request)), request);
  });

  it("defaults attachments to an empty array", () => {
    const request = createModelRequest(buildRequestInput());
    assert.deepEqual(request.attachments, []);
  });

  it("accepts a valid image attachment", () => {
    const request = createModelRequest(
      buildRequestInput({ attachments: [{ kind: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" }] })
    );
    assert.equal(request.attachments.length, 1);
    assert.equal(request.attachments[0]?.mimeType, "image/png");
  });

  it("rejects an attachment with a disallowed mime type", () => {
    assert.throws(
      () => createModelRequest(buildRequestInput({ attachments: [{ kind: "image", mimeType: "image/gif", dataBase64: "aGVsbG8=" } as never] })),
      /modelAttachment.mimeType must be one of/
    );
  });

  it("rejects an attachment with non-base64 data", () => {
    assert.throws(
      () => createModelRequest(buildRequestInput({ attachments: [{ kind: "image", mimeType: "image/png", dataBase64: "not base64!!" }] })),
      /modelAttachment.dataBase64 must be valid base64/
    );
  });

  it("rejects an attachment exceeding the size bound", () => {
    const oversized = "A".repeat(8_000_001);
    assert.throws(
      () => createModelRequest(buildRequestInput({ attachments: [{ kind: "image", mimeType: "image/png", dataBase64: oversized }] })),
      /exceeds the .*-character bound/
    );
  });

  it("rejects more than 4 attachments", () => {
    const attachment = { kind: "image" as const, mimeType: "image/png", dataBase64: "aGVsbG8=" };
    assert.throws(
      () => createModelRequest(buildRequestInput({ attachments: [attachment, attachment, attachment, attachment, attachment] })),
      /modelRequest.attachments must not exceed 4 entries/
    );
  });

  it("round-trips attachments through JSON with full fidelity", () => {
    const request = createModelRequest(
      buildRequestInput({ attachments: [{ kind: "image", mimeType: "image/jpeg", dataBase64: "aGVsbG8=" }] })
    );
    assert.deepEqual(deserializeModelRequest(serializeModelRequest(request)), request);
  });
});

describe("ModelToolCallIntent: creation and validation", () => {
  it("creates an intent with defaulted arguments", () => {
    const intent = createModelToolCallIntent({ toolName: "inspect_project" });
    assert.deepEqual(intent.arguments, {});
    assert.match(intent.id, /^modelcall_/);
  });

  it("rejects an empty toolName", () => {
    assert.throws(() => createModelToolCallIntent({ toolName: "" }), /modelToolCallIntent.toolName is required/);
  });

  it("rejects non-JSON-safe arguments", () => {
    assert.throws(
      () => createModelToolCallIntent({ toolName: "x", arguments: { fn: () => {} } as never }),
      /modelToolCallIntent.arguments must be a JSON-serializable object/
    );
  });
});

describe("ModelResponse: kind-discriminated creation and validation", () => {
  it("creates a text response", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "text", text: "Hello." });
    assert.equal(response.text, "Hello.");
    assert.equal(response.structuredResult, null);
  });

  it("creates a structured_result response", () => {
    const response = createModelResponse({
      requestId: "req_1",
      kind: "structured_result",
      structuredResult: { ok: true }
    });
    assert.deepEqual(response.structuredResult, { ok: true });
  });

  it("creates a tool_call response with a nested, defaulted intent", () => {
    const response = createModelResponse({
      requestId: "req_1",
      kind: "tool_call",
      toolCall: { toolName: "inspect_project" }
    });
    assert.equal(response.toolCall?.toolName, "inspect_project");
    assert.match(response.toolCall?.id ?? "", /^modelcall_/);
  });

  it("creates a clarification_request response reusing the text field", () => {
    const response = createModelResponse({
      requestId: "req_1",
      kind: "clarification_request",
      text: "Which requirement?"
    });
    assert.equal(response.text, "Which requirement?");
  });

  it("creates an error response", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "error", errorMessage: "I cannot help with that." });
    assert.equal(response.errorMessage, "I cannot help with that.");
  });

  it("rejects kind:'text' with no text", () => {
    assert.throws(
      () => createModelResponse({ requestId: "req_1", kind: "text" }),
      /text must be non-null only when kind is "text" or "clarification_request"/
    );
  });

  it("rejects a response carrying a field that doesn't match its kind", () => {
    assert.throws(
      () =>
        createModelResponse({
          requestId: "req_1",
          kind: "text",
          text: "hi",
          structuredResult: { sneaky: true }
        }),
      /structuredResult must be non-null only when kind is "structured_result"/
    );
  });

  it("freezes the returned response and its nested toolCall", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "tool_call", toolCall: { toolName: "x" } });
    assert.throws(() => {
      (response as { text: string | null }).text = "mutated";
    }, TypeError);
    assert.throws(() => {
      (response.toolCall as { toolName: string }).toolName = "mutated";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const response = createModelResponse({
      requestId: "req_1",
      kind: "tool_call",
      toolCall: { toolName: "inspect_project", arguments: { projectId: "proj_1" } }
    });
    assert.deepEqual(deserializeModelResponse(serializeModelResponse(response)), response);
  });
});

describe("ModelInvocationResult: creation, validation, and round-trip", () => {
  it("creates a success result with a null error", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "text", text: "hi" });
    const result = createModelInvocationResult({
      requestId: "req_1",
      providerId: "mock",
      modelId: "mock-v1",
      status: "success",
      response,
      startedAt: new Date().toISOString()
    });
    assert.equal(result.error, null);
    assert.match(result.id, /^modelinv_/);
  });

  it("rejects a success result carrying a non-null error", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "text", text: "hi" });
    assert.throws(
      () =>
        createModelInvocationResult({
          requestId: "req_1",
          providerId: "mock",
          modelId: "mock-v1",
          status: "success",
          response,
          error: { kind: "provider_error", message: "x" },
          startedAt: new Date().toISOString()
        }),
      /modelInvocationResult.error must be null when status is success/
    );
  });

  it("rejects an error result carrying a non-null response", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "text", text: "hi" });
    assert.throws(
      () =>
        createModelInvocationResult({
          requestId: "req_1",
          providerId: "mock",
          modelId: "mock-v1",
          status: "error",
          response,
          error: { kind: "provider_error", message: "x" },
          startedAt: new Date().toISOString()
        }),
      /modelInvocationResult.response must be null when status is error/
    );
  });

  it("requires a validly-kinded error for an error result", () => {
    assert.throws(
      () =>
        createModelInvocationResult({
          requestId: "req_1",
          providerId: "mock",
          modelId: "mock-v1",
          status: "error",
          startedAt: new Date().toISOString()
        }),
      /model invocation error must be an object/
    );
  });

  it("round-trips through JSON with full fidelity", () => {
    const response = createModelResponse({ requestId: "req_1", kind: "text", text: "hi" });
    const result = createModelInvocationResult({
      requestId: "req_1",
      providerId: "mock",
      modelId: "mock-v1",
      sessionId: "sess_1",
      status: "success",
      response,
      startedAt: new Date().toISOString()
    });
    assert.deepEqual(deserializeModelInvocationResult(serializeModelInvocationResult(result)), result);
  });
});

describe("ModelProviderDescriptor: creation and validation", () => {
  it("creates a descriptor with capability defaults of false", () => {
    const descriptor = createModelProviderDescriptor({ providerId: "mock", modelId: "mock-v1" });
    assert.equal(descriptor.supportsToolCalling, false);
    assert.equal(descriptor.supportsStructuredOutput, false);
  });

  it("rejects an empty providerId", () => {
    assert.throws(
      () => createModelProviderDescriptor({ providerId: "", modelId: "mock-v1" }),
      /modelProviderDescriptor.providerId is required/
    );
  });
});
