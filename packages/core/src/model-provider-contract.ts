import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertModelInvocationResult, assertModelProviderDescriptor, createModelRequest, type ModelToolDeclaration } from "@naqsh/schemas";
import type { ModelProvider } from "./model-provider.js";

/**
 * THE reusable contract-test suite for `ModelProvider` (P7 brief §12,
 * "Schema consistency" + the P5/P6 precedent of `runEnvironmentAdapterContractTests`):
 * call this once with a factory for the provider under test, and it
 * registers a `describe`/`it` tree that exercises ONLY the public
 * `ModelProvider` interface. The same tests, unmodified, are meant to run
 * against `createGeminiModelProvider` once live credentials make that
 * possible — proving a real provider honors the same "never throw for an
 * expected failure, always return a well-formed result" discipline the
 * mock is held to today.
 *
 * Deliberately does NOT assert on the CONTENT of a model's response (e.g.
 * "the model chose to call a tool") — that depends on actual model
 * reasoning for a real provider and cannot be forced deterministically
 * from a generic suite. What it verifies instead is structural: the
 * result is well-formed, ids/timestamps behave, and providing tools never
 * causes a crash — properties every provider must uphold regardless of
 * what a model decides to say.
 */
export function runModelProviderContractTests(label: string, createProvider: () => ModelProvider | Promise<ModelProvider>): void {
  describe(`ModelProvider contract: ${label}`, () => {
    it("describe() returns a valid, self-consistent descriptor", async () => {
      const provider = await createProvider();
      const descriptor = provider.describe();
      assertModelProviderDescriptor(descriptor);
      assert.equal(descriptor.providerId.length > 0, true);
      assert.equal(descriptor.modelId.length > 0, true);
    });

    it("generate() with a minimal text request never throws and returns a well-formed result", async () => {
      const provider = await createProvider();
      const descriptor = provider.describe();
      const request = createModelRequest({
        context: {},
        instruction: "Say hello.",
        config: { modelId: descriptor.modelId }
      });

      let result;
      try {
        result = await provider.generate(request);
      } catch {
        assert.fail("ModelProvider.generate() must never throw/reject for an expected failure mode");
      }
      assertModelInvocationResult(result);
      assert.equal(result.requestId, request.id);
      assert.equal(result.providerId, descriptor.providerId);
      assert.ok(result.completedAt >= result.startedAt, "completedAt must not precede startedAt");
    });

    it("generate() with tools declared never throws, regardless of whether a tool is actually called", async () => {
      const provider = await createProvider();
      const descriptor = provider.describe();
      const probeTool: ModelToolDeclaration = {
        name: "contract_probe_tool",
        description: "A tool declared only to prove generate() tolerates tools being present.",
        inputSchema: { type: "object", properties: {}, required: [] },
        mutation: "observe",
        target: "world_model"
      };
      const request = createModelRequest({
        context: {},
        instruction: "Respond however you see fit.",
        tools: [probeTool],
        config: { modelId: descriptor.modelId }
      });

      let result;
      try {
        result = await provider.generate(request);
      } catch {
        assert.fail("ModelProvider.generate() must never throw/reject when tools are declared");
      }
      assertModelInvocationResult(result);
      assert.equal(result.requestId, request.id);
    });
  });
}
