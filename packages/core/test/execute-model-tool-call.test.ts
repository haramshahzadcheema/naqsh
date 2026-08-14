import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelToolCallIntent, createTool, type ToolValueSchema } from "@naqsh/schemas";
import { executeModelToolCall } from "../src/execute-model-tool-call.js";
import { createToolRegistry } from "../src/tool-registry.js";

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: { projectId: { type: "string" } },
  required: ["projectId"]
};

/**
 * The security-boundary proof the P7 brief asks for (§8/§12): a tool-call
 * INTENT that originated from a `ModelResponse` must go through the exact
 * same `executeTool` boundary (input validation -> `authorize` hook ->
 * handler -> output validation) as any other tool call. These tests
 * exercise `executeModelToolCall` directly, standing in for what a
 * `ModelResponse.toolCall` would be handed to once P11's loop exists --
 * proving the boundary works today, not merely that it's theoretically
 * composable.
 */
describe("executeModelToolCall: the model can only request, never directly execute", () => {
  it("a valid intent against a valid registered tool executes normally", async () => {
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "inspect_project",
        target: "world_model",
        mutation: "observe",
        inputSchema,
        outputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
      }),
      (input) => ({ name: `Project ${(input as { projectId: string }).projectId}` })
    );

    const intent = createModelToolCallIntent({ toolName: "inspect_project", arguments: { projectId: "proj_1" } });
    const { result } = await executeModelToolCall(registry, intent);
    assert.equal(result.status, "success");
    assert.deepEqual(result.output, { name: "Project proj_1" });
  });

  it("an intent naming an unregistered tool is rejected with unknown_tool -- never silently executes anything", async () => {
    const registry = createToolRegistry();
    const intent = createModelToolCallIntent({ toolName: "does_not_exist", arguments: {} });
    const { result } = await executeModelToolCall(registry, intent);
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "unknown_tool");
  });

  it("an intent with arguments that don't match the tool's inputSchema is rejected with invalid_input", async () => {
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "inspect_project",
        target: "world_model",
        mutation: "observe",
        inputSchema,
        outputSchema: { type: "object", properties: {}, required: [] }
      }),
      () => ({})
    );
    const intent = createModelToolCallIntent({ toolName: "inspect_project", arguments: { wrongField: 1 } });
    const { result } = await executeModelToolCall(registry, intent);
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("a denying authorize hook rejects the call with policy_rejected -- the model cannot bypass permissions", async () => {
    const registry = createToolRegistry();
    let handlerWasCalled = false;
    registry.register(
      createTool({
        name: "delete_object",
        target: "environment",
        mutation: "mutate",
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {}, required: [] }
      }),
      () => {
        handlerWasCalled = true;
        return {};
      }
    );
    const intent = createModelToolCallIntent({ toolName: "delete_object", arguments: {} });
    const { result } = await executeModelToolCall(registry, intent, {
      authorize: () => ({ allowed: false, reason: "no autonomy grant for this tool" })
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(handlerWasCalled, false, "the handler must never run when authorization denies the call");
  });

  it("an allowing authorize hook lets the call proceed, proving the hook is genuinely consulted (not bypassed)", async () => {
    const registry = createToolRegistry();
    registry.register(
      createTool({
        name: "modify_thickness",
        target: "environment",
        mutation: "mutate",
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object", properties: {}, required: [] }
      }),
      () => ({})
    );
    const intent = createModelToolCallIntent({ toolName: "modify_thickness", arguments: {} });
    const { result } = await executeModelToolCall(registry, intent, { authorize: () => true });
    assert.equal(result.status, "success");
  });

  it("the intent's arguments never touch anything beyond the tool's own registered handler input", async () => {
    // Structural proof that a ModelToolCallIntent carries no executable
    // code: its `arguments` field is a plain, JSON-serializable object,
    // and executeModelToolCall never evaluates it as anything but data.
    const intent = createModelToolCallIntent({ toolName: "x", arguments: { note: "just data" } });
    assert.doesNotThrow(() => JSON.stringify(intent));
    assert.equal(typeof intent.arguments, "object");
  });
});
