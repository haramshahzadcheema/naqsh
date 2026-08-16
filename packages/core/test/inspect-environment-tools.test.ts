import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNAVAILABLE_ENVIRONMENT_GEOMETRY, type EnvironmentDocumentInspection, type EnvironmentObject, type EnvironmentOperationResult, type EnvironmentSession } from "@naqsh/schemas";
import { createInspectEnvironmentDocumentTool } from "../src/inspect-environment-document-tool.js";
import { createInspectEnvironmentObjectsTool } from "../src/inspect-environment-objects-tool.js";
import { createInspectEnvironmentObjectTool } from "../src/inspect-environment-object-tool.js";
import { createInspectEnvironmentRelationshipsTool } from "../src/inspect-environment-relationships-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/**
 * Phase 13's four observe-tier inspection tools, all covered from one file
 * since they share a single fake `EnvironmentAdapter` fixture -- the same
 * "test-local fake, no cross-package dependency on @naqsh/adapters"
 * convention `modify-environment-object-tool.test.ts` already established
 * (see that file's own doc comment for why).
 */

function buildFakeAdapter(objects: Map<string, EnvironmentObject>): EnvironmentAdapter {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake-doc", openedAt: now(), metadata: {} };

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }

  function err(operation: EnvironmentOperationResult["operation"], kind: "object_not_found" | "not_connected", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  return {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: [], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => {
      const object = objects.get(objectId);
      return object ? ok("inspect_object", object) : err("inspect_object", "object_not_found", `No object "${objectId}"`);
    },
    inspectDocument: async () => {
      const inspection: EnvironmentDocumentInspection = {
        environmentKind: "fake",
        documentId: null,
        documentName: session.documentName,
        filePath: null,
        objectCount: objects.size,
        objectIds: [...objects.keys()].sort(),
        rootObjectIds: [...objects.values()].filter((object) => object.parentId === null).map((object) => object.id).sort(),
        inspectedAt: now(),
        environmentVersion: "0.0.1",
        warnings: [],
        unsupportedFeatures: [],
        inspectionErrors: [],
        metadata: {}
      };
      return ok("inspect_document", inspection);
    },
    createObject: async () => err("object_not_found" as never, "object_not_found", "not supported by this fake"),
    modifyObject: async () => err("object_not_found" as never, "object_not_found", "not supported by this fake"),
    deleteObject: async () => err("object_not_found" as never, "object_not_found", "not supported by this fake"),
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chk_1" }),
    restore: async () => ok("restore", null)
  };
}

function buildObjects(): Map<string, EnvironmentObject> {
  return new Map<string, EnvironmentObject>([
    [
      "envobj_1",
      {
        id: "envobj_1",
        type: "Part::Box",
        name: "Box1",
        genericType: "solid",
        parentId: "envobj_2",
        visible: true,
        geometry: { ...UNAVAILABLE_ENVIRONMENT_GEOMETRY, available: true, volume: 42 },
        properties: [{ key: "Length", value: 10, readOnly: false }],
        relationships: [{ type: "references", targetId: "envobj_3", metadata: {} }],
        metadata: {}
      }
    ],
    [
      "envobj_2",
      {
        id: "envobj_2",
        type: "App::Part",
        name: "Assembly",
        genericType: "container",
        parentId: null,
        visible: true,
        geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
        properties: [],
        relationships: [{ type: "contains", targetId: "envobj_1", metadata: {} }],
        metadata: {}
      }
    ]
  ]);
}

describe("createInspectEnvironmentDocumentTool", () => {
  it("is classified observe/environment, never mutate", () => {
    const { tool } = createInspectEnvironmentDocumentTool(() => null, buildFakeAdapter(new Map()));
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "environment");
    assert.equal(tool.name, "inspect_environment_document");
  });

  it("returns the document inspection through the adapter boundary", async () => {
    const objects = buildObjects();
    const adapter = buildFakeAdapter(objects);
    let session: EnvironmentSession | null = null;
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentDocumentTool(() => session, adapter);
    registry.register(tool, handler);
    session = (await adapter.connect()).data as EnvironmentSession;

    const { result } = await executeTool(registry, { toolName: "inspect_environment_document", input: {} });
    assert.equal(result.status, "success");
    const inspection = result.output as EnvironmentDocumentInspection;
    assert.equal(inspection.objectCount, 2);
    assert.equal(inspection.documentName, "fake-doc");
  });

  it("rejects when no session is connected", async () => {
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentDocumentTool(() => null, buildFakeAdapter(new Map()));
    registry.register(tool, handler);
    const { result } = await executeTool(registry, { toolName: "inspect_environment_document", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createInspectEnvironmentObjectsTool", () => {
  it("is classified observe/environment", () => {
    const { tool } = createInspectEnvironmentObjectsTool(() => null, buildFakeAdapter(new Map()));
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "environment");
    assert.equal(tool.name, "inspect_environment_objects");
  });

  it("returns every object with its Phase 13 fields intact", async () => {
    const objects = buildObjects();
    const adapter = buildFakeAdapter(objects);
    let session: EnvironmentSession | null = null;
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentObjectsTool(() => session, adapter);
    registry.register(tool, handler);
    session = (await adapter.connect()).data as EnvironmentSession;

    const { result } = await executeTool(registry, { toolName: "inspect_environment_objects", input: {} });
    assert.equal(result.status, "success");
    const returned = result.output as EnvironmentObject[];
    assert.equal(returned.length, 2);
    const box = returned.find((object) => object.id === "envobj_1")!;
    assert.equal(box.genericType, "solid");
    assert.equal(box.parentId, "envobj_2");
    assert.equal(box.geometry.volume, 42);
  });
});

describe("createInspectEnvironmentObjectTool", () => {
  it("is classified observe/environment", () => {
    const { tool } = createInspectEnvironmentObjectTool(() => null, buildFakeAdapter(new Map()));
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "environment");
    assert.equal(tool.name, "inspect_environment_object");
  });

  it("returns exactly the requested object", async () => {
    const objects = buildObjects();
    const adapter = buildFakeAdapter(objects);
    let session: EnvironmentSession | null = null;
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentObjectTool(() => session, adapter);
    registry.register(tool, handler);
    session = (await adapter.connect()).data as EnvironmentSession;

    const { result } = await executeTool(registry, { toolName: "inspect_environment_object", input: { objectId: "envobj_2" } });
    assert.equal(result.status, "success");
    const object = result.output as EnvironmentObject;
    assert.equal(object.id, "envobj_2");
    assert.equal(object.genericType, "container");
  });

  it("CASE: unknown object fails deterministically, never reported as success", async () => {
    const adapter = buildFakeAdapter(buildObjects());
    let session: EnvironmentSession | null = null;
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentObjectTool(() => session, adapter);
    registry.register(tool, handler);
    session = (await adapter.connect()).data as EnvironmentSession;

    const { result } = await executeTool(registry, { toolName: "inspect_environment_object", input: { objectId: "ghost" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });

  it("rejects a missing/empty objectId before ever reaching the adapter", async () => {
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentObjectTool(() => null, buildFakeAdapter(new Map()));
    registry.register(tool, handler);
    const { result } = await executeTool(registry, { toolName: "inspect_environment_object", input: { objectId: "" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createInspectEnvironmentRelationshipsTool", () => {
  it("is classified observe/environment", () => {
    const { tool } = createInspectEnvironmentRelationshipsTool(() => null, buildFakeAdapter(new Map()));
    assert.equal(tool.mutation, "observe");
    assert.equal(tool.target, "environment");
    assert.equal(tool.name, "inspect_environment_relationships");
  });

  it("returns a lighter view: id/genericType/parentId/relationships only, no properties", async () => {
    const objects = buildObjects();
    const adapter = buildFakeAdapter(objects);
    let session: EnvironmentSession | null = null;
    const registry = createToolRegistry();
    const { tool, handler } = createInspectEnvironmentRelationshipsTool(() => session, adapter);
    registry.register(tool, handler);
    session = (await adapter.connect()).data as EnvironmentSession;

    const { result } = await executeTool(registry, { toolName: "inspect_environment_relationships", input: {} });
    assert.equal(result.status, "success");
    const returned = result.output as Array<{ id: string; genericType: string; parentId: string | null; relationships: unknown[] }>;
    assert.equal(returned.length, 2);
    for (const entry of returned) {
      assert.equal(Object.hasOwn(entry, "properties"), false);
    }
    const assembly = returned.find((entry) => entry.id === "envobj_2")!;
    assert.deepEqual(assembly.relationships, [{ type: "contains", targetId: "envobj_1", metadata: {} }]);
  });
});
