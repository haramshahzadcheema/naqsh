import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgentLoopRun, createObservationResult, createPlan, createProposal, type AgentLoopRun } from "@naqsh/schemas";
import { createAgentLoopRunStore, deserializeAgentLoopRunStore } from "../src/agent-loop-run-store.js";

function buildRun(overrides: Partial<Parameters<typeof createAgentLoopRun>[0]> = {}): AgentLoopRun {
  const observationBefore = createObservationResult({ projectId: "proj_1", projectVersion: 1, scope: "project" });
  const plan = createPlan({ projectId: "proj_1", projectVersion: 1, observationId: observationBefore.id, objectiveSummary: "x" });
  const proposal = createProposal({
    projectId: "proj_1",
    projectVersion: 1,
    planId: plan.id,
    planStepId: "step_1",
    objectiveSummary: "x",
    toolName: "modify_object",
    toolTarget: "world_model",
    rationale: "r",
    expectedEffect: "e"
  });
  return createAgentLoopRun({
    projectId: "proj_1",
    observationBefore,
    plan,
    planStepId: "step_1",
    proposal,
    status: "proposed",
    ...overrides
  });
}

describe("AgentLoopRunStore: save/getById/list/listForProject", () => {
  it("saves and retrieves a run by id", () => {
    const store = createAgentLoopRunStore();
    const run = buildRun();
    store.save(run);
    assert.deepEqual(store.getById(run.id), run);
  });

  it("returns undefined for an unknown id", () => {
    const store = createAgentLoopRunStore();
    assert.equal(store.getById("agentloop_missing"), undefined);
  });

  it("lists every saved run", () => {
    const store = createAgentLoopRunStore();
    const a = buildRun({ projectId: "proj_a" });
    const b = buildRun({ projectId: "proj_b" });
    store.save(a);
    store.save(b);
    assert.deepEqual(store.list(), [a, b]);
  });

  it("listForProject filters to exactly one project", () => {
    const store = createAgentLoopRunStore();
    const a1 = buildRun({ projectId: "proj_a" });
    const a2 = buildRun({ projectId: "proj_a" });
    const b1 = buildRun({ projectId: "proj_b" });
    store.save(a1);
    store.save(a2);
    store.save(b1);
    assert.deepEqual(store.listForProject("proj_a"), [a1, a2]);
    assert.deepEqual(store.listForProject("proj_b"), [b1]);
    assert.deepEqual(store.listForProject("proj_nonexistent"), []);
  });

  it("IMMUTABILITY: refuses to save a duplicate run id", () => {
    const store = createAgentLoopRunStore();
    const run = buildRun();
    store.save(run);
    assert.throws(() => store.save(run), /already exists/);
    const tampered = { ...run, status: "completed" } as AgentLoopRun;
    assert.throws(() => store.save(tampered), /already exists/);
    assert.equal(store.getById(run.id)!.status, run.status);
  });

  it("has no update/delete method on its public interface at all", () => {
    const store = createAgentLoopRunStore();
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.equal("remove" in store, false);
  });
});

describe("AgentLoopRunStore: serialize/deserializeAgentLoopRunStore", () => {
  it("round-trips through serialize/deserialize with full fidelity", () => {
    const store = createAgentLoopRunStore();
    const a = buildRun({ projectId: "proj_a" });
    const b = buildRun({ projectId: "proj_b" });
    store.save(a);
    store.save(b);

    const restored = deserializeAgentLoopRunStore(store.serialize());
    assert.deepEqual(restored.list(), [a, b]);
  });

  it("rejects a non-array serialized payload", () => {
    assert.throws(() => deserializeAgentLoopRunStore(JSON.stringify({ not: "an array" })), /must be an array/);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeAgentLoopRunStore(""), /is required/);
  });

  it("rejects a serialized store containing a duplicate id (corrupted/hand-edited log)", () => {
    const run = buildRun();
    const corrupted = JSON.stringify([run, run]);
    assert.throws(() => deserializeAgentLoopRunStore(corrupted), /already exists/);
  });
});
