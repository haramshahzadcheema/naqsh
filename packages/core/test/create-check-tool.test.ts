import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type Check, type WorldModelState } from "@naqsh/schemas";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createCheckStore } from "../src/check-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { recordTransition } from "../src/record-transition.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildHarness() {
  const checkStore = createCheckStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createCreateCheckTool(checkStore, () => state);
  registry.register(tool, handler);
  return {
    registry,
    checkStore,
    tool,
    getState: () => state,
    setState: (next: WorldModelState) => {
      state = next;
    }
  };
}

/** Adds a real, quantitative Requirement ("thickness >= 5") directly via
 * recordTransition (the same audited write path add_requirement itself
 * uses) so the linkage tests below have a genuine Requirement.id to point
 * a Check at. */
function addQuantitativeRequirement(harness: ReturnType<typeof buildHarness>, overrides: { value?: number; unit?: string | null; operator?: string } = {}) {
  const history = createChangeHistory();
  const { state: nextState } = recordTransition(history, harness.getState(), {
    kind: "add_requirement",
    requirement: {
      description: "thickness must be at least 5mm",
      category: "geometry",
      value: overrides.value ?? 5,
      unit: overrides.unit === undefined ? "mm" : overrides.unit,
      metadata: { operator: overrides.operator ?? "gte" }
    }
  });
  harness.setState(nextState);
  return nextState.project.requirements.at(-1)!;
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

describe("createCreateCheckTool: goalpost integrity -- a check linked to a requirement/constraint cannot invent its own threshold", () => {
  it("accepts a numeric_comparison check whose threshold matches the linked requirement exactly", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness);
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: {
        kind: "numeric_comparison",
        description: "thickness >= 5mm",
        objectId: "envobj_1",
        property: "thickness",
        operator: "gte",
        expectedValue: 5,
        expectedUnit: "mm",
        requirementId: requirement.id
      }
    });
    assert.equal(result.status, "success");
    const check = (result.output as { check: Check }).check;
    assert.equal(check.metadata.requirementId, requirement.id);
  });

  it("REGRESSION: rejects a numeric_comparison check whose expectedValue does not match the linked requirement -- an agent cannot author a trivially-satisfiable threshold while claiming to test a real requirement", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness, { value: 5 });
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: {
        kind: "numeric_comparison",
        description: "thickness >= -999999mm (invented, trivially satisfiable)",
        objectId: "envobj_1",
        property: "thickness",
        operator: "gte",
        expectedValue: -999999,
        requirementId: requirement.id
      }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /check_requirement_mismatch/);
  });

  it("rejects a numeric_comparison check whose operator contradicts the linked requirement's declared operator", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness, { value: 5, operator: "gte" });
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: {
        kind: "numeric_comparison",
        description: "thickness == 5mm (wrong direction)",
        objectId: "envobj_1",
        property: "thickness",
        operator: "eq",
        expectedValue: 5,
        requirementId: requirement.id
      }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /check_requirement_mismatch/);
  });

  it("rejects a numeric_comparison check whose unit contradicts the linked requirement's declared unit", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness, { value: 5, unit: "mm" });
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: {
        kind: "numeric_comparison",
        description: "thickness >= 5in",
        objectId: "envobj_1",
        property: "thickness",
        operator: "gte",
        expectedValue: 5,
        expectedUnit: "in",
        requirementId: requirement.id
      }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /check_requirement_mismatch/);
  });

  it("accepts a bounds_check whose [min,max] contains the linked requirement's value", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness, { value: 5 });
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: { kind: "bounds_check", description: "x", objectId: "envobj_1", property: "thickness", min: 4, max: 6, requirementId: requirement.id }
    });
    assert.equal(result.status, "success");
  });

  it("rejects a bounds_check whose [min,max] does NOT contain the linked requirement's value", async () => {
    const harness = buildHarness();
    const requirement = addQuantitativeRequirement(harness, { value: 5 });
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: { kind: "bounds_check", description: "x (does not actually contain the requirement's value)", objectId: "envobj_1", property: "thickness", min: 100, max: 200, requirementId: requirement.id }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /check_requirement_mismatch/);
  });

  it("rejects a requirementId that doesn't resolve to a real requirement in the current project", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "thickness", operator: "gte", expectedValue: 5, requirementId: "req_does_not_exist" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /requirement_not_found/);
  });

  it("a QUALITATIVE requirement (value: null) imposes no numeric cross-check -- there is nothing to compare", async () => {
    const harness = buildHarness();
    const history = createChangeHistory();
    const { state: nextState } = recordTransition(history, harness.getState(), {
      kind: "add_requirement",
      requirement: { description: "must be easy to manufacture", category: "manufacturability", value: null, unit: null }
    });
    harness.setState(nextState);
    const requirement = nextState.project.requirements.at(-1)!;
    const { result } = await executeTool(harness.registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "thickness", operator: "gte", expectedValue: 12345, requirementId: requirement.id }
    });
    assert.equal(result.status, "success");
  });

  it("a check with NO requirementId/constraintId is entirely unaffected -- linkage is opt-in", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "create_check",
      input: { kind: "numeric_comparison", description: "x", objectId: "envobj_1", property: "thickness", operator: "gte", expectedValue: -999999 }
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
