import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelRequest,
  createModelProviderDescriptor,
  createModelResponse,
  createModelInvocationResult,
  createWorldModelState,
  createTool,
  type ModelResponse,
  type ObservationResult
} from "@naqsh/schemas";
import {
  runModelProviderContractTests,
  generatePlanProposal,
  generateProposal,
  generateDesignSpecification,
  interpretRequirementFromText,
  observeProject,
  createToolRegistry,
  validateStructuredResult,
  type ModelProvider,
  type ToolRegistry
} from "@naqsh/core";
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

describe("AUDIT FIX regression: the SHIPPED DEFAULT responder (no custom respond callback) genuinely satisfies outputSchema-bearing requests", () => {
  // The bug this closes: the default responder used to ALWAYS return
  // kind: "text" (or "tool_call") no matter what outputSchema asked for --
  // so selecting createMockModelProvider() with zero configuration for any
  // structured-output request (every real Plan/Proposal/Requirement call)
  // failed immediately with a "wrong response kind" error. These tests
  // deliberately use createMockModelProvider() with NO custom respond,
  // exercising exactly the code path a judge selecting "Deterministic
  // (testing)" in the live app actually reaches -- not a hand-built test
  // responder that could pass even if the real default were still broken.

  it("returns kind: 'structured_result' (not 'text') for a request carrying an outputSchema, with a value that satisfies it", async () => {
    const provider = createMockModelProvider();
    const request = createModelRequest({
      context: {},
      instruction: "Produce a status record.",
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "error"] },
          count: { type: "number" },
          note: { type: "string", nullable: true }
        },
        required: ["status", "count", "note"],
        additionalProperties: false
      },
      config: { modelId: "mock-v1" }
    });
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    assert.equal(result.response?.kind, "structured_result");
    const structured = result.response?.structuredResult as { status: string; count: number; note: string | null };
    assert.equal(structured.status, "ok"); // first enum option, deterministically
    assert.equal(structured.count, 0);
    assert.equal(structured.note, null); // nullable -> null, never a fabricated value
  });

  it("a tool-shaped schema (toolName + input, required together) resolves toolName from a REAL declared tool, never a placeholder string that could never be a valid tool name", async () => {
    const provider = createMockModelProvider();
    const request = createModelRequest({
      context: {},
      instruction: "Propose one tool call.",
      tools: [
        {
          name: "modify_environment_object",
          description: "Modify a real environment object.",
          inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"], additionalProperties: false },
          mutation: "mutate",
          target: "environment"
        }
      ],
      outputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string" },
          input: { type: "object", properties: {}, additionalProperties: true }
        },
        required: ["toolName", "input"],
        additionalProperties: false
      },
      config: { modelId: "mock-v1" }
    });
    const result = await provider.generate(request);
    assert.equal(result.status, "success");
    const structured = result.response?.structuredResult as { toolName: string; input: { objectId: string } };
    assert.equal(structured.toolName, "modify_environment_object");
    assert.equal(structured.input.objectId, "(deterministic mock value)", "synthesized from the tool's own inputSchema, not left absent");
  });

  it("end-to-end: generatePlanProposal succeeds against the REAL, unmodified default provider -- the actual bug this closes, exercised through the actual workflow function a judge's chat turn calls", async () => {
    const provider = createMockModelProvider();
    const state = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "A mounting bracket.",
        objective: { summary: "Reduce mass by 20%." },
        requirements: [{ id: "req_mass", description: "Max mass 350g" }]
      },
      session: {}
    });
    const observation: ObservationResult = observeProject(state, { scope: "project" });

    const result = await generatePlanProposal(provider, observation, { config: { modelId: "mock-v1" } });

    assert.equal(result.status, "success", result.status === "error" ? result.error.message : undefined);
    assert.ok(result.status === "success" && Array.isArray(result.plan.steps));
  });

  it("end-to-end: generateProposal succeeds against the REAL, unmodified default provider when a real tool is registered", async () => {
    // A real Plan with one real step -- built via a hand-scripted fake
    // provider, exactly like proposal-generator.test.ts's own richPlan()
    // helper, because constructing the FIXTURE plan is setup, not the
    // thing under test. generateProposal itself, below, uses the REAL
    // unmodified default provider -- that is the actual code path this
    // regression test exists to prove.
    const fixtureState = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "A mounting bracket.",
        objective: { summary: "Reduce mass by 20%." },
        requirements: [{ id: "req_mass", description: "Max mass 350g" }],
        objects: [{ id: "obj_bracket", type: "part", name: "Bracket" }]
      },
      session: {}
    });
    const observation: ObservationResult = observeProject(fixtureState, { scope: "project" });
    const fixtureProvider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "fixture", modelId: "fixture-v1", supportsStructuredOutput: true }),
      async generate(request) {
        const response = createModelResponse({
          requestId: request.id,
          kind: "structured_result",
          structuredResult: {
            steps: [
              {
                id: "step-1",
                title: "Reduce rib thickness",
                description: "Thin the reinforcing rib to cut mass.",
                purpose: "Meet the mass requirement.",
                dependsOn: [],
                inputs: [],
                expectedOutputs: [],
                relevantRequirementIds: ["req_mass"],
                relevantConstraintIds: [],
                relevantObjectIds: ["obj_bracket"],
                relevantDecisionIds: [],
                verificationIntent: null,
                assumptionRefs: []
              }
            ],
            assumptions: [],
            unresolvedQuestions: [],
            risks: [],
            additionalMissingInformation: []
          }
        });
        const schemaErrors = validateStructuredResult(response, request);
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "fixture",
          modelId: "fixture-v1",
          status: schemaErrors.length > 0 ? "error" : "success",
          response: schemaErrors.length > 0 ? undefined : response,
          error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
          startedAt: new Date().toISOString()
        });
      }
    };
    const planResult = await generatePlanProposal(fixtureProvider, observation, { config: { modelId: "fixture-v1" } });
    assert.equal(planResult.status, "success");
    if (planResult.status !== "success") return;
    const plan = planResult.plan;

    const registry: ToolRegistry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_object",
        description: "Modifies a property on an existing engineering object.",
        target: "world_model",
        mutation: "mutate",
        inputSchema: {
          type: "object",
          properties: { objectId: { type: "string" }, propertyKey: { type: "string" }, value: { type: "string" } },
          required: ["objectId", "propertyKey", "value"]
        },
        outputSchema: { type: "object", properties: {} }
      }),
      () => ({})
    );

    // THE test: proposal generation against the real, unconfigured default
    // provider -- no custom respond callback anywhere in this call.
    const provider = createMockModelProvider();
    const result = await generateProposal(provider, registry, plan, plan.steps[0]!.id, { config: { modelId: "mock-v1" } });

    assert.equal(result.status, "success", result.status === "error" ? result.error.message : undefined);
    assert.ok(result.status === "success" && result.proposal.toolName === "modify_object");
  });

  it("end-to-end: generateDesignSpecification (the actual candidate-generation building block) succeeds against the REAL, unmodified default provider", async () => {
    // Same fixture-plan-via-hand-scripted-provider pattern as the
    // generateProposal test above -- constructing the PLAN is setup, not
    // the thing under test. generateDesignSpecification itself uses the
    // real default provider.
    const fixtureState = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "A mounting bracket.",
        objective: { summary: "Reduce mass by 20%." },
        requirements: [{ id: "req_mass", description: "Max mass 350g" }],
        objects: [{ id: "obj_bracket", type: "part", name: "Bracket" }]
      },
      session: {}
    });
    const observation: ObservationResult = observeProject(fixtureState, { scope: "project" });
    const fixtureProvider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "fixture", modelId: "fixture-v1", supportsStructuredOutput: true }),
      async generate(request) {
        const response = createModelResponse({
          requestId: request.id,
          kind: "structured_result",
          structuredResult: {
            steps: [
              {
                id: "step-1",
                title: "Reduce rib thickness",
                description: "Thin the reinforcing rib to cut mass.",
                purpose: "Meet the mass requirement.",
                dependsOn: [],
                inputs: [],
                expectedOutputs: [],
                relevantRequirementIds: ["req_mass"],
                relevantConstraintIds: [],
                relevantObjectIds: ["obj_bracket"],
                relevantDecisionIds: [],
                verificationIntent: null,
                assumptionRefs: []
              }
            ],
            assumptions: [],
            unresolvedQuestions: [],
            risks: [],
            additionalMissingInformation: []
          }
        });
        const schemaErrors = validateStructuredResult(response, request);
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "fixture",
          modelId: "fixture-v1",
          status: schemaErrors.length > 0 ? "error" : "success",
          response: schemaErrors.length > 0 ? undefined : response,
          error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
          startedAt: new Date().toISOString()
        });
      }
    };
    const planResult = await generatePlanProposal(fixtureProvider, observation, { config: { modelId: "fixture-v1" } });
    assert.equal(planResult.status, "success");
    if (planResult.status !== "success") return;
    const plan = planResult.plan;

    const provider = createMockModelProvider();
    const result = await generateDesignSpecification(provider, plan, plan.steps[0]!.id, fixtureState.project.requirements, fixtureState.project.constraints, {
      config: { modelId: "mock-v1" }
    });

    assert.equal(result.status, "success", result.status === "error" ? result.error.message : undefined);
    assert.ok(result.status === "success" && Array.isArray(result.design.components));
  });

  it("end-to-end: interpretRequirementFromText succeeds against the REAL, unmodified default provider -- requirement capture, the entry point to every chat turn, genuinely works with no Gemini credentials configured", async () => {
    const state = createWorldModelState({
      project: { name: "Bracket Study", description: "x", objective: { summary: "Reduce mass by 20%." } },
      session: {}
    });
    const provider = createMockModelProvider();
    const result = await interpretRequirementFromText(provider, state, "It must support at least 500 N.", { config: { modelId: "mock-v1" } });

    assert.equal(result.status, "success", result.status === "error" ? result.error.message : undefined);
  });
});
