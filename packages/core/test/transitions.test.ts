import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createConstraint,
  createDecision,
  createEngineeringObject,
  createEntityRelationship,
  createExperiment,
  createPreference,
  createRequirement,
  createResearchEvidence,
  createSessionState,
  createSource,
  createWorldModelState,
  WorldModelValidationError
} from "@naqsh/schemas";
import {
  createEmptyWorldModelState,
  getTransitionEntry,
  initializeWorldModel,
  listTransitionKinds,
  updateWorldModel,
  type TransitionKind
} from "../src/index.js";

function buildState() {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "Investigate a lightweight bracket",
      objective: { summary: "Design a lightweight mounting bracket for CNC manufacturing." }
    },
    session: {}
  });
}

describe("updateWorldModel: project transitions increment version and validate", () => {
  it("adds a requirement", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_requirement",
      requirement: createRequirement({ description: "Max mass 350g", category: "mass", value: 350, unit: "g" })
    });
    assert.equal(next.project.version, state.project.version + 1);
    assert.equal(next.project.requirements.length, 1);
  });

  it("adds a constraint", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_constraint",
      constraint: createConstraint({ description: "Aluminum 6061", category: "material" })
    });
    assert.equal(next.project.constraints.length, 1);
  });

  it("adds an object", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_object",
      object: createEngineeringObject({ type: "component", name: "Main Bracket" })
    });
    assert.equal(next.project.objects.length, 1);
  });

  it("adds a decision", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_decision",
      decision: createDecision({ statement: "Use aluminum 6061", reason: "lower mass" })
    });
    assert.equal(next.project.decisions.length, 1);
  });

  it("adds an experiment", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_experiment",
      experiment: createExperiment({ objective: "Compare thickness", hypothesis: "8mm is worse" })
    });
    assert.equal(next.project.experiments.length, 1);
  });

  it("adds a preference", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_preference",
      preference: createPreference({ description: "Prefer simple geometry", category: "complexity" })
    });
    assert.equal(next.project.preferences.length, 1);
  });

  it("adds a relationship", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_relationship",
      relationship: createEntityRelationship({
        type: "satisfies",
        sourceType: "object",
        sourceId: "obj_1",
        targetType: "requirement",
        targetId: "req_1"
      })
    });
    assert.equal(next.project.version, state.project.version + 1);
    assert.equal(next.project.relationships.length, 1);
    assert.equal(next.project.relationships[0]?.type, "satisfies");
  });

  it("removes a relationship by id", () => {
    const state = buildState();
    const withRelationship = updateWorldModel(state, {
      kind: "add_relationship",
      relationship: createEntityRelationship({
        type: "satisfies",
        sourceType: "object",
        sourceId: "obj_1",
        targetType: "requirement",
        targetId: "req_1"
      })
    });
    const relationshipId = withRelationship.project.relationships[0]!.id;
    const removed = updateWorldModel(withRelationship, { kind: "remove_relationship", relationshipId });
    assert.equal(removed.project.relationships.length, 0);
  });

  it("rejects add_relationship with a malformed relationship", () => {
    assert.throws(
      () =>
        updateWorldModel(buildState(), {
          kind: "add_relationship",
          relationship: { type: "", sourceType: "object", sourceId: "a", targetType: "requirement", targetId: "b" }
        }),
      WorldModelValidationError
    );
  });

  it("removing an unknown relationship id is a no-op, not an error", () => {
    const state = buildState();
    const next = updateWorldModel(state, { kind: "remove_relationship", relationshipId: "does_not_exist" });
    assert.equal(next.project.relationships.length, 0);
  });

  it("adds a source (P21)", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_source",
      source: createSource({ title: "6061-T6 Aluminum Datasheet", sourceType: "datasheet" })
    });
    assert.equal(next.project.version, state.project.version + 1);
    assert.equal(next.project.sources.length, 1);
    assert.equal(next.project.sources[0]?.title, "6061-T6 Aluminum Datasheet");
  });

  it("adds evidence (P21)", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "add_evidence",
      evidence: createResearchEvidence({ sourceId: "src_1", claim: "Yield strength is approximately 276 MPa." })
    });
    assert.equal(next.project.researchEvidence.length, 1);
    assert.equal(next.project.researchEvidence[0]?.claim, "Yield strength is approximately 276 MPa.");
  });

  it("rejects add_source with a malformed source", () => {
    assert.throws(
      () => updateWorldModel(buildState(), { kind: "add_source", source: { title: "", sourceType: "datasheet" } }),
      WorldModelValidationError
    );
  });

  it("rejects add_evidence with a malformed evidence (empty claim)", () => {
    assert.throws(
      () => updateWorldModel(buildState(), { kind: "add_evidence", evidence: { sourceId: "src_1", claim: "" } }),
      WorldModelValidationError
    );
  });

  it("updates a requirement by id while keeping the id stable", () => {
    const state = buildState();
    const withRequirement = updateWorldModel(state, {
      kind: "add_requirement",
      requirement: createRequirement({ description: "Max mass 350g", category: "mass" })
    });
    const requirementId = withRequirement.project.requirements[0]!.id;
    const updated = updateWorldModel(withRequirement, {
      kind: "update_requirement",
      requirementId,
      patch: { status: "satisfied" }
    });
    assert.equal(updated.project.requirements[0]!.id, requirementId);
    assert.equal(updated.project.requirements[0]!.status, "satisfied");
  });

  it("P11: updates a single property on an existing object while keeping the id and other properties stable", () => {
    const state = buildState();
    const withObject = updateWorldModel(state, {
      kind: "add_object",
      object: createEngineeringObject({ type: "part", name: "Bracket", properties: { thicknessMm: 6 } })
    });
    const objectId = withObject.project.objects[0]!.id;
    const updated = updateWorldModel(withObject, {
      kind: "update_object",
      objectId,
      propertyKey: "material",
      value: "aluminum_6061"
    });
    assert.equal(updated.project.objects[0]!.id, objectId);
    assert.equal(updated.project.objects[0]!.properties.material, "aluminum_6061");
    assert.equal(updated.project.objects[0]!.properties.thicknessMm, 6);
    assert.equal(updated.project.version, withObject.project.version + 1);
  });

  it("P11: update_object on an unknown objectId is a no-op, not an error -- the tool layer is responsible for rejecting an unknown object before proposing this transition", () => {
    const state = buildState();
    const next = updateWorldModel(state, { kind: "update_object", objectId: "does_not_exist", propertyKey: "x", value: 1 });
    assert.deepEqual(next.project.objects, []);
  });

  it("P11: getTransitionEntry('update_object').describeChange reports the touched object's before/after state", () => {
    const state = buildState();
    const withObject = updateWorldModel(state, {
      kind: "add_object",
      object: createEngineeringObject({ type: "part", name: "Bracket", properties: { material: "steel" } })
    });
    const objectId = withObject.project.objects[0]!.id;
    const transition = { kind: "update_object" as const, objectId, propertyKey: "material", value: "aluminum_6061" };
    const updated = updateWorldModel(withObject, transition);
    const entry = getTransitionEntry("update_object") as {
      describeChange: (before: unknown, after: unknown, transition: unknown) => { entityType: string; entityId: string | null; before: unknown; after: unknown };
    };
    const description = entry.describeChange(withObject.project, updated.project, transition);
    assert.equal(description.entityType, "object");
    assert.equal(description.entityId, objectId);
    assert.equal((description.before as { properties: { material: string } }).properties.material, "steel");
    assert.equal((description.after as { properties: { material: string } }).properties.material, "aluminum_6061");
  });

  it("removes a requirement by id", () => {
    const state = buildState();
    const withRequirement = updateWorldModel(state, {
      kind: "add_requirement",
      requirement: createRequirement({ description: "Max mass 350g", category: "mass" })
    });
    const requirementId = withRequirement.project.requirements[0]!.id;
    const removed = updateWorldModel(withRequirement, { kind: "remove_requirement", requirementId });
    assert.equal(removed.project.requirements.length, 0);
  });

  it("merges set_project_metadata rather than replacing it", () => {
    const state = updateWorldModel(buildState(), {
      kind: "set_project_metadata",
      metadata: { tag: "bracket" }
    });
    const next = updateWorldModel(state, { kind: "set_project_metadata", metadata: { rev: 2 } });
    assert.deepEqual(next.project.metadata, { tag: "bracket", rev: 2 });
  });

  it("defaults a partial objective through set_objective", () => {
    const next = updateWorldModel(buildState(), {
      kind: "set_objective",
      objective: { summary: "Reduce weight by 15%" }
    });
    assert.equal(next.project.objective.summary, "Reduce weight by 15%");
    assert.equal(next.project.objective.source, "human");
  });
});

describe("updateWorldModel: session transitions never touch project", () => {
  it("observe only updates lastObservedAt", () => {
    const state = buildState();
    const next = updateWorldModel(state, { kind: "observe" });
    assert.equal(next.project.version, state.project.version);
    assert.notEqual(next.session.lastObservedAt, null);
  });

  it("focus_objects updates focus and lastObservedAt", () => {
    const state = buildState();
    const next = updateWorldModel(state, { kind: "focus_objects", focusObjectIds: ["obj_1"] });
    assert.deepEqual(next.session.focusObjectIds, ["obj_1"]);
    assert.notEqual(next.session.lastObservedAt, null);
  });

  it("replace_session swaps the whole session", () => {
    const state = buildState();
    const next = updateWorldModel(state, {
      kind: "replace_session",
      session: createSessionState({ mode: "executing" })
    });
    assert.equal(next.session.mode, "executing");
  });
});

describe("updateWorldModel: rejects malformed input", () => {
  it("rejects an unsupported transition kind", () => {
    assert.throws(
      () => updateWorldModel(buildState(), { kind: "delete_project" } as never),
      WorldModelValidationError
    );
  });

  it("rejects a transition without a kind", () => {
    assert.throws(() => updateWorldModel(buildState(), {} as never), WorldModelValidationError);
  });
});

describe("transition registry is a real extensibility seam", () => {
  it("registers every transition kind exactly once with a target and mutates flag", () => {
    const kinds = listTransitionKinds();
    assert.equal(new Set(kinds).size, kinds.length);
    for (const kind of kinds) {
      const entry = getTransitionEntry(kind as TransitionKind);
      assert.ok(entry.target === "project" || entry.target === "session");
      assert.equal(typeof entry.mutates, "boolean");
    }
  });

  it("marks observe as non-mutating and everything else as mutating", () => {
    assert.equal(getTransitionEntry("observe").mutates, false);
    assert.equal(getTransitionEntry("add_requirement").mutates, true);
    assert.equal(getTransitionEntry("focus_objects").mutates, true);
  });
});

describe("bootstrap helpers", () => {
  it("initializeWorldModel builds a valid state from minimal input", () => {
    const state = initializeWorldModel({ name: "Phone Stand", objective: { summary: "3D-printed phone stand" } });
    assert.equal(state.project.name, "Phone Stand");
    assert.equal(state.project.objects.length, 0);
  });

  it("createEmptyWorldModelState is valid and versioned at 1", () => {
    const state = createEmptyWorldModelState();
    assert.equal(state.project.version, 1);
  });

  it("supports a from-scratch project with zero objects (design intent precedes geometry)", () => {
    const state = initializeWorldModel({ name: "Phone Stand" });
    assert.equal(state.project.objects.length, 0);
    const withRequirement = updateWorldModel(state, {
      kind: "add_requirement",
      requirement: createRequirement({ description: "Hold a 1kg tablet", category: "load" })
    });
    assert.equal(withRequirement.project.objects.length, 0);
    assert.equal(withRequirement.project.requirements.length, 1);
  });
});
