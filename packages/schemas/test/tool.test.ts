import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertTool,
  assertToolRequest,
  assertToolResult,
  assertValidToolValueSchema,
  createTool,
  createToolRequest,
  createToolResult,
  deserializeTool,
  deserializeToolResult,
  matchesToolValueSchema,
  serializeTool,
  serializeToolResult,
  WorldModelValidationError,
  type ToolInput,
  type ToolValueSchema
} from "../src/index.js";

const inspectProjectInputSchema: ToolValueSchema = {
  type: "object",
  properties: { projectId: { type: "string" } },
  required: ["projectId"]
};

const inspectProjectOutputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    requirementCount: { type: "number" }
  },
  required: ["name", "requirementCount"]
};

function buildToolInput(overrides: Partial<ToolInput> = {}): ToolInput {
  return {
    name: "inspect_project",
    description: "Returns a read-only summary of a project.",
    target: "world_model",
    mutation: "observe",
    inputSchema: inspectProjectInputSchema,
    outputSchema: inspectProjectOutputSchema,
    ...overrides
  };
}

describe("ToolValueSchema: schema definitions themselves are validated", () => {
  it("accepts a well-formed nested schema", () => {
    assert.doesNotThrow(() =>
      assertValidToolValueSchema({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          count: { type: "number" }
        },
        required: ["tags"]
      })
    );
  });

  it("rejects an unknown type", () => {
    assert.throws(() => assertValidToolValueSchema({ type: "date" }), /type must be one of/);
  });

  it("rejects required referencing a property that doesn't exist", () => {
    assert.throws(
      () => assertValidToolValueSchema({ type: "object", properties: {}, required: ["missing"] }),
      /references unknown property/
    );
  });

  it("rejects a non-object properties field", () => {
    assert.throws(
      () => assertValidToolValueSchema({ type: "object", properties: "nope" }),
      /properties must be an object/
    );
  });

  it("validates array items recursively", () => {
    assert.throws(
      () => assertValidToolValueSchema({ type: "array", items: { type: "not_real" } }),
      /items.type must be one of/
    );
  });
});

describe("matchesToolValueSchema: validating a VALUE against a schema", () => {
  it("accepts a value matching the schema", () => {
    assert.deepEqual(matchesToolValueSchema(inspectProjectInputSchema, { projectId: "proj_1" }), []);
  });

  it("reports a missing required field", () => {
    const errors = matchesToolValueSchema(inspectProjectInputSchema, {});
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /projectId is required/);
  });

  it("reports a type mismatch", () => {
    const errors = matchesToolValueSchema(inspectProjectInputSchema, { projectId: 42 });
    assert.match(errors[0]!, /must be a string/);
  });

  it("reports every violation at once, not just the first", () => {
    const schema: ToolValueSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"]
    };
    const errors = matchesToolValueSchema(schema, {});
    assert.equal(errors.length, 2);
  });

  it("enforces an enum constraint", () => {
    const schema: ToolValueSchema = { type: "string", enum: ["low", "medium", "high"] };
    assert.deepEqual(matchesToolValueSchema(schema, "medium"), []);
    assert.match(matchesToolValueSchema(schema, "urgent")[0]!, /must be one of/);
  });

  it("rejects NaN/Infinity for a number schema (not JSON-safe)", () => {
    assert.notEqual(matchesToolValueSchema({ type: "number" }, Number.NaN).length, 0);
    assert.notEqual(matchesToolValueSchema({ type: "number" }, Number.POSITIVE_INFINITY).length, 0);
  });

  it("validates arrays element-by-element", () => {
    const schema: ToolValueSchema = { type: "array", items: { type: "string" } };
    assert.deepEqual(matchesToolValueSchema(schema, ["a", "b"]), []);
    const errors = matchesToolValueSchema(schema, ["a", 2]);
    assert.match(errors[0]!, /\[1\] must be a string/);
  });

  describe("unknown fields: explicit, documented behavior", () => {
    const permissive: ToolValueSchema = { type: "object", properties: { a: { type: "string" } } };
    const strict: ToolValueSchema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false
    };

    it("allows extra properties by default (additionalProperties omitted)", () => {
      assert.deepEqual(matchesToolValueSchema(permissive, { a: "x", extra: "y" }), []);
    });

    it("rejects extra properties when additionalProperties is false", () => {
      const errors = matchesToolValueSchema(strict, { a: "x", extra: "y" });
      assert.match(errors[0]!, /extra is not an allowed property/);
    });
  });
});

describe("Tool: creation and validation", () => {
  it("creates a valid tool with defaults", () => {
    const tool = createTool(buildToolInput());
    assert.match(tool.id, /^tool_/);
    assert.equal(tool.version, "0.1.0");
    assert.equal(tool.source, "system");
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "world_model");
  });

  it("rejects an empty name", () => {
    assert.throws(() => createTool(buildToolInput({ name: "" })), /tool.name is required/);
  });

  it("rejects an invalid target", () => {
    assert.throws(
      () => assertTool({ ...createTool(buildToolInput()), target: "freecad" }),
      /invalid tool target/
    );
  });

  it("rejects an invalid mutation kind", () => {
    assert.throws(
      () => assertTool({ ...createTool(buildToolInput()), mutation: "delete" }),
      /invalid tool mutation kind/
    );
  });

  it("rejects a tool whose inputSchema is malformed", () => {
    assert.throws(
      () => createTool(buildToolInput({ inputSchema: { type: "bogus" } as never })),
      WorldModelValidationError
    );
  });

  it("freezes the returned tool", () => {
    const tool = createTool(buildToolInput());
    assert.throws(() => {
      (tool as { name: string }).name = "renamed";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const tool = createTool(buildToolInput());
    assert.deepEqual(deserializeTool(serializeTool(tool)), tool);
  });
});

describe("ToolRequest: creation and validation", () => {
  it("creates a valid request, leaving input unvalidated (that's execute-tool's job)", () => {
    const request = createToolRequest({ toolName: "inspect_project", input: { anything: true } });
    assert.match(request.id, /^treq_/);
    assert.equal(request.source, "system");
    assertToolRequest(request);
  });

  it("rejects an empty toolName", () => {
    assert.throws(
      () => createToolRequest({ toolName: "", input: {} }),
      /toolRequest.toolName is required/
    );
  });
});

describe("ToolResult: creation and validation", () => {
  it("creates a valid success result", () => {
    const result = createToolResult({
      requestId: "treq_1",
      toolName: "inspect_project",
      status: "success",
      output: { name: "Bracket Study" },
      startedAt: new Date().toISOString()
    });
    assert.match(result.id, /^tres_/);
    assert.equal(result.error, null);
  });

  it("rejects a success result carrying a non-null error", () => {
    assert.throws(
      () =>
        assertToolResult({
          ...createToolResult({
            requestId: "treq_1",
            toolName: "x",
            status: "success",
            startedAt: new Date().toISOString()
          }),
          error: { kind: "invalid_input", message: "x" }
        }),
      /must be null when status is success/
    );
  });

  it("requires a structured error for an error result", () => {
    assert.throws(
      () =>
        createToolResult({
          requestId: "treq_1",
          toolName: "x",
          status: "error",
          startedAt: new Date().toISOString()
        }),
      /tool result error must be an object/
    );
  });

  it("rejects a function hidden inside output (JSON-safety)", () => {
    assert.throws(
      () =>
        createToolResult({
          requestId: "treq_1",
          toolName: "x",
          status: "success",
          output: { onDone: () => {} },
          startedAt: new Date().toISOString()
        }),
      /toolResult.output must be JSON-serializable/
    );
  });

  it("round-trips through JSON with full fidelity", () => {
    const result = createToolResult({
      requestId: "treq_1",
      toolName: "inspect_project",
      status: "success",
      output: { name: "Bracket Study", requirementCount: 2 },
      startedAt: new Date().toISOString()
    });
    assert.deepEqual(deserializeToolResult(serializeToolResult(result)), result);
  });
});
