import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createObjectiveConditionOutcome,
  createObjectiveSatisfactionResult,
  deserializeObjectiveSatisfactionResult,
  serializeObjectiveSatisfactionResult,
  WorldModelValidationError,
  type ObjectiveConditionOutcomeInput,
  type ObjectiveSatisfactionResultInput
} from "../src/index.js";

function conditionInput(overrides: Partial<ObjectiveConditionOutcomeInput> = {}): ObjectiveConditionOutcomeInput {
  return { checkId: "check_1", effectiveStatus: "pass", reasonKind: "satisfied", message: "ok", ...overrides };
}

describe("ObjectiveConditionOutcome: creation and validation", () => {
  it("creates a valid outcome, defaulting required to true and everything else to null", () => {
    const outcome = createObjectiveConditionOutcome(conditionInput());
    assert.equal(outcome.required, true);
    assert.equal(outcome.requirementId, null);
    assert.equal(outcome.constraintId, null);
    assert.equal(outcome.checkKind, null);
    assert.equal(outcome.verificationResultId, null);
  });

  it("rejects an invalid effectiveStatus", () => {
    assert.throws(() => createObjectiveConditionOutcome(conditionInput({ effectiveStatus: "maybe" } as unknown as Partial<ObjectiveConditionOutcomeInput>)), /invalid objectiveConditionOutcome.effectiveStatus/);
  });

  it("rejects an invalid reasonKind", () => {
    assert.throws(() => createObjectiveConditionOutcome(conditionInput({ reasonKind: "because" } as unknown as Partial<ObjectiveConditionOutcomeInput>)), /invalid objectiveConditionOutcome.reasonKind/);
  });

  it("rejects an empty checkId", () => {
    assert.throws(() => createObjectiveConditionOutcome(conditionInput({ checkId: "" })), /checkId is required/);
  });

  it("is frozen -- immutable once created", () => {
    const outcome = createObjectiveConditionOutcome(conditionInput());
    assert.throws(() => {
      (outcome as { message: string }).message = "tampered";
    }, TypeError);
  });
});

describe("ObjectiveSatisfactionResult: creation and validation", () => {
  function resultInput(overrides: Partial<ObjectiveSatisfactionResultInput> = {}): ObjectiveSatisfactionResultInput {
    return {
      projectId: "proj_1",
      projectVersion: 1,
      status: "satisfied",
      reason: "all required conditions are satisfied",
      conditions: [conditionInput()],
      ...overrides
    };
  }

  it("creates a valid result with defaults", () => {
    const result = createObjectiveSatisfactionResult(resultInput());
    assert.equal(result.status, "satisfied");
    assert.equal(result.objectiveSummary, null);
    assert.equal(result.conditions.length, 1);
    assert.ok(result.id.startsWith("objsat_"));
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createObjectiveSatisfactionResult(resultInput({ status: "maybe" } as unknown as Partial<ObjectiveSatisfactionResultInput>)), /invalid objectiveSatisfactionResult.status/);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createObjectiveSatisfactionResult(resultInput({ projectVersion: 0 })), /projectVersion must be a positive integer/);
  });

  it("rejects an empty reason", () => {
    assert.throws(() => createObjectiveSatisfactionResult(resultInput({ reason: "" })), /reason is required/);
  });

  it("accepts an empty conditions array (status/reason still validated normally -- emptiness semantics belong to the evaluator, not the schema)", () => {
    const result = createObjectiveSatisfactionResult(resultInput({ conditions: [], status: "inconclusive", reason: "no conditions supplied" }));
    assert.deepEqual(result.conditions, []);
  });

  it("rejects a malformed nested condition", () => {
    assert.throws(
      () => createObjectiveSatisfactionResult(resultInput({ conditions: [{ checkId: "c1", effectiveStatus: "bogus", reasonKind: "satisfied", message: "x" } as unknown as ObjectiveConditionOutcomeInput] })),
      /invalid objectiveConditionOutcome.effectiveStatus/
    );
  });

  it("is frozen -- immutable once created", () => {
    const result = createObjectiveSatisfactionResult(resultInput());
    assert.throws(() => {
      (result as { status: string }).status = "not_satisfied";
    }, TypeError);
  });

  it("round-trips through JSON with full fidelity", () => {
    const result = createObjectiveSatisfactionResult(
      resultInput({
        objectiveSummary: "bracket must support 50kg",
        conditions: [conditionInput({ requirementId: "req_1", checkId: "check_1", verificationResultId: "verif_1" })]
      })
    );
    const restored = deserializeObjectiveSatisfactionResult(serializeObjectiveSatisfactionResult(result));
    assert.deepEqual(restored, result);
  });

  it("serializeObjectiveSatisfactionResult rejects a malformed object", () => {
    assert.throws(() => serializeObjectiveSatisfactionResult({ status: "satisfied" } as never), WorldModelValidationError);
  });

  it("deserializeObjectiveSatisfactionResult rejects corrupted JSON", () => {
    assert.throws(() => deserializeObjectiveSatisfactionResult("{not json"), SyntaxError);
  });

  it("deserializeObjectiveSatisfactionResult rejects well-formed JSON that fails shape validation", () => {
    assert.throws(() => deserializeObjectiveSatisfactionResult(JSON.stringify({ status: "satisfied" })), WorldModelValidationError);
  });
});
