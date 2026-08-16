import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentDocumentInspection, EnvironmentObject, EnvironmentOperationResult, EnvironmentSession } from "@naqsh/schemas";
import { UNAVAILABLE_ENVIRONMENT_GEOMETRY } from "@naqsh/schemas";
import { createModifyEnvironmentObjectTool } from "../src/modify-environment-object-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";

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

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown, metadata: Record<string, unknown> = {}): EnvironmentOperationResult {
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
      metadata
    };
  }

  function err(
    operation: EnvironmentOperationResult["operation"],
    kind: "object_not_found" | "not_connected" | "conflict",
    message: string
  ): EnvironmentOperationResult {
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
    modifyObject: async (_session, objectId, changes, options) => {
      const object = objects.get(objectId);
      if (!object) return err("modify_object", "object_not_found", `No object "${objectId}"`);

      if (options?.expectedBefore) {
        for (const key of Object.keys(options.expectedBefore)) {
          const property = object.properties.find((candidate) => candidate.key === key);
          if (!property || property.value !== options.expectedBefore[key]) {
            return err("modify_object", "conflict", `expectedBefore mismatch for "${key}"`);
          }
        }
      }

      const requestedKeys = Object.keys(changes);
      const beforeValues: Record<string, unknown> = {};
      for (const key of requestedKeys) {
        beforeValues[key] = object.properties.find((candidate) => candidate.key === key)?.value ?? null;
      }
      const alreadySatisfied = requestedKeys.length > 0 && requestedKeys.every((key) => beforeValues[key] === changes[key]);

      const updated: EnvironmentObject = alreadySatisfied
        ? object
        : {
            ...object,
            properties: object.properties.map((property) =>
              property.key in changes ? { ...property, value: changes[property.key] } : property
            )
          };
      objects.set(objectId, updated);

      const propertyChanges = requestedKeys.map((key) => ({
        key,
        before: beforeValues[key],
        requested: changes[key],
        after: updated.properties.find((candidate) => candidate.key === key)?.value ?? null
      }));
      return ok("modify_object", updated, { propertyChanges, alreadySatisfied });
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
        properties: [
          { key: "material", value: "steel", readOnly: false },
          { key: "length", value: 10, readOnly: false }
        ],
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

  it("Phase 14: returns {object, propertyChanges, alreadySatisfied} -- not a bare EnvironmentObject", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" }
    });
    assert.equal(result.status, "success");
    const output = result.output as { object: EnvironmentObject; propertyChanges: unknown[]; alreadySatisfied: boolean };
    assert.equal(output.object.id, "envobj_1");
    assert.equal(output.alreadySatisfied, false);
    assert.deepEqual(output.propertyChanges, [{ key: "material", before: "steel", requested: "aluminum_6061", after: "aluminum_6061" }]);
  });

  it("PHASE 14 AUDIT FIX: accepts a NUMERIC value through the real typed-tool boundary -- the exact FreeCAD Length case, previously rejected by the tool's own inputSchema before the handler ever ran", async () => {
    // Regression for a real, showstopping bug: modify_environment_object's
    // inputSchema originally declared `value: { type: "string" }`, so
    // `executeTool`'s own schema validation (matchesToolValueSchema)
    // rejected ANY numeric value as invalid_input before the adapter was
    // ever reached -- making Phase 14's actual flagship capability (setting
    // a real FreeCAD Length/Width/Height, a NUMBER) unreachable through the
    // only sanctioned path ("must use the existing typed tool system").
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "length", value: 42 }
    });
    assert.equal(result.status, "success");
    assert.equal(getObjects().get("envobj_1")!.properties[1]!.value, 42);
    const output = result.output as { propertyChanges: Array<{ key: string; before: unknown; requested: unknown; after: unknown }> };
    assert.deepEqual(output.propertyChanges, [{ key: "length", before: 10, requested: 42, after: 42 }]);
  });

  it("PHASE 14 AUDIT FIX: a numeric expectedBeforeValue is also accepted through the typed-tool boundary", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "length", value: 99, expectedBeforeValue: 10 }
    });
    assert.equal(result.status, "success");
  });

  it("Phase 14 Step 16: requesting the value already in place reports alreadySatisfied: true", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "steel" }
    });
    assert.equal(result.status, "success");
    const output = result.output as { alreadySatisfied: boolean };
    assert.equal(output.alreadySatisfied, true);
  });

  it("Phase 14 Step 14: expectedBeforeValue matching the current value allows the mutation", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061", expectedBeforeValue: "steel" }
    });
    assert.equal(result.status, "success");
  });

  it("Phase 14 Step 14: a stale expectedBeforeValue is rejected as execution_failure and mutates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061", expectedBeforeValue: "titanium" }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "execution_failure");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "steel");
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

describe("createModifyEnvironmentObjectTool: Phase 14 -- real P4 authorization, not a bypass", () => {
  // The generic agent-loop tests (agent-loop.test.ts's CASE E) already
  // prove "environment-target mutate tool only executes after approval"
  // using a FAKE registered tool. This proves the SAME invariant using the
  // REAL modify_environment_object tool and REAL P4 machinery
  // (ApprovalStore/createExecuteToolAuthorizer, unmodified) end to end --
  // Phase 14's new mutation capability is not secretly exempt from
  // approval just because it reaches a real environment.
  it("a mutate-classified call at autonomy level requiring approval is rejected with policy_rejected when no approval exists, and mutates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "envobj_1" },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "steel");
  });

  it("succeeds once a real, approved Approval for this exact tool+target exists", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "modify_environment_object", targetType: "object", targetId: "envobj_1", reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "envobj_1" },
      authorize
    });
    assert.equal(result.status, "success");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "aluminum_6061");
  });

  it("wrong scope: an approval for a DIFFERENT target object does not authorize this call, and mutates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    // Approved for a DIFFERENT object entirely -- must not cover envobj_1.
    const approval = approvals.create({ toolName: "modify_environment_object", targetType: "object", targetId: "some_other_object", reason: "test" });
    approvals.approve(approval.id, "human", "approved for test");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "envobj_1" },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "steel");
  });

  it("denied mutation: an explicitly REJECTED approval denies the call, and mutates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "modify_environment_object", targetType: "object", targetId: "envobj_1", reason: "test" });
    approvals.reject(approval.id, "human", "not approved");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const { result } = await executeTool(registry, {
      toolName: "modify_environment_object",
      input: { objectId: "envobj_1", propertyKey: "material", value: "aluminum_6061" },
      target: { entityType: "object", entityId: "envobj_1" },
      authorize
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "policy_rejected");
    assert.equal(getObjects().get("envobj_1")!.properties[0]!.value, "steel");
  });
});
