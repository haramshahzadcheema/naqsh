import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createDesignSpecification,
  createWorldModelState,
  UNAVAILABLE_ENVIRONMENT_GEOMETRY,
  type BuildResult,
  type Candidate,
  type DesignSpecificationInput,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type WorldModelState
} from "@naqsh/schemas";
import { verifyCandidateBuild } from "../src/candidate-verification.js";
import type { VerifyCandidateContext } from "../src/background-job-runner.js";
import { executeBuildForDesignSpecification } from "../src/build-executor.js";
import { createBuildResultStore } from "../src/build-result-store.js";
import { createCheckStore } from "../src/check-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createCreateEnvironmentObjectTool } from "../src/create-environment-object-tool.js";
import { createModifyEnvironmentObjectTool } from "../src/modify-environment-object-tool.js";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createRunVerificationTool } from "../src/run-verification-tool.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/**
 * `verifyCandidateBuild` (P25+, candidate-verification.ts) is the real
 * `verifyCandidate` hook wired into `apps/api/jobsWorkflow.ts`'s call to
 * `runBackgroundJob` -- this suite proves it against a REAL `BuildResult`
 * (produced by the real `executeBuildForDesignSpecification`, P20) and REAL
 * `create_check`/`run_verification` tool calls, never a hand-constructed
 * "pretend this passed" fixture.
 */

function buildFakeAdapter(objects: Map<string, EnvironmentObject>) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };
  let nextId = 1;

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown, metadata: Record<string, unknown> = {}): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "environment_failure" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  const adapter: EnvironmentAdapter = {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["create", "modify"], metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => {
      const object = objects.get(objectId as string);
      if (!object) return err("inspect_object" as never, "object_not_found", `No object "${objectId}"`);
      return ok("inspect_object" as never, object);
    },
    inspectDocument: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    createObject: async (_session, input) => {
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
    modifyObject: async (_session, objectId, changes) => {
      const object = objects.get(objectId);
      if (!object) return err("modify_object" as never, "object_not_found", `No object "${objectId}"`);
      const propertyChanges: { key: string; before: unknown; after: unknown }[] = [];
      for (const [key, value] of Object.entries(changes)) {
        const existing = object.properties.find((p) => p.key === key);
        propertyChanges.push({ key, before: existing?.value ?? null, after: value });
        if (existing) existing.value = value;
        else object.properties.push({ key, value, readOnly: false });
      }
      return ok("modify_object", object, { propertyChanges });
    },
    deleteObject: async () => err("unsupported_capability" as never, "unsupported_capability", "not used"),
    save: async () => ok("save", null),
    checkpoint: async () => ok("checkpoint", { checkpointId: "chkpt_unused" }),
    restore: async () => ok("restore", null)
  };

  return { adapter, session };
}

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket.",
    description: "A rectangular mounting plate.",
    components: [{ id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate" }],
    expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { mass: 3 } }],
    ...overrides
  };
}

function buildHarness() {
  const objects = new Map<string, EnvironmentObject>();
  const { adapter, session } = buildFakeAdapter(objects);
  const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const buildResultStore = createBuildResultStore();
  const checkStore = createCheckStore();
  const verificationResultStore = createVerificationResultStore();
  const registry = createToolRegistry();

  const getState = () => state;
  const getSession = () => session;

  const createTool = createCreateEnvironmentObjectTool(getSession, adapter);
  registry.register(createTool.tool, createTool.handler);
  const modifyTool = createModifyEnvironmentObjectTool(getSession, adapter);
  registry.register(modifyTool.tool, modifyTool.handler);
  const checkTool = createCreateCheckTool(checkStore, getState);
  registry.register(checkTool.tool, checkTool.handler);
  const verifyTool = createRunVerificationTool(getState, getSession, adapter, checkStore, verificationResultStore);
  registry.register(verifyTool.tool, verifyTool.handler);

  return { registry, buildResultStore, checkStore, verificationResultStore, getObjects: () => objects, projectVersion: state.project.version };
}

const dummyCandidate: Candidate = createCandidate({
  projectId: "proj_1",
  projectVersion: 1,
  planId: "plan_1",
  planStepId: "step_1",
  designSpecificationId: "design_1",
  hypothesis: "H",
  rationale: "R"
});

function verifyContext(harness: ReturnType<typeof buildHarness>, buildResult: BuildResult): VerifyCandidateContext {
  return {
    candidate: dummyCandidate,
    buildResult,
    registry: harness.registry,
    authorize: () => true,
    source: "agent",
    recordModelCall: () => {}
  };
}

describe("verifyCandidateBuild: create_environment_object candidates", () => {
  it("produces a real, PASSING VerificationResult for a numeric property the build actually set", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => true });
    assert.equal(buildResult.status, "completed");

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.equal(results.length, 1);
    const stored = harness.verificationResultStore.getById(results[0]!.id);
    assert.ok(stored);
    assert.equal(stored!.status, "pass");
    assert.equal(stored!.checkKind, "numeric_comparison");
  });

  it("produces a property_required check (not numeric_comparison) for a non-numeric property", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(
      designInput({ expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { material: "aluminum" } }] })
    );
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => true });
    assert.equal(buildResult.status, "completed");

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.equal(results.length, 1);
    const stored = harness.verificationResultStore.getById(results[0]!.id);
    assert.equal(stored!.checkKind, "property_required");
    assert.equal(stored!.status, "pass");
  });

  it("a build with MULTIPLE properties produces one check per property, all real and independently verifiable", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(
      designInput({ expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { mass: 3, material: "aluminum" } }] })
    );
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => true });

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.equal(results.length, 2);
    const statuses = results.map((r) => harness.verificationResultStore.getById(r.id)!.status);
    assert.deepEqual(statuses, ["pass", "pass"]);
  });
});

describe("verifyCandidateBuild: modify_environment_object candidates (targetObjectId set)", () => {
  it("verifies against the EXISTING object named by targetObjectId, not a newly created one", async () => {
    const harness = buildHarness();
    harness.getObjects().set("envobj_existing", {
      id: "envobj_existing",
      type: "sensor",
      name: "Load Sensor",
      genericType: "unknown",
      parentId: null,
      visible: null,
      geometry: UNAVAILABLE_ENVIRONMENT_GEOMETRY,
      properties: [],
      relationships: [],
      metadata: {}
    });
    const design = createDesignSpecification(
      designInput({ expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "sensor", environmentGenericType: null, properties: { calibration: 42 }, targetObjectId: "envobj_existing" }] })
    );
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => true });
    assert.equal(buildResult.status, "completed");

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.equal(results.length, 1);
    const stored = harness.verificationResultStore.getById(results[0]!.id);
    assert.equal(stored!.status, "pass");
  });
});

describe("verifyCandidateBuild: honesty -- never invents a result for what wasn't actually built", () => {
  it("a FAILED build produces zero verification results (no operation succeeded, so there is nothing real to check)", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput());
    // Deny authorization outright -- the build fails before anything is created.
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => false });
    assert.equal(buildResult.status, "failed");

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.deepEqual(results, []);
  });

  it("an empty expectedOutputs design's (empty) build produces zero verification results", async () => {
    const harness = buildHarness();
    const design = createDesignSpecification(designInput({ expectedOutputs: [] }));
    const buildResult = await executeBuildForDesignSpecification(harness.registry, design, harness.buildResultStore, { authorize: () => true });
    assert.equal(buildResult.operations.length, 0);

    const results = await verifyCandidateBuild(verifyContext(harness, buildResult));
    assert.deepEqual(results, []);
  });
});
