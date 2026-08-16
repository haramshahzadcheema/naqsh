import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentDocumentInspection, EnvironmentObject, EnvironmentOperationResult, EnvironmentSession } from "@naqsh/schemas";
import { UNAVAILABLE_ENVIRONMENT_GEOMETRY } from "@naqsh/schemas";
import { createModifyEnvironmentObjectTool } from "../src/modify-environment-object-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/**
 * A minimal, hand-built fake `EnvironmentAdapter` -- NOT `@naqsh/adapters`'
 * real mock CAD environment. `packages/core` has no dependency on
 * `@naqsh/adapters` (by design -- core defines the contract, it never
 * depends on a concrete implementation), so its own tests must not import
 * that package either; this fake is the test-local stand-in every other
 * core test file that needs a collaborator it doesn't own already uses
 * (e.g. `fakeProvider` in proposal-generator.test.ts for `ModelProvider`).
 */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>): EnvironmentAdapter {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: null, openedAt: now(), metadata: {} };

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return {
      id: `envop_${Math.random()}`,
      operation,
      sessionId: session.id,
      objectId: null,
      status: "success",
      data,
      error: null,
      startedAt: now(),
      completedAt: now(),
      metadata: {}
    };
  }

  function err(operation: EnvironmentOperationResult["operation"], kind: "object_not_found" | "not_connected", message: string): EnvironmentOperationResult {
    return {
      id: `envop_${Math.random()}`,
      operation,
      sessionId: session.id,
      objectId: null,
      status: "error",
      data: null,
      error: { kind, message },
      startedAt: now(),
      completedAt: now(),
      metadata: {}
    };
  }

  return {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["modify"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => {
      const object = objects.get(objectId);
      return object ? ok("inspect_object", object) : err("inspect_object", "object_not_found", `No object "${objectId}"`);
    },
    createObject: async () => err("create_object", "object_not_found", "not supported by this fake"),
    modifyObject: async (_session, objectId, changes) => {
      const object = objects.get(objectId);
      if (!object) return err("modify_object", "object_not_found", `No object "${objectId}"`);
      const updated: EnvironmentObject = {
        ...object,
        properties: object.properties.map((property) =>
          property.key in changes ? { ...property, value: changes[property.key] } : property
        )
      };
      objects.set(objectId, updated);
      return ok("modify_object", updated);
    },
    deleteObject: async () => err("delete_object", "object_not_found", "not supported by this fake"),
    inspectDocument: async () => {
      const inspection: EnvironmentDocumentInspection = {
        environmentKind: "fake",
        documentId: null,
        documentName: session.documentName,
        filePath: null,
        objectCount: objects.size,
        objectIds: [...objects.keys()],
        rootObjectIds: [...objects.keys()],
        inspectedAt: now(),
        environmentVersion: "0.0.1",
        warnings: [],
        unsupportedFeatures: [],
        inspectionErrors: [],
        metadata: {}
      };
      return ok("inspect_document", inspection);
    },
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chk_1" }),
    restore: async () => ok("restore", null)
  };
}

function buildHarness() {
  const objects = new Map<string, EnvironmentObject>([
    [
      "envobj_1",
      {
        id: "envobj_1",
        type: "bracket",
        name: "Bracket",
        genericType: "unknown",
        parentId: null,
        visible: null,
        geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
        properties: [{ key: "material", value: "steel", readOnly: false }],
        relationships: [],
        metadata: {}
      }
    ]
  ]);
  const adapter = buildFakeAdapter(objects);
  let session: EnvironmentSession | null = null;
  const registry = createToolRegistry();
  const { tool, handler } = createModifyEnvironmentObjectTool(() => session, adapter);
  registry.register(tool, handler);
  return {
    registry,
    adapter,
    connect: async () => {
      const result = await adapter.connect();
      session = result.data as EnvironmentSession;
    },
    getObjects: () => objects
  };
}

describe("createModifyEnvironmentObjectTool: identity and classification", () => {
  it("is classified mutate/environment -- distinct from modify_object's world_model target", () => {
    const { tool } = createModifyEnvironmentObjectTool(() => null, buildFakeAdapter(new Map()));
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "environment");
    assert.equal(tool.name, "modify_environment_object");
  });
});

describe("createModifyEnvironmentObjectTool: real EnvironmentAdapter integration", () => {
  it("successfully modifies a property through the adapter boundary", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(result.status, "success");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "aluminum_6061");
  });

  it("CASE E: environment execution fails deterministically (unknown object) -- the failure is reported as an error, never as success", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_ghost", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });

  it("rejects when no environment session is connected, rather than throwing or silently no-op'ing", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});
