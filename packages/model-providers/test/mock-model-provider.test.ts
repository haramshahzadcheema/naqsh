import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelRequest, type ModelResponse } from "@naqsh/schemas";
import { runModelProviderContractTests } from "@naqsh/core";
import { createMockModelProvider } from "../src/mock-model-provider.js";

// Reuses the EXACT P5/P7 contract-test pattern -- the same suite intended
// to eventually run against createGeminiModelProvider once live
// credentials exist.
runModelProviderContractTests("mock", () => createMockModelProvider());

function textRequest(instruction: string, tools: NonNullable<Parameters<typeof createModelRequest>[0]["tools"]> = []) {
  return createModelRequest({
    context: {},
    instruction,
    tools,
    config: { modelId: "mock-v1" }
  });
}

describe("Mock model provider: identity", () => {
  it("identifies itself as 'mock', not a stand-in for a real provider", () => {
    const provider = createMockModelProvider();
    const descriptor = provider.describe();
    assert.equal(descriptor.providerId, "mock");
    assert.equal(descriptor.supportsToolCalling, true);
    assert.equal(descriptor.supportsStructuredOutput, true);
  });

  it("honors a custom modelId", () => {
    const provider = createMockModelProvider({ modelId: "mock-v2" });
    assert.equal(provider.describe().modelId, "mock-v2");
  });
});

describe("Mock model provider: default responder", () => {
  it("returns a text acknowledgment when no declared tool is mentioned", async () => {
    const provider = createMockModelProvider();
    const result = await provider.generate(textRequest("What is the mass of the bracket?"));
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "text");
    assert.match(result.response?.text ?? "", /What is the mass/);
  });

  it("returns a tool_call when the instruction names a declared tool", async () => {
    const provider = createMockModelProvider();
    const request = textRequest("Please call inspect_project now.", [
      {
        name: "inspect_project",
        description: "Inspect the project",
        inputSchema: { type: "object", properties: {}, required: [] },
        mutation: "observe",
        target: "world_model"
      }
    ]);
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "tool_call");
    assert.equal(result.response?.toolCall?.toolName, "inspect_project");
  });
});

describe("Mock model provider: deterministic by default", () => {
  it("two independent instances given the identical request produce identical results", async () => {
    const request = textRequest("Summarize the project.");
    const resultA = await createMockModelProvider().generate(request);
    const resultB = await createMockModelProvider().generate(request);
    assert.deepEqual(resultA, resultB);
  });

  it("two independent instances do not share id/clock counters", async () => {
    const providerA = createMockModelProvider();
    const providerB = createMockModelProvider();
    await providerA.generate(textRequest("First"));
    await providerA.generate(textRequest("Second"));
    const resultB = await providerB.generate(textRequest("First-in-B"));
    assert.ok(resultB.id.endsWith("0001"), "provider B's counter must start fresh");
  });
});

describe("Mock model provider: configurable respond callback", () => {
  it("lets a test control the exact response returned", async () => {
    const provider = createMockModelProvider({
      respond: () => ({ response: { kind: "clarification_request", text: "Which requirement do you mean?" } })
    });
    const result = await provider.generate(textRequest("Update the requirement."));
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "clarification_request");
    assert.equal(result.response?.text, "Which requirement do you mean?");
  });

  it("lets a test simulate a provider-level error explicitly, never throwing", async () => {
    const provider = createMockModelProvider({
      respond: () => ({ error: { kind: "rate_limit", message: "simulated rate limit" } })
    });
    const result = await provider.generate(textRequest("Anything"));
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "rate_limit");
  });

  it("converts an exception thrown by respond() into a structured error result, never rejecting", async () => {
    const provider = createMockModelProvider({
      respond: () => {
        throw new Error("boom");
      }
    });
    let result;
    try {
      result = await provider.generate(textRequest("Anything"));
    } catch {
      assert.fail("generate() must never reject even when respond() throws");
    }
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "provider_error");
  });

  it("converts a malformed response shape (kind mismatch) into a structured error result, never throwing", async () => {
    const provider = createMockModelProvider({
      // A shape createModelResponse's own validator must reject: kind
      // "text" but no text supplied.
      respond: () => ({ response: { kind: "text" } as never })
    });
    let result;
    try {
      result = await provider.generate(textRequest("Anything"));
    } catch {
      assert.fail("generate() must never throw for a malformed response shape");
    }
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "schema_validation_failed");
  });

  it("rejects a structured_result response that is JSON-safe but does NOT match the request's outputSchema", async () => {
    const provider = createMockModelProvider({
      // JSON-safe, and a valid ModelResponse shape on its own -- but the
      // request asked for {ok: boolean} and this returns {ok: "yes"}.
      respond: () => ({ response: { kind: "structured_result", structuredResult: { ok: "yes" } } })
    });
    const request = createModelRequest({
      context: {},
      instruction: "Report status as structured JSON.",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "mock-v1" }
    });

    let result;
    try {
      result = await provider.generate(request);
    } catch {
      assert.fail("generate() must never throw for a schema-mismatched structured_result");
    }
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "schema_validation_failed");
  });

  it("accepts a structured_result response that DOES match the request's outputSchema", async () => {
    const provider = createMockModelProvider({
      respond: () => ({ response: { kind: "structured_result", structuredResult: { ok: true } } })
    });
    const request = createModelRequest({
      context: {},
      instruction: "Report status as structured JSON.",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      config: { modelId: "mock-v1" }
    });
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    assert.deepEqual(result.response?.structuredResult, { ok: true });
  });
});

describe("Mock model provider: security boundary -- Gemini cannot directly mutate state", () => {
  it("a tool_call response is inert data, not a live function reference", async () => {
    const provider = createMockModelProvider({
      respond: () => ({ response: { kind: "tool_call", toolCall: { toolName: "delete_project", arguments: { id: "x" } } } })
    });
    const result = await provider.generate(
      textRequest("Delete everything.", [
        {
          name: "delete_project",
          description: "x",
          inputSchema: { type: "object", properties: {}, required: [] },
          mutation: "mutate",
          target: "world_model"
        }
      ])
    );
    assert.equal(result.status, "success");
    const response = result.response as ModelResponse;
    // The intent is a plain, JSON-safe data record -- nothing here is a
    // function, and nothing about calling generate() executed anything.
    assert.equal(typeof response.toolCall, "object");
    assert.equal(typeof (response.toolCall as unknown as Record<string, unknown>).arguments, "object");
    assert.doesNotThrow(() => JSON.stringify(response));
  });
});
