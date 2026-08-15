import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createConstraint,
  createDecision,
  createEngineeringObject,
  createEntityRelationship,
  createObservationResult,
  createRequirement,
  WorldModelValidationError,
  type ObservationResultInput
} from "../src/index.js";

function buildInput(overrides: Partial<ObservationResultInput> = {}): ObservationResultInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    scope: "project",
    ...overrides
  };
}

describe("ObservationResult: creation and validation", () => {
  it("creates a result with bounded, empty defaults", () => {
    const result = createObservationResult(buildInput());
    assert.match(result.id, /^obs_/);
    assert.equal(result.scopeObjectId, null);
    assert.equal(result.objectiveSummary, null);
    assert.deepEqual(result.requirements, []);
    assert.deepEqual(result.missingInformation, []);
    assert.deepEqual(result.ambiguityIndicators, []);
    assert.equal(result.sessionMode, "idle");
    assert.equal(result.source, "system");
  });

  it("rejects an invalid scope", () => {
    assert.throws(
      () => createObservationResult(buildInput({ scope: "everything" as never })),
      /invalid observationResult.scope/
    );
  });

  it("requires a non-empty scopeObjectId when scope is 'object'", () => {
    assert.throws(
      () => createObservationResult(buildInput({ scope: "object", scopeObjectId: null })),
      /scopeObjectId is required when scope is "object"/
    );
  });

  it("accepts scope 'object' with a scopeObjectId", () => {
    const result = createObservationResult(buildInput({ scope: "object", scopeObjectId: "obj_1" }));
    assert.equal(result.scopeObjectId, "obj_1");
  });

  it("validates every nested requirement/constraint/object/decision", () => {
    assert.throws(
      () =>
        createObservationResult(
          buildInput({
            requirements: [{ id: "", description: "x" } as never]
          })
        ),
      WorldModelValidationError
    );
  });

  it("carries real, already-valid entities through unchanged", () => {
    const requirement = createRequirement({ description: "Max mass 350g" });
    const constraint = createConstraint({ description: "Aluminum only" });
    const object = createEngineeringObject({ type: "part", name: "Bracket" });
    const decision = createDecision({ statement: "Use aluminum", reason: "cost" });
    const relationship = createEntityRelationship({
      type: "satisfies",
      sourceType: "object",
      sourceId: object.id,
      targetType: "requirement",
      targetId: requirement.id
    });
    const result = createObservationResult(
      buildInput({ requirements: [requirement], constraints: [constraint], objects: [object], decisions: [decision], relationships: [relationship] })
    );
    assert.deepEqual(result.requirements, [requirement]);
    assert.deepEqual(result.relationships, [relationship]);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(
      () => createObservationResult(buildInput({ projectVersion: 0 })),
      /observationResult.projectVersion must be a positive integer/
    );
  });

  it("rejects an invalid sessionMode", () => {
    assert.throws(
      () => createObservationResult(buildInput({ sessionMode: "sleeping" as never })),
      /invalid observationResult.sessionMode/
    );
  });

  it("rejects non-string entries in missingInformation", () => {
    assert.throws(
      () => createObservationResult(buildInput({ missingInformation: [42 as never] })),
      /observationResult.missingInformation must be an array of strings/
    );
  });

  it("freezes the returned result", () => {
    const result = createObservationResult(buildInput());
    assert.throws(() => {
      (result as { scope: string }).scope = "focus";
    }, TypeError);
  });

  it("is a plain, JSON-serializable snapshot (no live references back into WorldModelState)", () => {
    const result = createObservationResult(buildInput());
    assert.doesNotThrow(() => JSON.stringify(result));
  });
});
