import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTool, ToolError, type Tool, type ToolInput } from "@naqsh/schemas";
import { createToolRegistry, invokeRegisteredTool } from "../src/tool-registry.js";

function buildToolInput(overrides: Partial<ToolInput> = {}): ToolInput {
  return {
    name: "inspect_project",
    description: "Returns a read-only summary of a project.",
    target: "world_model",
    mutation: "observe",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {} },
    ...overrides
  };
}

describe("ToolRegistry: register/lookup/list", () => {
  it("registers a tool and finds it by name and id", () => {
    const registry = createToolRegistry();
    const tool = createTool(buildToolInput());
    registry.register(tool, () => ({}));

    assert.deepEqual(registry.getByName("inspect_project"), tool);
    assert.deepEqual(registry.getById(tool.id), tool);
    assert.equal(registry.hasName("inspect_project"), true);
  });

  it("lists every registered tool", () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput({ name: "a" })), () => ({}));
    registry.register(createTool(buildToolInput({ name: "b" })), () => ({}));
    assert.deepEqual(
      registry.list().map((tool) => tool.name).sort(),
      ["a", "b"]
    );
  });

  it("returns undefined for an unregistered name or id", () => {
    const registry = createToolRegistry();
    assert.equal(registry.getByName("nope"), undefined);
    assert.equal(registry.getById("tool_nope"), undefined);
    assert.equal(registry.hasName("nope"), false);
  });

  it("rejects a duplicate tool name", () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), () => ({}));
    assert.throws(
      () => registry.register(createTool(buildToolInput()), () => ({})),
      (error: unknown) => error instanceof ToolError && error.kind === "duplicate_registration"
    );
  });

  it("rejects registering an invalid tool (structural validation still runs)", () => {
    const registry = createToolRegistry();
    assert.throws(() => registry.register({ name: "" } as unknown as Tool, () => ({})));
  });

  it("rejects registering without a handler function", () => {
    const registry = createToolRegistry();
    assert.throws(
      () => registry.register(createTool(buildToolInput()), "not a function" as never),
      (error: unknown) => error instanceof ToolError && error.kind === "execution_failure"
    );
  });
});

describe("ToolRegistry: invokeRegisteredTool (internal dispatch primitive)", () => {
  it("calls the registered handler with the given input", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), (input: unknown) => ({ echoed: input }));
    const result = await invokeRegisteredTool(registry, "inspect_project", { x: 1 });
    assert.deepEqual(result, { echoed: { x: 1 } });
  });

  it("rejects with unknown_tool for an unregistered name", async () => {
    const registry = createToolRegistry();
    await assert.rejects(
      () => invokeRegisteredTool(registry, "nope", {}),
      (error: unknown) => error instanceof ToolError && error.kind === "unknown_tool"
    );
  });

  it("supports async handlers", async () => {
    const registry = createToolRegistry();
    registry.register(createTool(buildToolInput()), async () => {
      await Promise.resolve();
      return { ok: true };
    });
    assert.deepEqual(await invokeRegisteredTool(registry, "inspect_project", {}), { ok: true });
  });
});

describe("ToolRegistry: invoke is not part of the public surface (P3/P4 audit regression)", () => {
  it("ToolRegistry objects have no callable invoke method", () => {
    const registry = createToolRegistry();
    assert.equal((registry as unknown as { invoke?: unknown }).invoke, undefined);
  });

  it("@naqsh/core's public barrel does not export invokeRegisteredTool", async () => {
    const publicApi = await import("../src/index.js");
    assert.equal((publicApi as Record<string, unknown>).invokeRegisteredTool, undefined);
  });
});
