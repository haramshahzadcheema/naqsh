import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type WorldModelState } from "@naqsh/schemas";
import { createObservationTool } from "../src/observation-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function buildState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_1", description: "Max mass 350g" }],
      objects: [{ id: "obj_1", type: "part", name: "Bracket" }],
      relationships: [{ type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_1" }]
    },
    session: { focusObjectIds: ["obj_1"] }
  });
}

function buildRegistry(getState: () => WorldModelState) {
  const registry = createToolRegistry();
  const { tool, handler } = createObservationTool(getState);
  registry.register(tool, handler);
  return registry;
}

describe("createObservationTool: identity and classification", () => {
  it("is classified observe/world_model -- the permission-relevant metadata", () => {
    const { tool } = createObservationTool(() => buildState());
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "world_model");
    assert.equal(tool.name, "observe_project");
  });

  it("declares a typed input schema and a typed output schema", () => {
    const { tool } = createObservationTool(() => buildState());
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema.type, "object");
  });
});

describe("createObservationTool: valid calls reach the deterministic observation layer", () => {
  it("scope 'project' returns a full ObservationResult through executeTool", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    assert.equal(result.status, "success");
    const output = result.output as { scope: string; requirements: unknown[] };
    assert.equal(output.scope, "project");
    assert.equal(output.requirements.length, 1);
  });

  it("scope 'focus' returns the focused subset", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "observe_project", input: { scope: "focus" } });
    assert.equal(result.status, "success");
    assert.equal((result.output as { scope: string }).scope, "focus");
  });

  it("scope 'object' with a valid objectId returns the object-scoped observation", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "observe_project",
      input: { scope: "object", objectId: "obj_1" }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { scopeObjectId: string }).scopeObjectId, "obj_1");
  });

  it("reads state fresh via getState() on every call -- not a captured snapshot", async () => {
    let callCount = 0;
    const registry = buildRegistry(() => {
      callCount++;
      return buildState();
    });
    await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    assert.equal(callCount, 2);
  });
});

describe("createObservationTool: input validation (the schema-validated boundary)", () => {
  it("rejects a missing scope with invalid_input, before the handler runs", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "observe_project", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects an invalid scope enum value", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "observe_project",
      input: { scope: "everything" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects scope:'object' with a missing objectId (the cross-field check ToolValueSchema itself cannot express)", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, { toolName: "observe_project", input: { scope: "object" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects scope:'object' with an empty-string objectId", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "observe_project",
      input: { scope: "object", objectId: "" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("maps a nonexistent objectId (ObservationError entity_not_found) onto ToolError invalid_input", async () => {
    const registry = buildRegistry(() => buildState());
    const { result } = await executeTool(registry, {
      toolName: "observe_project",
      input: { scope: "object", objectId: "does_not_exist" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createObservationTool: output validation", () => {
  it("a genuine ObservationResult always satisfies the declared outputSchema", async () => {
    // Exercised implicitly by every success-path test above (executeTool
    // validates output against outputSchema before returning success) --
    // this test makes that guarantee explicit and adds an empty-project
    // case, the shape most likely to trip up a schema that assumes
    // non-empty arrays.
    const emptyState = createWorldModelState({
      project: { name: "x", description: "x", objective: { summary: "" } },
      session: {}
    });
    const registry = buildRegistry(() => emptyState);
    const { result } = await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    assert.equal(result.status, "success");
  });
});

describe("createObservationTool: read-only guarantee", () => {
  it("never mutates the WorldModelState returned by getState", async () => {
    const state = buildState();
    const before = JSON.parse(JSON.stringify(state));
    const registry = buildRegistry(() => state);
    await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    await executeTool(registry, { toolName: "observe_project", input: { scope: "focus" } });
    await executeTool(registry, { toolName: "observe_project", input: { scope: "object", objectId: "obj_1" } });
    assert.deepEqual(state, before);
  });

  it("the tool's mutation classification IS \"observe\" -- a future authorize hook can gate on this without inspecting behavior", () => {
    const { tool } = createObservationTool(() => buildState());
    assert.equal(tool.mutation, "observe");
  });
});

describe("createObservationTool: auditability", () => {
  it("every call produces a ToolRequest/ToolResult pair with a stable requestId, like any other tool", async () => {
    const registry = buildRegistry(() => buildState());
    const { request, result } = await executeTool(registry, { toolName: "observe_project", input: { scope: "project" } });
    assert.equal(result.requestId, request.id);
    assert.equal(result.toolName, "observe_project");
  });
});
