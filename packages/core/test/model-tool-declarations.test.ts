import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTool, type Tool, type ToolValueSchema } from "@naqsh/schemas";
import { toModelToolDeclarations } from "../src/model-tool-declarations.js";

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: { projectId: { type: "string" } },
  required: ["projectId"]
};

function buildTool(overrides: Partial<Parameters<typeof createTool>[0]> = {}): Tool {
  return createTool({
    name: "inspect_project",
    description: "Returns a read-only summary of a project.",
    target: "world_model",
    mutation: "observe",
    inputSchema,
    outputSchema: { type: "object", properties: {}, required: [] },
    ...overrides
  });
}

describe("toModelToolDeclarations", () => {
  it("maps name/description/inputSchema/mutation/target straight through", () => {
    const tool = buildTool();
    const [declaration] = toModelToolDeclarations([tool]);
    assert.equal(declaration?.name, "inspect_project");
    assert.equal(declaration?.description, tool.description);
    assert.deepEqual(declaration?.inputSchema, tool.inputSchema);
    assert.equal(declaration?.mutation, "observe");
    assert.equal(declaration?.target, "world_model");
  });

  it("reuses the exact ToolValueSchema instance's shape -- not a re-authored copy", () => {
    const tool = buildTool();
    const [declaration] = toModelToolDeclarations([tool]);
    assert.deepEqual(declaration?.inputSchema, inputSchema);
  });

  it("drops Tool.id/version/source/outputSchema -- a model never needs them", () => {
    const tool = buildTool();
    const [declaration] = toModelToolDeclarations([tool]);
    assert.equal("id" in (declaration as object), false);
    assert.equal("version" in (declaration as object), false);
    assert.equal("source" in (declaration as object), false);
    assert.equal("outputSchema" in (declaration as object), false);
  });

  it("maps an empty tool list to an empty declaration list", () => {
    assert.deepEqual(toModelToolDeclarations([]), []);
  });

  it("maps multiple tools preserving order", () => {
    const toolA = buildTool({ name: "tool_a" });
    const toolB = buildTool({ name: "tool_b" });
    const declarations = toModelToolDeclarations([toolA, toolB]);
    assert.deepEqual(
      declarations.map((declaration) => declaration.name),
      ["tool_a", "tool_b"]
    );
  });
});
