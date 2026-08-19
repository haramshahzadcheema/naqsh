import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, WorldModelValidationError, type CandidateInput } from "@naqsh/schemas";
import { createCandidateStore, deserializeCandidateStore } from "../src/candidate-store.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    hypothesis: "A ribbed aluminum bracket meets the load requirement at lower mass.",
    rationale: "Ribbing adds stiffness without much added mass.",
    ...overrides
  };
}

describe("CandidateStore: save/getById", () => {
  it("saves and retrieves a candidate", () => {
    const store = createCandidateStore();
    const candidate = createCandidate(candidateInput());
    store.save(candidate);
    assert.deepEqual(store.getById(candidate.id), candidate);
  });

  it("rejects saving a duplicate id -- candidates are immutable once created", () => {
    const store = createCandidateStore();
    const candidate = createCandidate(candidateInput());
    store.save(candidate);
    assert.throws(() => store.save(candidate), WorldModelValidationError);
  });

  it("getById returns undefined for an unknown id", () => {
    const store = createCandidateStore();
    assert.equal(store.getById("cand_missing"), undefined);
  });
});

describe("CandidateStore: listForPlan / listForPlanStep", () => {
  it("listForPlan returns only candidates for that plan", () => {
    const store = createCandidateStore();
    const a = createCandidate(candidateInput({ planId: "plan_1" }));
    const b = createCandidate(candidateInput({ planId: "plan_2" }));
    store.save(a);
    store.save(b);
    const forPlan1 = store.listForPlan("plan_1");
    assert.equal(forPlan1.length, 1);
    assert.equal(forPlan1[0]!.id, a.id);
  });

  it("listForPlanStep returns only candidates for that exact plan+step pair", () => {
    const store = createCandidateStore();
    const a = createCandidate(candidateInput({ planId: "plan_1", planStepId: "step_1" }));
    const b = createCandidate(candidateInput({ planId: "plan_1", planStepId: "step_2" }));
    const c = createCandidate(candidateInput({ planId: "plan_1", planStepId: null }));
    store.save(a);
    store.save(b);
    store.save(c);
    const forStep1 = store.listForPlanStep("plan_1", "step_1");
    assert.equal(forStep1.length, 1);
    assert.equal(forStep1[0]!.id, a.id);
    const wholePlan = store.listForPlanStep("plan_1", null);
    assert.equal(wholePlan.length, 1);
    assert.equal(wholePlan[0]!.id, c.id);
  });
});

describe("CandidateStore: listChildren (tree, not chain)", () => {
  it("returns direct children only, not grandchildren", () => {
    const store = createCandidateStore();
    const grandparent = createCandidate(candidateInput());
    store.save(grandparent);
    const parentA = createCandidate(candidateInput({ parentCandidateId: grandparent.id }));
    const parentB = createCandidate(candidateInput({ parentCandidateId: grandparent.id }));
    store.save(parentA);
    store.save(parentB);
    const grandchild = createCandidate(candidateInput({ parentCandidateId: parentA.id }));
    store.save(grandchild);

    const children = store.listChildren(grandparent.id);
    assert.equal(children.length, 2, "grandparent has two direct children -- siblings, not a chain");
    assert.deepEqual(
      children.map((c) => c.id).sort(),
      [parentA.id, parentB.id].sort()
    );

    const grandchildren = store.listChildren(parentA.id);
    assert.equal(grandchildren.length, 1);
    assert.equal(grandchildren[0]!.id, grandchild.id);

    // The grandparent's listChildren does NOT include the grandchild --
    // that's the whole point of "children," not "revision chain."
    assert.ok(!children.some((c) => c.id === grandchild.id));
  });

  it("returns an empty array for a candidate with no children", () => {
    const store = createCandidateStore();
    const candidate = createCandidate(candidateInput());
    store.save(candidate);
    assert.deepEqual(store.listChildren(candidate.id), []);
  });
});

describe("CandidateStore: list", () => {
  it("returns every saved candidate", () => {
    const store = createCandidateStore();
    const a = createCandidate(candidateInput());
    const b = createCandidate(candidateInput());
    store.save(a);
    store.save(b);
    assert.equal(store.list().length, 2);
  });
});

describe("CandidateStore: serialization", () => {
  it("round-trips through JSON with full fidelity", () => {
    const store = createCandidateStore();
    const candidate = createCandidate(candidateInput());
    store.save(candidate);
    const restored = deserializeCandidateStore(store.serialize());
    assert.deepEqual(restored.getById(candidate.id), candidate);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeCandidateStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeCandidateStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeCandidateStore(""), WorldModelValidationError);
  });
});
