import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, type EnvironmentObject, type EnvironmentOperationResult, type EnvironmentSession, type VerificationResult, type WorldModelState } from "@naqsh/schemas";
import { createRunVerificationTool } from "../src/run-verification-tool.js";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createCheckStore } from "../src/check-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/** Same discipline as restore-checkpoint-tool.test.ts's own fake adapter:
 * a minimal, hand-built `EnvironmentAdapter` with genuine (not canned)
 * inspectObject semantics plus fault injection, never a dependency on
 * @naqsh/adapters. */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };
  const faults = { failInspect: false };

  function ok(operation: EnvironmentOperationResult["operation"], data: unknown): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "success", data, error: null, startedAt: now(), completedAt: now(), metadata: {} };
  }
  function err(operation: EnvironmentOperationResult["operation"], kind: "unsupported_capability" | "environment_failure" | "object_not_found", message: string): EnvironmentOperationResult {
    return { id: `envop_${Math.random()}`, operation, sessionId: session.id, objectId: null, status: "error", data: null, error: { kind, message }, startedAt: now(), completedAt: now(), metadata: {} };
  }

  const adapter: EnvironmentAdapter = {
    describe: () => ({ kind: "fake", name: "Fake Environment", version: "0.0.1", capabilities: ["modify"] as never, metadata: {} }),
    health: async () => ok("health", { status: "healthy", message: "", checkedAt: now() }),
    connect: async () => ok("connect", session),
    disconnect: async () => ok("disconnect", null),
    listObjects: async () => ok("list_objects", [...objects.values()]),
    inspectObject: async (_session, objectId) => {
      if (faults.failInspect) return err("inspect_object", "environment_failure", "simulated inspection failure");
      const object = objects.get(objectId);
      return object ? ok("inspect_object", object) : err("inspect_object", "object_not_found", `No object "${objectId}"`);
    },
    inspectDocument: async () => err("inspect_document", "unsupported_capability", "not implemented in fake"),
    createObject: async () => err("create_object", "unsupported_capability", "not supported by this fake"),
    modifyObject: async (_session, objectId, changes) => {
      const object = objects.get(objectId);
      if (!object) return err("modify_object", "object_not_found", `No object "${objectId}"`);
      const updated = { ...object, properties: object.properties.map((p) => (p.key in changes ? { ...p, value: changes[p.key] } : p)) };
      objects.set(objectId, updated);
      return ok("modify_object", updated);
    },
    deleteObject: async () => err("delete_object", "unsupported_capability", "not supported by this fake"),
    save: async () => ok("save", null),
    checkpoint: async () => err("checkpoint", "unsupported_capability", "not supported by this fake"),
    restore: async () => err("restore", "unsupported_capability", "not supported by this fake")
  };

  return { adapter, session, faults };
}

function buildState(): WorldModelState {
  return createWorldModelState({ project: { id: "proj_1", name: "Test Project" }, session: { id: "sess_wm_1" } });
}

function buildHarness(options: { connectSession?: boolean } = {}) {
  const objects = new Map<string, EnvironmentObject>([
    [
      "envobj_1",
      {
        id: "envobj_1",
        type: "bracket",
        name: "Bracket",
        genericType: "solid",
        parentId: null,
        visible: null,
        geometry: { available: false, reason: "no_shape", valid: null, boundingBox: null, volume: null, surfaceArea: null, centerOfMass: null, solidCount: null, faceCount: null, edgeCount: null, vertexCount: null, shapeType: null },
        properties: [{ key: "diameter", value: 15, readOnly: false }],
        relationships: [],
        metadata: {}
      }
    ]
  ]);
  const { adapter, session, faults } = buildFakeAdapter(objects);
  const state = buildState();
  const checkStore = createCheckStore();
  const verificationResultStore = createVerificationResultStore();
  let connectedSession: EnvironmentSession | null = options.connectSession === false ? null : session;

  const registry = createToolRegistry();
  const createCheck = createCreateCheckTool(checkStore, () => state);
  const runVerification = createRunVerificationTool(() => state, () => connectedSession, adapter, checkStore, verificationResultStore);
  registry.register(createCheck.tool, createCheck.handler);
  registry.register(runVerification.tool, runVerification.handler);

  return { registry, adapter, faults, checkStore, verificationResultStore, getState: () => state, disconnectSession: () => (connectedSession = null), getObjects: () => objects };
}

async function createNumericCheck(registry: ReturnType<typeof createToolRegistry>, overrides: Record<string, unknown> = {}) {
  const { result } = await executeTool(registry, {
    toolName: "create_check",
    input: { kind: "numeric_comparison", description: "diameter <= 20mm", objectId: "envobj_1", property: "diameter", operator: "lte", expectedValue: 20, ...overrides }
  });
  assert.equal(result.status, "success");
  return (result.output as { check: { id: string } } ).check;
}

describe("createRunVerificationTool: identity and classification", () => {
  it("is classified verify/verification -- the exact classification P3/P4 reserved for this from the start", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("run_verification")!;
    assert.equal(tool.mutation, "verify");
    assert.equal(tool.target, "verification");
  });
});

describe("createRunVerificationTool: PASS", () => {
  it("PASS: current environment value satisfies the check", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    assert.equal(result.status, "success");
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.status, "pass");
    assert.equal(output.actual, 15);
  });
});

describe("createRunVerificationTool: FAIL", () => {
  it("FAIL: current environment value violates the check", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry, { expectedValue: 10 });
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.status, "fail");
    assert.equal(output.reasonKind, "violated");
  });

  it("FAIL: the target object is confirmed not to exist -- a definitive observation, not an inconclusive one", async () => {
    const { registry } = buildHarness();
    const { result: createResult } = await executeTool(registry, { toolName: "create_check", input: { kind: "object_exists", description: "x", objectId: "envobj_missing" } });
    const check = (createResult.output as { check: { id: string } }).check;
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.status, "fail");
    assert.equal(output.reasonKind, "object_not_found");
  });
});

describe("createRunVerificationTool: INCONCLUSIVE", () => {
  it("INCONCLUSIVE: no environment session connected -- never silently treated as pass or fail", async () => {
    const { registry } = buildHarness({ connectSession: false });
    const check = await createNumericCheck(registry);
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.status, "inconclusive");
    assert.equal(output.reasonKind, "evidence_missing");
  });

  it("INCONCLUSIVE: the observation itself genuinely fails (not 'object not found') -- distinguished from a confirmed-absent object", async () => {
    const { registry, faults } = buildHarness();
    const check = await createNumericCheck(registry);
    faults.failInspect = true;
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.status, "inconclusive");
    assert.equal(output.reasonKind, "evidence_missing");
  });

  it("check_not_found: fails the TOOL call outright (invalid_input), not a fabricated VerificationResult", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: "check_nonexistent" } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });
});

describe("createRunVerificationTool: the demo story -- verify, change something, verify again", () => {
  it("confirms the result CHANGES after the underlying environment changes -- proves this is real observation, not a cached/fabricated answer", async () => {
    const { registry, adapter } = buildHarness();
    const check = await createNumericCheck(registry, { expectedValue: 20 });

    const { result: before } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    assert.equal((before.output as { result: VerificationResult }).result.status, "pass");

    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { diameter: 24 });

    const { result: after } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const afterResult = (after.output as { result: VerificationResult }).result;
    assert.equal(afterResult.status, "fail");
    assert.equal(afterResult.actual, 24);
  });
});

describe("createRunVerificationTool: persistence and purity", () => {
  it("persists every VerificationResult to the store, matching the returned output exactly", async () => {
    const { registry, verificationResultStore } = buildHarness();
    const check = await createNumericCheck(registry);
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.deepEqual(verificationResultStore.getById(output.id), output);
  });

  it("never mutates the World Model or the environment -- state and objects are byte-for-byte unchanged after a verify call", async () => {
    const { registry, getState, getObjects } = buildHarness();
    const check = await createNumericCheck(registry);
    const stateBefore = JSON.stringify(getState());
    const objectsBefore = JSON.stringify([...getObjects().values()]);
    await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    assert.equal(JSON.stringify(getState()), stateBefore);
    assert.equal(JSON.stringify([...getObjects().values()]), objectsBefore);
  });

  it("records the projectId/projectVersion the result was actually evaluated against", async () => {
    const { registry, getState } = buildHarness();
    const check = await createNumericCheck(registry);
    const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const output = (result.output as { result: VerificationResult }).result;
    assert.equal(output.projectId, getState().project.id);
    assert.equal(output.projectVersion, getState().project.version);
  });

  it("two runs of the same check with unchanged evidence produce distinct result ids but the same logical outcome", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    const { result: r1 } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const { result: r2 } = await executeTool(registry, { toolName: "run_verification", input: { checkId: check.id } });
    const o1 = (r1.output as { result: VerificationResult }).result;
    const o2 = (r2.output as { result: VerificationResult }).result;
    assert.notEqual(o1.id, o2.id);
    assert.equal(o1.status, o2.status);
    assert.equal(o1.reasonKind, o2.reasonKind);
  });
});
