import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesignSpecification, type DesignSpecification } from "@naqsh/schemas";
import { createSaveDesignSpecificationTool } from "../src/save-design-specification-tool.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildDesign(overrides: Partial<Parameters<typeof createDesignSpecification>[0]> = {}): DesignSpecification {
  return createDesignSpecification({
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket.",
    description: "A ribbed mounting plate with two through-holes.",
    ...overrides
  });
}

function buildHarness() {
  const designSpecificationStore = createDesignSpecificationStore();
  const registry = createToolRegistry();
  const { tool, handler } = createSaveDesignSpecificationTool(designSpecificationStore);
  registry.register(tool, handler);
  return { registry, designSpecificationStore, tool };
}

describe("createSaveDesignSpecificationTool: identity and classification", () => {
  it("is classified suggest/world_model -- saving a design never mutates the World Model or the environment", () => {
    const { tool } = buildHarness();
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "world_model");
  });
});

describe("createSaveDesignSpecificationTool: real persistence", () => {
  it("saves a real DesignSpecification, findable afterward via the store's own listForPlan", async () => {
    const { registry, designSpecificationStore } = buildHarness();
    const design = buildDesign();

    const { result } = await executeTool(registry, { toolName: "save_design_specification", input: { designSpecification: design } });

    assert.equal(result.status, "success");
    assert.deepEqual(designSpecificationStore.getById(design.id), design);
    assert.deepEqual(designSpecificationStore.listForPlan("plan_1"), [design]);
  });

  it("rejects a malformed designSpecification, never silently saving something invalid", async () => {
    const { registry, designSpecificationStore } = buildHarness();

    const { result } = await executeTool(registry, { toolName: "save_design_specification", input: { designSpecification: { not: "a real design" } } });

    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.equal(designSpecificationStore.list().length, 0);
  });

  it("two independently-generated designs for the same plan step both persist -- generating alternatives never overwrites a prior one", async () => {
    const { registry, designSpecificationStore } = buildHarness();
    const designA = buildDesign({ description: "Variation A: single reinforcing rib." });
    const designB = buildDesign({ description: "Variation B: double-walled plate, no rib." });

    await executeTool(registry, { toolName: "save_design_specification", input: { designSpecification: designA } });
    await executeTool(registry, { toolName: "save_design_specification", input: { designSpecification: designB } });

    const forPlan = designSpecificationStore.listForPlan("plan_1");
    assert.equal(forPlan.length, 2);
    assert.deepEqual(new Set(forPlan.map((d) => d.description)), new Set([designA.description, designB.description]));
  });
});
