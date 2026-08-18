import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UNAVAILABLE_ENVIRONMENT_GEOMETRY, type EnvironmentObject, type EnvironmentOperationResult, type EnvironmentSession } from "@naqsh/schemas";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

/** A minimal, hand-built fake `EnvironmentAdapter` with a REAL createObject
 * implementation (mirrors the mock in-memory environment's own behavior:
 * mint an id, store the object, reject a colliding caller-supplied id) --
 * `packages/core` has no dependency on `@naqsh/adapters`, matching
 * `modify-environment-object-tool.test.ts`'s identical "test-local fake,
 * not the real package" precedent. */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>, options: { supportsCreate?: boolean } = {}): EnvironmentAdapter {
  const supportsCreate = options.supportsCreate ?? true;
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: null, openedAt: now(), metadata: {} };

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "conflict", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  let nextId = 1;

  return {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: supportsCreate ? ["create", "modify"] : ["modify"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => (objects.has(objectId) ? ok("inspect_object", objects.get(objectId)) : err("inspect_object", "unsupported_capability", "not used in this test")),
    createObject: async (_session, input) => {
      if (!supportsCreate) return err("create_object", "unsupported_capability", "create is not supported by this fake");
      const id = input.id ?? `envobj_${nextId++}`;
      if (objects.has(id)) return err("create_object", "conflict", `An object with id "${id}" already exists`);
      const object: EnvironmentObject = {
        id,
        type: input.type,
        name: input.name,
        genericType: input.genericType ?? "unknown",
        parentId: input.parentId ?? null,
        visible: input.visible ?? null,
        geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
        properties: (input.properties ?? []).map((p) => ({ key: p.key, value: p.value, readOnly: p.readOnly ?? false })),
        relationships: [],
        metadata: input.metadata ?? {}
      };
      objects.set(id, object);
      return ok("create_object", object);
    },
    modifyObject: async () => err("modify_object", "unsupported_capability", "not used in this test"),
    deleteObject: async () => err("delete_object", "unsupported_capability", "not used in this test"),
    inspectDocument: async () => err("inspect_document", "unsupported_capability", "not used in this test"),
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chk_1" }),
    restore: async () => ok("restore", null)
  };
}

function buildHarness(options: { supportsCreate?: boolean } = {}) {
  const objects = new Map<string, EnvironmentObject>();
  const adapter = buildFakeAdapter(objects, options);
  let session: EnvironmentSession | null = null;
  const registry = createToolRegistry();
  const { tool, handler } = createCreateEnvironmentObjectTool(() => session, adapter);
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

describe("createCreateEnvironmentObjectTool: identity and classification", () => {
  it("is classified mutate/environment", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("create_environment_object")!;
    assert.equal(tool.mutation, "mutate");
    assert.equal(tool.target, "environment");
  });
});

describe("createCreateEnvironmentObjectTool: Test 8 -- mock build creates a real environment object", () => {
  it("successfully creates an object through the adapter boundary", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "create_environment_object",
      input: { type: "part", name: "Mounting Plate", genericType: "solid", properties: { Length: 100, Width: 60, Height: 5 } }
    });
    assert.equal(result.status, "success");
    const output = result.output as { object: EnvironmentObject };
    assert.equal(output.object.type, "part");
    assert.equal(output.object.name, "Mounting Plate");
    assert.equal(getObjects().size, 1);
    assert.equal(getObjects().values().next().value!.properties.find((p) => p.key === "Length")!.value, 100);
  });
});

describe("createCreateEnvironmentObjectTool: Test 9 -- build failure is explicit, never a false success", () => {
  it("an adapter that does not support 'create' fails deterministically", async () => {
    const { registry, connect } = buildHarness({ supportsCreate: false });
    await connect();
    const { result } = await executeTool(registry, { toolName: "create_environment_object", input: { type: "part", name: "X" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
  });

  it("rejects when no environment session is connected", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "create_environment_object", input: { type: "part", name: "X" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a missing name", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, { toolName: "create_environment_object", input: { type: "part" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createCreateEnvironmentObjectTool: Test 12 -- real P4 authorization, not a bypass", () => {
  it("is rejected with policy_rejected when unauthorized, and creates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "create_environment_object",
      input: { type: "part", name: "Mounting Plate" },
      target: { entityType: "object", entityId: null },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(getObjects().size, 0);
  });

  it("succeeds once approved", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "create_environment_object", targetType: "object", targetId: null, reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "create_environment_object",
      input: { type: "part", name: "Mounting Plate" },
      target: { entityType: "object", entityId: null },
      authorize
    });
    assert.equal(result.status, "success");
    assert.equal(getObjects().size, 1);
  });
});
