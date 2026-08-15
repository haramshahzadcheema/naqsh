import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState } from "@naqsh/schemas";
import { observeEntityRelationships, observeFocusedProject, observeObject, observeWholeProject } from "../src/observation-service.js";

function buildState() {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Design a bracket." },
      requirements: [{ id: "req_1", description: "Must be lightweight." }],
      objects: [{ id: "obj_1", type: "part", name: "Bracket" }],
      relationships: [{ type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_1" }]
    },
    session: { focusObjectIds: ["obj_1"] }
  });
}

describe("apps/api observation service: thin pass-through to @naqsh/core", () => {
  it("observeWholeProject returns every entity, matching scope:project", () => {
    const state = buildState();
    const result = observeWholeProject(state);
    assert.equal(result.scope, "project");
    assert.equal(result.requirements.length, 1);
    assert.equal(result.objects.length, 1);
  });

  it("observeFocusedProject scopes to the session's focused objects", () => {
    const state = buildState();
    const result = observeFocusedProject(state);
    assert.equal(result.scope, "focus");
    assert.equal(result.objects.some((object) => object.id === "obj_1"), true);
  });

  it("observeObject scopes to exactly the named object and its context", () => {
    const state = buildState();
    const result = observeObject(state, "obj_1");
    assert.equal(result.scope, "object");
    assert.equal(result.scopeObjectId, "obj_1");
    assert.equal(result.requirements[0]?.id, "req_1");
  });

  it("observeObject propagates a not-found failure for an unknown id", () => {
    const state = buildState();
    assert.throws(() => observeObject(state, "does_not_exist"));
  });

  it("observeEntityRelationships returns relationships and related refs for an entity", () => {
    const state = buildState();
    const context = observeEntityRelationships(state, "object", "obj_1");
    assert.equal(context.relationships.length, 1);
    assert.deepEqual(context.relatedEntities, [{ kind: "requirement", id: "req_1" }]);
  });
});
