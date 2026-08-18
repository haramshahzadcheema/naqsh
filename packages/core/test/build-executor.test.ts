import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesignSpecification, UNAVAILABLE_ENVIRONMENT_GEOMETRY, type DesignSpecificationInput, type EnvironmentObject, type EnvironmentOperationResult, type EnvironmentSession } from "@naqsh/schemas";
import { planBuildOperations } from "../src/build-operations.js";
import { executeBuildForDesignSpecification, EMPTY_BUILD_REASON } from "../src/build-executor.js";
import { createBuildResultStore, deserializeBuildResultStore } from "../src/build-result-store.js";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createApprovalStore } from "../src/approval-store.js";
import { createAutonomyGrantStore } from "../src/autonomy-grant-store.js";
import { createExecuteToolAuthorizer } from "../src/authorization.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket for a 500 N vertical load.",
    description: "A rectangular mounting plate with a hole.",
    components: [
      { id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate, 100x60x5mm", dimensions: { length: 100, width: 60, thickness: 5 } },
      { id: "comp_hole", name: "Mounting Hole", type: "hole", geometryIntent: "6mm diameter hole" }
    ],
    expectedOutputs: [
      { id: "out_plate", componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { Length: 100, Width: 60, Height: 5 } },
      { id: "out_hole", componentId: "comp_hole", environmentObjectType: "part", environmentGenericType: "solid", properties: { Diameter: 6 } }
    ],
    relevantRequirementIds: ["req_load"],
    ...overrides
  };
}

describe("planBuildOperations: deterministic translation", () => {
  it("produces one operation per expectedOutput, in order, using the linked component's name", () => {
    const design = createDesignSpecification(designInput());
    const operations = planBuildOperations(design);
    assert.equal(operations.length, 2);
    assert.equal(operations[0]!.toolName, "create_environment_object");
    assert.equal((operations[0]!.input as { name: string }).name, "Mounting Plate");
    assert.equal((operations[1]!.input as { name: string }).name, "Mounting Hole");
  });

  it("produces no operations for a design with no expectedOutputs", () => {
    const design = createDesignSpecification(designInput({ expectedOutputs: [] }));
    assert.deepEqual(planBuildOperations(design), []);
  });

  it("is pure -- never mutates the design", () => {
    const design = createDesignSpecification(designInput());
    const before = JSON.stringify(design);
    planBuildOperations(design);
    assert.equal(JSON.stringify(design), before);
  });
});

/** Mirrors create-environment-object-tool.test.ts's fake adapter, with an
 * optional forced failure on the Nth createObject call to exercise
 * partial-build/fail-safely behavior. */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>, options: { failOnCallNumber?: number } = {}): EnvironmentAdapter {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: null, openedAt: now(), metadata: {} };
  let callCount = 0;
  let nextId = 1;

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "conflict", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  return {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["create"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    createObject: async (_session, input) => {
      callCount += 1;
      if (options.failOnCallNumber === callCount) {
        return err("create_object", "unsupported_capability", `forced failure on call ${callCount}`);
      }
      const id = `envobj_${nextId++}`;
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
    modifyObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    deleteObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    inspectDocument: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chk_1" }),
    restore: async () => ok("restore", null)
  };
}

function buildHarness(adapterOptions: { failOnCallNumber?: number } = {}) {
  const objects = new Map<string, EnvironmentObject>();
  const adapter = buildFakeAdapter(objects, adapterOptions);
  const registry = createToolRegistry();
  const { tool, handler } = createCreateEnvironmentObjectTool(() => session, adapter);
  registry.register(tool, handler);
  let session: EnvironmentSession | null = null;
  return {
    registry,
    getObjects: () => objects,
    connect: async () => {
      const result = await adapter.connect();
      session = result.data as EnvironmentSession;
    }
  };
}

describe("executeBuildForDesignSpecification: Test 8 -- successful mock build", () => {
  it("creates real environment objects for every expected output", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore);

    assert.equal(result.status, "completed");
    assert.equal(result.buildSuccess, true);
    assert.equal(result.operations.length, 2);
    assert.ok(result.operations.every((op) => op.status === "succeeded"));
    assert.equal(getObjects().size, 2);
    assert.equal(buildResultStore.getById(result.id)!.id, result.id);
  });
});

describe("executeBuildForDesignSpecification: Test 9/11 -- build failure is explicit, never a false success", () => {
  it("a failed operation stops the build; later operations are recorded skipped, not attempted", async () => {
    const { registry, connect, getObjects } = buildHarness({ failOnCallNumber: 1 });
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore);

    assert.equal(result.status, "failed");
    assert.equal(result.buildSuccess, false);
    assert.equal(result.operations[0]!.status, "failed");
    assert.equal(result.operations[1]!.status, "skipped");
    assert.equal(getObjects().size, 0);
  });

  it("PARTIAL BUILD: a failure on the SECOND operation preserves the first operation's genuine success -- never discarded", async () => {
    const { registry, connect, getObjects } = buildHarness({ failOnCallNumber: 2 });
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore);

    assert.equal(result.status, "failed");
    assert.equal(result.buildSuccess, false);
    assert.equal(result.operations[0]!.status, "succeeded");
    assert.equal(result.operations[1]!.status, "failed");
    assert.equal(getObjects().size, 1, "the one object that DID get created must still exist -- a failed build does not roll back or hide prior real progress");
  });

  it("an EMPTY design (no expectedOutputs) is never reported as a successful build", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput({ expectedOutputs: [] }));

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore);

    assert.equal(result.status, "failed");
    assert.equal(result.buildSuccess, false);
    assert.equal(result.metadata.reason, EMPTY_BUILD_REASON);
  });
});

describe("executeBuildForDesignSpecification: Test 12 -- respects real P4 authorization", () => {
  it("is rejected with policy_rejected when unauthorized, and creates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore, { authorize });

    assert.equal(result.status, "failed");
    assert.equal(result.buildSuccess, false);
    assert.ok(result.operations.every((op) => op.status === "failed" || op.status === "skipped"));
    assert.equal(getObjects().size, 0);
  });

  it("an explicitly REJECTED approval denies the build, and creates nothing", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    const approval = approvals.create({ toolName: "create_environment_object", targetType: null, targetId: null, reason: "test" });
    approvals.reject(approval.id, "human", "not approved");
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "approved_modify", approvals, autonomyGrants });

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore, { authorize });

    assert.equal(result.status, "failed");
    assert.equal(result.buildSuccess, false);
    assert.equal(result.operations[0]!.status, "failed");
    assert.equal(result.operations[0]!.error?.kind, "policy_rejected");
    assert.equal(getObjects().size, 0);
  });

  it("succeeds when every operation is approved", async () => {
    const { registry, connect, getObjects } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());
    const approvals = createApprovalStore();
    const autonomyGrants = createAutonomyGrantStore();
    // A blanket AutonomyGrant covering create_environment_object is simpler
    // to set up for N operations than N individual Approvals, and proves
    // the SAME real P4 primitive (AutonomyGrant, not a new mechanism).
    autonomyGrants.create({ toolNames: ["create_environment_object"], targetType: null, targetId: null, reason: "test", grantedBy: "human" });
    const authorize = createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals, autonomyGrants });

    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore, { authorize });

    assert.equal(result.status, "completed");
    assert.equal(result.buildSuccess, true);
    assert.equal(getObjects().size, 2);
  });
});

describe("executeBuildForDesignSpecification: Test 14 -- serialization", () => {
  it("BuildResult (with operations) survives a round trip through the store", async () => {
    const { registry, connect } = buildHarness();
    await connect();
    const buildResultStore = createBuildResultStore();
    const design = createDesignSpecification(designInput());
    const result = await executeBuildForDesignSpecification(registry, design, buildResultStore);

    const restoredStore = deserializeBuildResultStore(buildResultStore.serialize());
    assert.deepEqual(restoredStore.getById(result.id), result);
  });
});
