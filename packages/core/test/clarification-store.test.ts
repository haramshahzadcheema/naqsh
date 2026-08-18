import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClarification, createRequirementCandidate, WorldModelValidationError, type ClarificationInput } from "@naqsh/schemas";
import { createClarificationStore, deserializeClarificationStore } from "../src/clarification-store.js";

function pendingClarification(overrides: Partial<ClarificationInput> = {}) {
  const candidate = createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "Make the bracket strong.",
    description: "The bracket must be strong.",
    category: "load",
    interpretationStatus: "ambiguous",
    ambiguityReason: "No specific load or direction was stated."
  });
  return createClarification({
    projectId: "proj_1",
    requirementCandidateId: candidate.id,
    candidateSnapshot: candidate,
    question: "What load must it withstand, and in which direction?",
    reason: "No specific load or direction was stated.",
    category: "missing_threshold",
    affectedFields: ["value", "operator"],
    ...overrides
  });
}

describe("ClarificationStore: save", () => {
  it("saves and retrieves a pending clarification", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    assert.deepEqual(store.getById(clarification.id), clarification);
  });

  it("rejects saving a non-pending clarification", () => {
    const store = createClarificationStore();
    const answered = pendingClarification({ status: "answered", answerText: "500 N" });
    assert.throws(() => store.save(answered), WorldModelValidationError);
  });

  it("rejects a duplicate id", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    assert.throws(() => store.save(clarification), WorldModelValidationError);
  });

  it("listForCandidate returns only clarifications for that candidate", () => {
    const store = createClarificationStore();
    const a = pendingClarification();
    const b = pendingClarification();
    store.save(a);
    store.save(b);
    assert.equal(store.listForCandidate(a.requirementCandidateId).length, 1);
    assert.equal(store.listForCandidate("nonexistent").length, 0);
  });
});

describe("ClarificationStore: answer", () => {
  it("transitions pending -> answered", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    const answered = store.answer(clarification.id, "500 N vertically");
    assert.equal(answered.status, "answered");
    assert.equal(answered.answerText, "500 N vertically");
    assert.ok(answered.answeredAt);
    assert.deepEqual(store.getById(clarification.id), answered);
  });

  it("rejects answering an already-answered clarification", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    store.answer(clarification.id, "500 N");
    assert.throws(() => store.answer(clarification.id, "again"), WorldModelValidationError);
  });

  it("throws for a missing id", () => {
    const store = createClarificationStore();
    assert.throws(() => store.answer("clarify_missing", "x"), WorldModelValidationError);
  });
});

describe("ClarificationStore: dismiss", () => {
  it("transitions pending -> dismissed", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    const dismissed = store.dismiss(clarification.id, "not needed for this project");
    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.answerText, null);
  });

  it("REGRESSION: dismissing preserves the ORIGINAL reason (why the clarification was asked) -- the dismissal rationale is recorded separately in metadata, never overwriting it", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    const originalReason = clarification.reason;
    store.save(clarification);
    const dismissed = store.dismiss(clarification.id, "not needed for this project");
    assert.equal(dismissed.reason, originalReason, "the original 'why this was asked' explanation must survive dismissal untouched");
    assert.equal(dismissed.metadata.dismissalReason, "not needed for this project");
  });

  it("dismissing with no reason leaves metadata untouched", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    const dismissed = store.dismiss(clarification.id);
    assert.deepEqual(dismissed.metadata, clarification.metadata);
  });

  it("rejects dismissing an already-dismissed clarification", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    store.dismiss(clarification.id);
    assert.throws(() => store.dismiss(clarification.id), WorldModelValidationError);
  });
});

describe("ClarificationStore: supersede", () => {
  it("transitions pending -> superseded", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    const superseded = store.supersede(clarification.id, "clarify_newer");
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.supersededBy, "clarify_newer");
  });
});

describe("ClarificationStore: serialization", () => {
  it("round-trips pending, answered, dismissed, and superseded records", () => {
    const store = createClarificationStore();
    const pending = pendingClarification();
    const toAnswer = pendingClarification();
    const toDismiss = pendingClarification();
    const toSupersede = pendingClarification();
    store.save(pending);
    store.save(toAnswer);
    store.save(toDismiss);
    store.save(toSupersede);
    store.answer(toAnswer.id, "2 kg");
    store.dismiss(toDismiss.id);
    store.supersede(toSupersede.id, "clarify_newer");

    const restored = deserializeClarificationStore(store.serialize());
    assert.equal(restored.list().length, 4);
    assert.deepEqual(restored.getById(pending.id), store.getById(pending.id));
    assert.equal(restored.getById(toAnswer.id)!.status, "answered");
    assert.equal(restored.getById(toDismiss.id)!.status, "dismissed");
    assert.equal(restored.getById(toSupersede.id)!.status, "superseded");
  });

  it("a deserialized store's answered/dismissed/superseded entries cannot be re-transitioned (still respects pending-only invariant)", () => {
    const store = createClarificationStore();
    const clarification = pendingClarification();
    store.save(clarification);
    store.answer(clarification.id, "2 kg");
    const restored = deserializeClarificationStore(store.serialize());
    assert.throws(() => restored.answer(clarification.id, "again"), WorldModelValidationError);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeClarificationStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeClarificationStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });
});
