import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "@google/genai";
import { createModelContext, createModelRequest, ModelError, type ModelContext } from "@naqsh/schemas";
import {
  classifyGeminiError,
  createGeminiModelProvider,
  mapGeminiResponseToModelResponseInput,
  mapModelRequestToGeminiParams,
  summarizeContextForPrompt,
  type RawGeminiResponseLike
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
  modelId: "gemini-3.5-flash",
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
    assert.equal(descriptor.modelId, "gemini-3.5-flash");
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
      config: { modelId: "gemini-3.5-flash", temperature: 0.2, maxOutputTokens: 512 }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.equal(params.model, "gemini-3.5-flash");
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
      config: { modelId: "gemini-3.5-flash" }
    });
    const paramsWithTools = mapModelRequestToGeminiParams(withTools, fakeConfig);
    assert.equal(paramsWithTools.config?.tools?.length, 1);

    const withoutTools = createModelRequest({ context: {}, instruction: "x", config: { modelId: "gemini-3.5-flash" } });
    const paramsWithoutTools = mapModelRequestToGeminiParams(withoutTools, fakeConfig);
    assert.equal(paramsWithoutTools.config?.tools, undefined);
  });

  it("sets responseMimeType/responseJsonSchema only when an outputSchema is provided", () => {
    const request = createModelRequest({
      context: {},
      instruction: "x",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "gemini-3.5-flash" }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.equal(params.config?.responseMimeType, "application/json");
    assert.deepEqual(params.config?.responseJsonSchema, request.outputSchema);
  });

  it("keeps contents a plain string when there are no attachments (unchanged pre-P22 shape)", () => {
    const request = createModelRequest({ context: {}, instruction: "x", config: { modelId: "gemini-3.5-flash" } });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.equal(typeof params.contents, "string");
  });

  it("switches contents to a Content[] with an inlineData part per attachment", () => {
    const request = createModelRequest({
      context: { projectName: "Bracket Study" },
      instruction: "What do you see in this view?",
      attachments: [{ kind: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" }],
      config: { modelId: "gemini-3.5-flash" }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    assert.ok(Array.isArray(params.contents));
    const content = (params.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>)[0];
    assert.ok(content);
    assert.equal(content.role, "user");
    assert.ok(content.parts.some((part) => typeof part.text === "string" && /What do you see/.test(part.text as string)));
    assert.deepEqual(
      content.parts.find((part) => "inlineData" in part)?.inlineData,
      { mimeType: "image/png", data: "aGVsbG8=" }
    );
  });

  it("maps multiple attachments to multiple inlineData parts, in order", () => {
    const request = createModelRequest({
      context: {},
      instruction: "x",
      attachments: [
        { kind: "image", mimeType: "image/png", dataBase64: "aGVsbG8=" },
        { kind: "image", mimeType: "image/jpeg", dataBase64: "d29ybGQ=" }
      ],
      config: { modelId: "gemini-3.5-flash" }
    });
    const params = mapModelRequestToGeminiParams(request, fakeConfig);
    const content = (params.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0];
    assert.ok(content);
    const inlineDataParts = content.parts.filter((part) => "inlineData" in part);
    assert.equal(inlineDataParts.length, 2);
    assert.ok(inlineDataParts[0]);
    assert.ok(inlineDataParts[1]);
    assert.deepEqual((inlineDataParts[0] as { inlineData: unknown }).inlineData, { mimeType: "image/png", data: "aGVsbG8=" });
    assert.deepEqual((inlineDataParts[1] as { inlineData: unknown }).inlineData, { mimeType: "image/jpeg", data: "d29ybGQ=" });
  });
});

describe("mapGeminiResponseToModelResponseInput: pure response mapping, no network", () => {
  function req(outputSchema?: Parameters<typeof createModelRequest>[0]["outputSchema"]): ReturnType<typeof createModelRequest> {
    return createModelRequest({
      id: "req_1",
      context: {},
      instruction: "x",
      outputSchema,
      config: { modelId: "gemini-3.5-flash" }
    });
  }

  it("maps a plain text response when no outputSchema was requested", () => {
    const mapped = mapGeminiResponseToModelResponseInput({ text: "The mass is 340g." }, req());
    assert.equal(mapped.kind, "text");
    assert.equal(mapped.text, "The mass is 340g.");
    assert.equal(mapped.requestId, "req_1");
  });

  it("maps a function-call response into a tool_call", () => {
    const mapped = mapGeminiResponseToModelResponseInput(
      { functionCalls: [{ name: "inspect_project", args: { projectId: "proj_1" } }] },
      req()
    );
    assert.equal(mapped.kind, "tool_call");
    assert.equal(mapped.toolCall?.toolName, "inspect_project");
    assert.deepEqual(mapped.toolCall?.arguments, { projectId: "proj_1" });
  });

  it("prefers a function call over text when both are somehow present", () => {
    const mapped = mapGeminiResponseToModelResponseInput({ text: "ignored", functionCalls: [{ name: "x", args: {} }] }, req());
    assert.equal(mapped.kind, "tool_call");
  });

  it("throws ModelError(malformed_response) on a response with neither text nor a function call -- caught by generate(), never silently accepted", () => {
    assert.throws(() => mapGeminiResponseToModelResponseInput({}, req()), (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.kind, "malformed_response");
      return true;
    });
  });

  it("throws ModelError(tool_call_schema_failure) on a function call with no name", () => {
    assert.throws(() => mapGeminiResponseToModelResponseInput({ functionCalls: [{ args: {} }] }, req()), (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.kind, "tool_call_schema_failure");
      return true;
    });
  });

  it("throws ModelError(tool_call_schema_failure) on a function call with non-object arguments", () => {
    assert.throws(
      () => mapGeminiResponseToModelResponseInput({ functionCalls: [{ name: "x", args: ["not", "an", "object"] as never }] }, req()),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.kind, "tool_call_schema_failure");
        return true;
      }
    );
  });

  it("accepts a function call with no args at all (defaults to {})", () => {
    const mapped = mapGeminiResponseToModelResponseInput({ functionCalls: [{ name: "list_objects" }] }, req());
    assert.equal(mapped.kind, "tool_call");
    assert.deepEqual(mapped.toolCall?.arguments, {});
  });

  it("throws ModelError(unexpected_output) when Gemini returns MULTIPLE function calls in one turn -- never silently keeps only the first", () => {
    assert.throws(
      () =>
        mapGeminiResponseToModelResponseInput(
          { functionCalls: [{ name: "delete_object", args: { id: "a" } }, { name: "delete_object", args: { id: "b" } }] },
          req()
        ),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.kind, "unexpected_output");
        return true;
      }
    );
  });

  describe("structured output: when request.outputSchema is set, text becomes structured_result, not text", () => {
    const outputSchema = { type: "object" as const, properties: { ok: { type: "boolean" as const } }, required: ["ok"] };

    it("parses JSON text into a structured_result response", () => {
      const mapped = mapGeminiResponseToModelResponseInput({ text: '{"ok": true}' }, req(outputSchema));
      assert.equal(mapped.kind, "structured_result");
      assert.deepEqual(mapped.structuredResult, { ok: true });
      assert.equal(mapped.text, undefined);
    });

    it("throws malformed_response when the text is not valid JSON", () => {
      assert.throws(() => mapGeminiResponseToModelResponseInput({ text: "not json at all" }, req(outputSchema)), (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.kind, "malformed_response");
        return true;
      });
    });

    it("throws malformed_response when the JSON parses to an array or primitive, not an object", () => {
      assert.throws(() => mapGeminiResponseToModelResponseInput({ text: "[1,2,3]" }, req(outputSchema)), (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.kind, "malformed_response");
        return true;
      });
      assert.throws(() => mapGeminiResponseToModelResponseInput({ text: "42" }, req(outputSchema)));
    });

    it("does NOT affect a tool_call response even when outputSchema is set", () => {
      const mapped = mapGeminiResponseToModelResponseInput({ functionCalls: [{ name: "x", args: {} }] }, req(outputSchema));
      assert.equal(mapped.kind, "tool_call");
    });
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

describe("createGeminiModelProvider: generate() control flow with an injected fake network call", () => {
  // These tests exercise generate()'s actual orchestration (including the
  // retry loop) via the injectable `generateContent` dependency -- no
  // network call, no real GoogleGenAI client construction, fully
  // deterministic. This is what closes the gap left by the
  // construction-only / pure-mapping-only tests above: before this, the
  // retry logic had zero test coverage.
  function textOnlyRequest(): ReturnType<typeof createModelRequest> {
    return createModelRequest({ context: {}, instruction: "hi", config: { modelId: "gemini-3.5-flash" } });
  }

  it("succeeds on the first attempt when generateContent succeeds -- attempts recorded as 1", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContent: async () => {
        calls++;
        return { text: "hello" };
      }
    });
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "success");
    assert.equal(calls, 1);
    assert.equal(result.metadata.attempts, 1);
  });

  it("retries a retryable failure (rate_limit) and succeeds on a later attempt", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(
      { ...fakeConfig, maxRetries: 2 },
      {
        generateContent: async () => {
          calls++;
          if (calls < 3) {
            throw new ApiError({ message: "rate limited", status: 429 });
          }
          return { text: "third time's the charm" };
        }
      }
    );
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "success");
    assert.equal(calls, 3);
    assert.equal(result.metadata.attempts, 3);
  });

  it("stops after maxRetries is exhausted and returns the last classified error", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(
      { ...fakeConfig, maxRetries: 2 },
      {
        generateContent: async () => {
          calls++;
          throw new ApiError({ message: "still limited", status: 429 });
        }
      }
    );
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "rate_limit");
    assert.equal(calls, 3, "1 initial attempt + 2 retries = 3 calls");
    assert.equal(result.metadata.attempts, 3);
  });

  it("does NOT retry a non-retryable failure (authentication_failure) -- fails immediately", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(
      { ...fakeConfig, maxRetries: 3 },
      {
        generateContent: async () => {
          calls++;
          throw new ApiError({ message: "bad key", status: 401 });
        }
      }
    );
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "authentication_failure");
    assert.equal(calls, 1, "a non-retryable error must not be retried");
    assert.equal(result.metadata.attempts, 1);
  });

  it("maxRetries: 0 means exactly one attempt, no retries", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(
      { ...fakeConfig, maxRetries: 0 },
      {
        generateContent: async () => {
          calls++;
          throw new ApiError({ message: "limited", status: 429 });
        }
      }
    );
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "error");
    assert.equal(calls, 1);
  });

  it("a malformed response shape is never retried (only network-level failures are)", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(
      { ...fakeConfig, maxRetries: 3 },
      {
        generateContent: async (): Promise<RawGeminiResponseLike> => {
          calls++;
          return {};
        }
      }
    );
    const result = await provider.generate(textOnlyRequest());
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "malformed_response");
    assert.equal(calls, 1, "a successfully-returned-but-malformed response must not trigger a retry");
  });

  it("end-to-end: requesting structured output and getting a schema-conforming reply succeeds as kind:structured_result", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContent: async () => {
        calls++;
        return { text: JSON.stringify({ ok: true }) };
      }
    });
    const request = createModelRequest({
      context: {},
      instruction: "status",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "gemini-3.5-flash" }
    });
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "structured_result");
    assert.deepEqual(result.response?.structuredResult, { ok: true });
    assert.equal(calls, 1);
  });

  it("end-to-end: requesting structured output and getting a schema-VIOLATING reply is rejected with schema_validation_failed, never retried", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContent: async () => {
        calls++;
        // Valid JSON, valid object -- but "ok" is a string, not a boolean.
        return { text: JSON.stringify({ ok: "not-a-boolean" }) };
      }
    });
    const request = createModelRequest({
      context: {},
      instruction: "status",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "gemini-3.5-flash" }
    });
    const result = await provider.generate(request);
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "schema_validation_failed");
    assert.equal(calls, 1, "a schema-violating (but successfully-returned) reply must not trigger a retry");
  });

  it("a plain text reply still succeeds as kind:text when no outputSchema was requested", async () => {
    let calls = 0;
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContent: async () => {
        calls++;
        return { text: "hello there" };
      }
    });
    const request = createModelRequest({ context: {}, instruction: "status", config: { modelId: "gemini-3.5-flash" } });
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "text");
    assert.equal(calls, 1);
  });
});

describe("createGeminiModelProvider: generateStream() with an injected fake async-iterable", () => {
  // Same no-network discipline as the generate() control-flow suite above:
  // `generateContentStream` is injected as a fake async generator, never a
  // live call.
  function textOnlyRequest(): ReturnType<typeof createModelRequest> {
    return createModelRequest({ context: {}, instruction: "hi", config: { modelId: "gemini-3.5-flash" } });
  }

  async function* fakeChunks(...texts: string[]): AsyncGenerator<RawGeminiResponseLike> {
    for (const text of texts) yield { text };
  }

  it("declares generateStream as a real function on the provider (feature-detectable by callers)", () => {
    const provider = createGeminiModelProvider(fakeConfig);
    assert.equal(typeof provider.generateStream, "function");
  });

  it("delivers each chunk to onChunk as it arrives, and resolves to the SAME final result shape generate() would produce", async () => {
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContentStream: async () => fakeChunks("Hello", ", ", "world.")
    });
    const received: string[] = [];
    const result = await provider.generateStream!(textOnlyRequest(), (delta) => received.push(delta));
    assert.deepEqual(received, ["Hello", ", ", "world."]);
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "text");
    assert.equal(result.response?.text, "Hello, world.");
  });

  it("a mid-stream network failure resolves to a real error result -- onChunk received whatever arrived before the failure, but nothing is silently retried", async () => {
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContentStream: async () => {
        // eslint-disable-next-line require-yield
        async function* failing(): AsyncGenerator<RawGeminiResponseLike> {
          yield { text: "partial" };
          throw new ApiError({ message: "connection reset", status: 500 });
        }
        return failing();
      }
    });
    const received: string[] = [];
    const result = await provider.generateStream!(textOnlyRequest(), (delta) => received.push(delta));
    assert.deepEqual(received, ["partial"]);
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "api_unavailable");
  });

  it("structured-output validation still applies to the ACCUMULATED streamed text, exactly like generate()", async () => {
    const provider = createGeminiModelProvider(fakeConfig, {
      generateContentStream: async () => fakeChunks('{"ok":', " true}")
    });
    const request = createModelRequest({
      context: {},
      instruction: "status",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "gemini-3.5-flash" }
    });
    const result = await provider.generateStream!(request, () => {});
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "structured_result");
    assert.deepEqual(result.response?.structuredResult, { ok: true });
  });
});
