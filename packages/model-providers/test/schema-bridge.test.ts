import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelToolDeclaration, ToolValueSchema } from "@naqsh/schemas";
import { toGeminiFunctionDeclaration, toGeminiJsonSchema } from "../src/schema-bridge.js";

describe("toGeminiJsonSchema: ToolValueSchema is already valid JSON Schema", () => {
  it("passes through a simple object schema unchanged in structure", () => {
    const schema: ToolValueSchema = {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
      required: ["name"]
    };
    const mapped = toGeminiJsonSchema(schema);
    assert.deepEqual(mapped, schema);
  });

  it("passes through nested array/enum schemas unchanged", () => {
    const schema: ToolValueSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        priority: { type: "string", enum: ["low", "medium", "high"] }
      },
      required: []
    };
    const mapped = toGeminiJsonSchema(schema);
    assert.deepEqual(mapped, schema);
  });

  it("round-trips through JSON with full fidelity (proving it's genuinely JSON-safe)", () => {
    const schema: ToolValueSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false
    };
    const mapped = toGeminiJsonSchema(schema);
    assert.deepEqual(JSON.parse(JSON.stringify(mapped)), schema);
  });
});

describe("toGeminiFunctionDeclaration", () => {
  it("maps name/description/inputSchema onto the SDK's FunctionDeclaration shape", () => {
    const declaration: ModelToolDeclaration = {
      name: "inspect_project",
      description: "Returns a read-only summary of a project.",
      inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
      mutation: "observe",
      target: "world_model"
    };
    const mapped = toGeminiFunctionDeclaration(declaration);
    assert.equal(mapped.name, "inspect_project");
    assert.equal(mapped.description, declaration.description);
    assert.deepEqual(mapped.parametersJsonSchema, declaration.inputSchema);
  });

  it("does not leak mutation/target (P4 classification fields) into the Gemini-facing declaration", () => {
    const declaration: ModelToolDeclaration = {
      name: "delete_object",
      description: "x",
      inputSchema: { type: "object", properties: {}, required: [] },
      mutation: "mutate",
      target: "environment"
    };
    const mapped = toGeminiFunctionDeclaration(declaration);
    assert.equal("mutation" in mapped, false);
    assert.equal("target" in mapped, false);
  });
});
