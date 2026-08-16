import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Check } from "@naqsh/schemas";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createCheckStore } from "../src/check-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildHarness() {
  const checkStore = createCheckStore();
  const registry = createToolRegistry();
  const { tool, handler } = createCreateCheckTool(checkStore);
  registry.register(tool, handler);
  return { registry, checkStore, tool };
}

describe("createCreateCheckTool: identity and classification", () => {
  it("is classified suggest/verification -- creating a check never mutates the World Model or the environment", () => {
    const { tool } = buildHarness();
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "verification");
  });
});

describe("createCreateCheckTool: numeric_comparison", () => {
  it("creates a valid check and persists it", async () => {
    const { registry, checkStore } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "diameter <= 20mm", objectId: "envobj_1", property: "diameter", operator: "lte", expectedValue: 20 }
    });
    assert.equal(result.status, "success");
    const check = (result.output as { check: Check }).check;
    assert.equal(check.kind, "numeric_comparison");
    assert.deepEqual(checkStore.getById(check.id), check);
  });

  it("rejects a missing operator", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "diameter", expectedValue: 20 }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing expectedValue", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "diameter", operator: "lte" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createCreateCheckTool: bounds_check", () => {
  it("rejects a check with neither min nor max", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "bounds_check", description: "x", objectId: "envobj_1", property: "thickness" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("creates a valid bounds check", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "bounds_check", description: "x", objectId: "envobj_1", property: "thickness", min: 2, max: 5 }
    });
    assert.equal(result.status, "success");
  });
});

describe("createCreateCheckTool: object_exists / object_type / property_required", () => {
  it("creates a valid object_exists check", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_check", input: { kind: "object_exists", description: "x", objectId: "envobj_1" } });
    assert.equal(result.status, "success");
  });

  it("rejects an invalid expectedGenericType for object_type", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "object_type", description: "x", objectId: "envobj_1", expectedGenericType: "not_a_real_type" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("creates a valid object_type check", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "object_type", description: "x", objectId: "envobj_1", expectedGenericType: "solid" }
    });
    assert.equal(result.status, "success");
  });

  it("creates a valid property_required check", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "property_required", description: "x", objectId: "envobj_1", property: "material" }
    });
    assert.equal(result.status, "success");
  });
});

describe("createCreateCheckTool: shared validation", () => {
  it("rejects an unrecognized kind -- the allowlist is enforced, not open", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "run_arbitrary_javascript", description: "x", objectId: "envobj_1" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing description", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_check", input: { kind: "object_exists", objectId: "envobj_1" } });
    assert.equal(result.status, "error");
  });

  it("rejects a missing objectId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_check", input: { kind: "object_exists", description: "x" } });
    assert.equal(result.status, "error");
  });

  it("two checks created with the same input get distinct ids -- never accidentally deduplicated", async () => {
    const { registry } = buildHarness();
    const input = { kind: "object_exists", description: "x", objectId: "envobj_1" };
    const { result: r1 } = await executeTool(registry, { toolName: "create_check", input });
    const { result: r2 } = await executeTool(registry, { toolName: "create_check", input });
    const c1 = (r1.output as { check: Check }).check;
    const c2 = (r2.output as { check: Check }).check;
    assert.notEqual(c1.id, c2.id);
  });
});
