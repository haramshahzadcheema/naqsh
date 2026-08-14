import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "@google/genai";
import { createModelContext, createModelRequest, type ModelContext } from "@naqsh/schemas";
import {
  classifyGeminiError,
  createGeminiModelProvider,
  mapGeminiResponseToModelResponseInput,
  mapModelRequestToGeminiParams,
  summarizeContextForPrompt
} from "../src/gemini-model-provider.js";
import type { GeminiProviderConfig } from "../src/config.js";

// NOTE: No credentials are configured in this environment (confirmed --
// no GEMINI_API_KEY, no .env). Every test in this file is either
// construction-only (never calls generateContent) or exercises a PURE
// mapping function with hand-built fake data. None of these tests make a
// network call, and none of them prove the provider works against the
// live Gemini API.

const fakeConfig: GeminiProviderConfig = {
  apiKey: "fake-key-for-construction-tests-only",
  modelId: "gemini-2.5-flash",
  timeoutMs: 30000,
  maxRetries: 2
};

describe("createGeminiModelProvider: construction only, never calls the network", () => {
  it("constructs without throwing given a well-formed config", () => {
    assert.doesNotThrow(() => createGeminiModelProvider(fakeConfig));
  });

  it("describe() reflects the configured model, synchronously, before any network call", () => {
    const provider = createGeminiModelProvider(fakeConfig);
    const descriptor = provider.describe();
    assert.equal(descriptor.providerId, "gemini");
    assert.equal(descriptor.modelId, "gemini-2.5-flash");
    assert.equal(descriptor.supportsToolCalling, true);
  });
});

describe("summarizeContextForPrompt: pure, deterministic context -> text", () => {
  it("produces the same text for the same context every time", () => {
    const context: ModelContext = createModelContext({
      projectName: "Bracket Study",
      projectSummary: "A load-bearing bracket redesign.",
      requirementCount: 3,
      constraintCount: 1,
      objectCount: 2,
      decisionCount: 0
    });
    assert.equal(summarizeContextForPrompt(context), summarizeContextForPrompt(context));
    assert.match(summarizeContextForPrompt(context), /Bracket Study/);
    assert.match(summarizeContextForPrompt(context), /Requirements: 3/);
  });

  it("omits absent fields rather than printing 'null'", () => {
    const context = createModelContext({});
    const text = summarizeContextForPrompt(context);
    assert.doesNotMatch(text, /null/);
  });
});

describe("mapModelRequestToGeminiParams: pure request mapping", () => {
  it("maps model id, instruction, and generation config", () => {
    const request = createModelRequest({
      context: { projectName: "Bracket Study" },
      instruction: "Reduce mass by 20%.",
      config: { modelId: "gemini-2.5-flash", temperature: 0.2, maxOutputTokens: 512 }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.equal(params.model, "gemini-2.5-flash");
    assert.match(params.contents as string, /Reduce mass by 20%/);
    assert.equal(params.config?.temperature, 0.2);
    assert.equal(params.config?.maxOutputTokens, 512);
  });

  it("declares tools via functionDeclarations using the schema bridge, and includes no tools entry when none are declared", () => {
    const withTools = createModelRequest({
      context: {},
      instruction: "x",
      tools: [
        {
          name: "inspect_project",
          description: "d",
          inputSchema: { type: "object", properties: {}, required: [] },
          mutation: "observe",
          target: "world_model"
        }
      ],
      config: { modelId: "gemini-2.5-flash" }
    });
    const paramsWithTools = mapModelRequestToGeminiParams(withTools, fakeConfig);
    assert.equal(paramsWithTools.config?.tools?.length, 1);

    const withoutTools = createModelRequest({ context: {}, instruction: "x", config: { modelId: "gemini-2.5-flash" } });
    const paramsWithoutTools = mapModelRequestToGeminiParams(withoutTools, fakeConfig);
    assert.equal(paramsWithoutTools.config?.tools, undefined);
  });

  it("sets responseMimeType/responseJsonSchema only when an outputSchema is provided", () => {
    const request = createModelRequest({
      context: {},
      instruction: "x",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "gemini-2.5-flash" }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.equal(params.config?.responseMimeType, "application/json");
    assert.deepEqual(params.config?.responseJsonSchema, request.outputSchema);
  });
});

describe("mapGeminiResponseToModelResponseInput: pure response mapping, no network", () => {
  it("maps a plain text response", () => {
    const mapped = mapGeminiResponseToModelResponseInput({ text: "The mass is 340g." }, "req_1");
    assert.equal(mapped.kind, "text");
    assert.equal(mapped.text, "The mass is 340g.");
    assert.equal(mapped.requestId, "req_1");
  });

  it("maps a function-call response into a tool_call", () => {
    const mapped = mapGeminiResponseToModelResponseInput(
      { functionCalls: [{ name: "inspect_project", args: { projectId: "proj_1" } }] },
      "req_1"
    );
    assert.equal(mapped.kind, "tool_call");
    assert.equal(mapped.toolCall?.toolName, "inspect_project");
    assert.deepEqual(mapped.toolCall?.arguments, { projectId: "proj_1" });
  });

  it("prefers a function call over text when both are somehow present", () => {
    const mapped = mapGeminiResponseToModelResponseInput(
      { text: "ignored", functionCalls: [{ name: "x", args: {} }] },
      "req_1"
    );
    assert.equal(mapped.kind, "tool_call");
  });

  it("throws on a response with neither text nor a function call -- caught by generate(), never silently accepted", () => {
    assert.throws(() => mapGeminiResponseToModelResponseInput({}, "req_1"));
  });

  it("throws on a function call with no name", () => {
    assert.throws(() => mapGeminiResponseToModelResponseInput({ functionCalls: [{ args: {} }] }, "req_1"));
  });
});

describe("classifyGeminiError: pure error classification, no network", () => {
  it("classifies 401/403 as authentication_failure", () => {
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 401 })).kind, "authentication_failure");
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 403 })).kind, "authentication_failure");
  });

  it("classifies 429 as rate_limit", () => {
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 429 })).kind, "rate_limit");
  });

  it("classifies 408/504 as timeout", () => {
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 408 })).kind, "timeout");
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 504 })).kind, "timeout");
  });

  it("classifies 5xx as api_unavailable", () => {
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 503 })).kind, "api_unavailable");
  });

  it("classifies an unrecognized ApiError status as provider_error", () => {
    assert.equal(classifyGeminiError(new ApiError({ message: "x", status: 418 })).kind, "provider_error");
  });

  it("classifies an AbortError as timeout", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    assert.equal(classifyGeminiError(abortError).kind, "timeout");
  });

  it("classifies an unrecognized error as provider_error rather than crashing", () => {
    assert.equal(classifyGeminiError("not even an Error instance").kind, "provider_error");
    assert.equal(classifyGeminiError(new Error("something else")).kind, "provider_error");
  });
});
