import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVerificationResult,
  createWorldModelState,
  type EnvironmentObject,
  type EnvironmentOperationResult,
  type EnvironmentSession,
  type ObjectiveSatisfactionResult,
  type WorldModelState
} from "@naqsh/schemas";
import { createEvaluateObjectiveSatisfactionTool } from "../src/evaluate-objective-satisfaction-tool.js";
import { createRunVerificationTool } from "../src/run-verification-tool.js";
import { createCreateCheckTool } from "../src/create-check-tool.js";
import { createCheckStore } from "../src/check-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createObjectiveSatisfactionStore } from "../src/objective-satisfaction-store.js";
import { createChangeHistory } from "../src/change-history.js";
import { recordTransition } from "../src/record-transition.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import type { EnvironmentAdapter } from "../src/environment-adapter.js";

/** Same discipline as run-verification-tool.test.ts's own fake adapter. */
function buildFakeAdapter(objects: Map<string, EnvironmentObject>) {
  const now = () => new Date().toISOString();
  const session: EnvironmentSession = { id: "sess_1", environmentKind: "fake", status: "connected", documentName: "fake.doc", openedAt: now(), metadata: {} };

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

  return { adapter, session };
}

function buildState(): WorldModelState {
  const state = createWorldModelState({ project: { id: "proj_1", name: "Test Project", objective: { summary: "bracket must support 50kg" } }, session: { id: "sess_wm_1" } });
  const withConstraint = recordTransition(createChangeHistory(), state, { kind: "add_constraint", constraint: { id: "constraint_hard_1", description: "thickness >= 5mm", category: "geometry", severity: "hard" } });
  return withConstraint.state;
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
        properties: [{ key: "thickness", value: 6, readOnly: false }],
        relationships: [],
        metadata: {}
      }
    ]
  ]);
  const { adapter, session } = buildFakeAdapter(objects);
  let state = buildState();
  const checkStore = createCheckStore();
  const verificationResultStore = createVerificationResultStore();
  const objectiveSatisfactionStore = createObjectiveSatisfactionStore();
  let connectedSession: EnvironmentSession | null = options.connectSession === false ? null : session;

  const registry = createToolRegistry();
  const createCheck = createCreateCheckTool(checkStore);
  const runVerification = createRunVerificationTool(() => state, () => connectedSession, adapter, checkStore, verificationResultStore);
  const evaluateObjective = createEvaluateObjectiveSatisfactionTool(() => state, verificationResultStore, objectiveSatisfactionStore);
  registry.register(createCheck.tool, createCheck.handler);
  registry.register(runVerification.tool, runVerification.handler);
  registry.register(evaluateObjective.tool, evaluateObjective.handler);

  return { registry, adapter, checkStore, verificationResultStore, objectiveSatisfactionStore, getState: () => state, getObjects: () => objects };
}

async function createNumericCheck(registry: ReturnType<typeof createToolRegistry>, overrides: Record<string, unknown> = {}) {
  const { result } = await executeTool(registry, {
    toolName: "create_check",
    input: { kind: "numeric_comparison", description: "thickness >= 5mm", objectId: "envobj_1", property: "thickness", operator: "gte", expectedValue: 5, ...overrides }
  });
  assert.equal(result.status, "success");
  return (result.output as { check: { id: string } }).check;
}

async function runVerify(registry: ReturnType<typeof createToolRegistry>, checkId: string) {
  const { result } = await executeTool(registry, { toolName: "run_verification", input: { checkId } });
  assert.equal(result.status, "success");
}

describe("createEvaluateObjectiveSatisfactionTool: identity and classification", () => {
  it("is classified verify/verification -- the same classification run_verification uses", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("evaluate_objective_satisfaction")!;
    assert.equal(tool.mutation, "verify");
    assert.equal(tool.target, "verification");
  });
});

describe("createEvaluateObjectiveSatisfactionTool: full pipeline (create_check -> run_verification -> evaluate)", () => {
  it("SATISFIED: a single passing required condition", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);

    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal(result.status, "success");
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.status, "satisfied");
    assert.equal(output.objectiveSummary, "bracket must support 50kg");
  });

  it("the demo story: verify, change the environment, re-verify, re-evaluate -- the objective result CHANGES", async () => {
    const { registry, adapter } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);

    const { result: before } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal((before.output as { result: ObjectiveSatisfactionResult }).result.status, "satisfied");

    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { thickness: 2 }); // now violates >= 5mm
    await runVerify(registry, check.id);

    const { result: after } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal((after.output as { result: ObjectiveSatisfactionResult }).result.status, "not_satisfied");
  });

  it("uses the MOST RECENT VerificationResult for a check when verificationResultId is omitted", async () => {
    const { registry, adapter } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id); // thickness=6, passes

    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { thickness: 1 });
    await runVerify(registry, check.id); // now fails -- this is the LATEST result

    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal((result.output as { result: ObjectiveSatisfactionResult }).result.status, "not_satisfied");
  });

  it("pins to a SPECIFIC verificationResultId when provided, even if a newer result exists", async () => {
    const { registry, adapter, verificationResultStore } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id); // thickness=6, passes -- capture this id
    const firstResultId = verificationResultStore.listForCheck(check.id)[0]!.id;

    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { thickness: 1 });
    await runVerify(registry, check.id); // now fails

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, verificationResultId: firstResultId }] }
    });
    // Pinned to the OLD (passing) result -- but that result's own
    // projectVersion no longer matches the current project version (the
    // fake adapter's modifyObject doesn't bump WorldModelState.project.version,
    // so this specific harness keeps the version constant; this test's real
    // point is that the SPECIFIC id was honored, not "most recent").
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.conditions[0]!.verificationResultId, firstResultId);
  });
});

describe("createEvaluateObjectiveSatisfactionTool: cross-project isolation", () => {
  it("AUDIT FIX -- a verificationResultId pinned to a result from a DIFFERENT project is never treated as evidence for this objective", async () => {
    const { registry, verificationResultStore } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);
    const realResultId = verificationResultStore.listForCheck(check.id)[0]!.id;

    // Simulate a result that genuinely belongs to a different project but
    // happens to reuse the same store (VerificationResultStore is global,
    // not project-scoped -- see P16).
    const foreignResult = createVerificationResult({
      checkId: check.id,
      checkKind: "numeric_comparison",
      status: "pass",
      reasonKind: "satisfied",
      message: "looks fine over there",
      projectId: "proj_completely_different",
      projectVersion: 1
    });
    verificationResultStore.save(foreignResult);

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, verificationResultId: foreignResult.id }] }
    });
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.status, "inconclusive");
    assert.equal(output.conditions[0]!.reasonKind, "verification_result_wrong_project");
    assert.notEqual(foreignResult.id, realResultId); // sanity: these really are two different results
  });
});

describe("createEvaluateObjectiveSatisfactionTool: caller-supplied extra input fields cannot override the deterministic verdict", () => {
  it("an input payload carrying extra fields like status/forceSatisfied/override alongside a genuinely failing condition still produces NOT_SATISFIED -- the tool only ever reads 'conditions'", async () => {
    const { registry, adapter } = buildHarness();
    const check = await createNumericCheck(registry);
    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { thickness: 1 }); // violates >= 5mm
    await runVerify(registry, check.id);

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: {
        conditions: [{ checkId: check.id }],
        status: "satisfied",
        forceSatisfied: true,
        override: "satisfied",
        reason: "trust me, Gemini says it's fine"
      }
    });
    assert.equal(result.status, "success");
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.status, "not_satisfied");
    assert.notEqual(output.reason, "trust me, Gemini says it's fine");
  });
});

describe("createEvaluateObjectiveSatisfactionTool: hard constraints cannot be marked optional", () => {
  it("rejects required: false when constraintId names a real hard constraint", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, constraintId: "constraint_hard_1", required: false }] }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
    assert.match(result.error!.message, /hard_constraint_cannot_be_optional/);
  });

  it("a hard constraint's violated condition forces NOT_SATISFIED even without explicitly passing required: true", async () => {
    const { registry, adapter } = buildHarness();
    const check = await createNumericCheck(registry);
    const session = (await adapter.connect()).data as EnvironmentSession;
    await adapter.modifyObject(session, "envobj_1", { thickness: 1 }); // violates the hard constraint
    await runVerify(registry, check.id);

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, constraintId: "constraint_hard_1" }] }
    });
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.status, "not_satisfied");
    assert.equal(output.conditions[0]!.required, true);
  });

  it("an unrecognized constraintId (not present in the project) does not force required -- no dangling-reference crash", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);

    const { result } = await executeTool(registry, {
      toolName: "evaluate_objective_satisfaction",
      input: { conditions: [{ checkId: check.id, constraintId: "constraint_does_not_exist", required: false }] }
    });
    assert.equal(result.status, "success");
  });
});

describe("createEvaluateObjectiveSatisfactionTool: no verification result yet", () => {
  it("a checkId that was never verified -> INCONCLUSIVE, never rejected as an error", async () => {
    const { registry } = buildHarness();
    const check = await createNumericCheck(registry);
    // deliberately never call run_verification
    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal(result.status, "success");
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.equal(output.status, "inconclusive");
    assert.equal(output.conditions[0]!.reasonKind, "no_verification_result");
  });
});

describe("createEvaluateObjectiveSatisfactionTool: persistence and purity", () => {
  it("persists every result to the store, matching the returned output exactly", async () => {
    const { registry, objectiveSatisfactionStore } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);
    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    const output = (result.output as { result: ObjectiveSatisfactionResult }).result;
    assert.deepEqual(objectiveSatisfactionStore.getById(output.id), output);
  });

  it("never mutates the World Model or the environment", async () => {
    const { registry, getState, getObjects } = buildHarness();
    const check = await createNumericCheck(registry);
    await runVerify(registry, check.id);
    const stateBefore = JSON.stringify(getState());
    const objectsBefore = JSON.stringify([...getObjects().values()]);
    await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{ checkId: check.id }] } });
    assert.equal(JSON.stringify(getState()), stateBefore);
    assert.equal(JSON.stringify([...getObjects().values()]), objectsBefore);
  });
});

describe("createEvaluateObjectiveSatisfactionTool: input validation", () => {
  it("rejects a missing conditions array", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: {} });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("rejects a condition missing checkId", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [{}] } });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("accepts and correctly handles an empty conditions array -> INCONCLUSIVE, never SATISFIED", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, { toolName: "evaluate_objective_satisfaction", input: { conditions: [] } });
    assert.equal(result.status, "success");
    assert.equal((result.output as { result: ObjectiveSatisfactionResult }).result.status, "inconclusive");
  });
});
