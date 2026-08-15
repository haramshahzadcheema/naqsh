import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState, ObservationError, type ObservationResult, type WorldModelState } from "@naqsh/schemas";
import {
  getConstraintsForObject,
  getDecisionsForObject,
  getExperimentsForRequirement,
  getFocusedObjects,
  getProjectSummary,
  getRelatedEntitiesOfKind,
  getRelatedEntityRefs,
  getRelationshipsForEntity,
  getRequirementById,
  getRequirementsForObject,
  observeProject
} from "../src/observe-project.js";

function emptyState(): WorldModelState {
  return createWorldModelState({
    project: { name: "Bracket Study", description: "x", objective: { summary: "" } },
    session: {}
  });
}

/** A project with a small, deliberately interconnected graph:
 *   obj_bracket --satisfies--> req_mass
 *   obj_bracket --affects----> con_material
 *   obj_bracket --informed_by-> dec_material
 *   req_mass --tested_by------> exp_mass_test
 *   obj_unrelated has no relationships at all
 */
function richState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "A load-bearing bracket redesign.",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_mass", description: "Max mass 350g" }],
      constraints: [{ id: "con_material", description: "Aluminum only" }],
      objects: [
        { id: "obj_bracket", type: "part", name: "Bracket" },
        { id: "obj_unrelated", type: "part", name: "Unrelated Widget" }
      ],
      decisions: [{ id: "dec_material", statement: "Use aluminum 6061", reason: "cost and machinability" }],
      experiments: [{ id: "exp_mass_test", objective: "Measure mass", hypothesis: "Under 350g" }],
      relationships: [
        { type: "satisfies", sourceType: "object", sourceId: "obj_bracket", targetType: "requirement", targetId: "req_mass" },
        { type: "affects", sourceType: "object", sourceId: "obj_bracket", targetType: "constraint", targetId: "con_material" },
        { type: "informed_by", sourceType: "object", sourceId: "obj_bracket", targetType: "decision", targetId: "dec_material" },
        { type: "tested_by", sourceType: "requirement", sourceId: "req_mass", targetType: "experiment", targetId: "exp_mass_test" }
      ]
    },
    session: { focusObjectIds: ["obj_bracket"] }
  });
}

describe("getProjectSummary", () => {
  it("summarizes an empty project with all counts at zero", () => {
    const summary = getProjectSummary(emptyState());
    assert.equal(summary.requirementCount, 0);
    assert.equal(summary.objectCount, 0);
    assert.equal(summary.relationshipCount, 0);
    assert.equal(summary.objectiveSummary, null);
  });

  it("counts every entity kind independently", () => {
    const summary = getProjectSummary(richState());
    assert.equal(summary.requirementCount, 1);
    assert.equal(summary.constraintCount, 1);
    assert.equal(summary.objectCount, 2);
    assert.equal(summary.decisionCount, 1);
    assert.equal(summary.experimentCount, 1);
    assert.equal(summary.relationshipCount, 4);
    assert.equal(summary.objectiveSummary, "Reduce mass by 20%.");
  });
});

describe("Relationship traversal", () => {
  it("getRelationshipsForEntity finds relationships regardless of which side the entity is on", () => {
    const state = richState();
    const forObject = getRelationshipsForEntity(state, "object", "obj_bracket");
    assert.equal(forObject.length, 3);
    const forRequirement = getRelationshipsForEntity(state, "requirement", "req_mass");
    assert.equal(forRequirement.length, 2); // satisfied-by relationship + tested_by relationship
  });

  it("returns an empty array for an entity with no relationships", () => {
    const state = richState();
    assert.deepEqual(getRelationshipsForEntity(state, "object", "obj_unrelated"), []);
  });

  it("getRelatedEntityRefs returns deduplicated refs on the OTHER side, excluding self", () => {
    const state = richState();
    const refs = getRelatedEntityRefs(state, "object", "obj_bracket");
    assert.deepEqual(
      refs.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { kind: "constraint", id: "con_material" },
        { kind: "decision", id: "dec_material" },
        { kind: "requirement", id: "req_mass" }
      ]
    );
  });

  it("getRelatedEntitiesOfKind filters by target kind and resolves full entities", () => {
    const state = richState();
    const requirements = getRelatedEntitiesOfKind(state, "object", "obj_bracket", "requirement");
    assert.equal(requirements.length, 1);
    assert.equal((requirements[0] as { id: string }).id, "req_mass");
  });

  it("named convenience wrappers answer the exact P8-specified questions", () => {
    const state = richState();
    assert.deepEqual(
      getRequirementsForObject(state, "obj_bracket").map((r) => r.id),
      ["req_mass"]
    );
    assert.deepEqual(
      getConstraintsForObject(state, "obj_bracket").map((c) => c.id),
      ["con_material"]
    );
    assert.deepEqual(
      getDecisionsForObject(state, "obj_bracket").map((d) => d.id),
      ["dec_material"]
    );
    assert.deepEqual(
      getExperimentsForRequirement(state, "req_mass").map((e) => e.id),
      ["exp_mass_test"]
    );
  });

  it("unrelated entities never appear in traversal results", () => {
    const state = richState();
    const refs = getRelatedEntityRefs(state, "object", "obj_bracket");
    assert.equal(
      refs.some((ref) => ref.id === "obj_unrelated"),
      false
    );
  });

  it("gracefully skips a dangling relationship reference rather than throwing", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "x",
        objective: { summary: "" },
        objects: [{ id: "obj_1", type: "part", name: "x" }],
        relationships: [
          { type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_ghost" }
        ]
      },
      session: {}
    });
    assert.doesNotThrow(() => getRelatedEntitiesOfKind(state, "object", "obj_1", "requirement"));
    assert.deepEqual(getRelatedEntitiesOfKind(state, "object", "obj_1", "requirement"), []);
  });

  it("MALFORMED RELATIONSHIP: a self-referential relationship (source === target) is excluded from related refs, not treated as a neighbor", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "x",
        objective: { summary: "" },
        objects: [{ id: "obj_1", type: "part", name: "x" }],
        relationships: [{ type: "depends_on", sourceType: "object", sourceId: "obj_1", targetType: "object", targetId: "obj_1" }]
      },
      session: {}
    });
    // The relationship itself is still visible (it genuinely references obj_1)...
    assert.equal(getRelationshipsForEntity(state, "object", "obj_1").length, 1);
    // ...but obj_1 is never reported as "related to" itself.
    assert.deepEqual(getRelatedEntityRefs(state, "object", "obj_1"), []);
  });

  it("CYCLE: a relationship cycle (A -> B -> C -> A) resolves to exactly the one-hop neighbors, terminating without unbounded traversal", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "x",
        objective: { summary: "" },
        objects: [
          { id: "obj_a", type: "part", name: "A" },
          { id: "obj_b", type: "part", name: "B" },
          { id: "obj_c", type: "part", name: "C" }
        ],
        relationships: [
          { type: "depends_on", sourceType: "object", sourceId: "obj_a", targetType: "object", targetId: "obj_b" },
          { type: "depends_on", sourceType: "object", sourceId: "obj_b", targetType: "object", targetId: "obj_c" },
          { type: "depends_on", sourceType: "object", sourceId: "obj_c", targetType: "object", targetId: "obj_a" }
        ]
      },
      session: {}
    });
    // obj_a has exactly two relationship edges touching it: A->B (as source) and C->A (as target).
    // Traversal is strictly one-hop, so the cycle can never be walked further -- obj_c reached via
    // the C->A edge is reported as a neighbor of A, but its OWN edge to obj_b is never followed.
    const refs = getRelatedEntityRefs(state, "object", "obj_a").sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(refs, [
      { kind: "object", id: "obj_b" },
      { kind: "object", id: "obj_c" }
    ]);

    const result = observeProject(state, { scope: "object", objectId: "obj_a" });
    assert.equal(result.objects.length, 3, "scoped object plus both one-hop neighbors, no duplicates, no runaway expansion");
  });
});

describe("getFocusedObjects", () => {
  it("resolves focused ids to real objects", () => {
    const state = richState();
    const focused = getFocusedObjects(state);
    assert.deepEqual(
      focused.map((object) => object.id),
      ["obj_bracket"]
    );
  });

  it("silently skips a stale focus id", () => {
    const state = createWorldModelState({
      project: { name: "x", description: "x", objective: { summary: "" } },
      session: { focusObjectIds: ["does_not_exist"] }
    });
    assert.deepEqual(getFocusedObjects(state), []);
  });

  it("returns an empty array when nothing is focused", () => {
    assert.deepEqual(getFocusedObjects(emptyState()), []);
  });
});

describe("observeProject: scope 'project'", () => {
  it("returns every entity and relationship, unfiltered", () => {
    const result = observeProject(richState(), { scope: "project" });
    assert.equal(result.scope, "project");
    assert.equal(result.requirements.length, 1);
    assert.equal(result.objects.length, 2, "includes obj_unrelated too -- project scope is unfiltered");
    assert.equal(result.relationships.length, 4);
    assert.equal(result.scopeObjectId, null);
  });

  it("defaults to scope 'project' when no options are given", () => {
    const result = observeProject(richState());
    assert.equal(result.scope, "project");
  });

  it("handles a genuinely empty project without throwing", () => {
    const result = observeProject(emptyState());
    assert.equal(result.requirements.length, 0);
    assert.equal(result.objects.length, 0);
    assert.equal(result.relationships.length, 0);
  });

  it("a project with requirements but no geometry observes cleanly", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "x",
        objective: { summary: "x" },
        requirements: [{ description: "Must be lightweight" }]
      },
      session: {}
    });
    const result = observeProject(state);
    assert.equal(result.requirements.length, 1);
    assert.equal(result.objects.length, 0);
  });

  it("a project with objects but no requirements observes cleanly and flags the gap", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "x",
        objective: { summary: "x" },
        objects: [{ type: "part", name: "Bracket" }]
      },
      session: {}
    });
    const result = observeProject(state);
    assert.equal(result.objects.length, 1);
    assert.equal(result.requirements.length, 0);
    assert.ok(result.missingInformation.some((entry) => /no requirements/i.test(entry)));
  });

  it("flags an undefined objective as missing information", () => {
    const result = observeProject(emptyState());
    assert.ok(result.missingInformation.some((entry) => /objective/i.test(entry)));
  });

  it("does not flag a defined objective as missing", () => {
    const result = observeProject(richState());
    assert.equal(
      result.missingInformation.some((entry) => /objective/i.test(entry)),
      false
    );
  });
});

describe("observeProject: scope 'focus'", () => {
  it("scopes to the focused object plus its one-hop context", () => {
    const result = observeProject(richState(), { scope: "focus" });
    assert.equal(result.scope, "focus");
    assert.equal(result.objects.some((object) => object.id === "obj_bracket"), true);
    assert.equal(result.objects.some((object) => object.id === "obj_unrelated"), false, "unrelated object excluded");
    assert.equal(result.requirements.some((requirement) => requirement.id === "req_mass"), true);
  });

  it("records a stale focus id as missing information WITHOUT failing the whole observation", () => {
    const state = createWorldModelState({
      project: { name: "x", description: "x", objective: { summary: "x" } },
      session: { focusObjectIds: ["does_not_exist"] }
    });
    let result: ObservationResult | undefined;
    assert.doesNotThrow(() => {
      result = observeProject(state, { scope: "focus" });
    });
    assert.ok(result!.missingInformation.some((entry) => /does_not_exist/.test(entry)));
  });

  it("with nothing focused, returns an empty (not erroring) focus observation", () => {
    const result = observeProject(emptyState(), { scope: "focus" });
    assert.deepEqual(result.objects, []);
    assert.deepEqual(result.focusObjectIds, []);
  });
});

describe("observeProject: scope 'object'", () => {
  it("scopes to exactly the named object plus its one-hop context", () => {
    const result = observeProject(richState(), { scope: "object", objectId: "obj_bracket" });
    assert.equal(result.scope, "object");
    assert.equal(result.scopeObjectId, "obj_bracket");
    assert.equal(result.objects.length, 1);
    assert.equal(result.requirements.length, 1);
    assert.equal(result.constraints.length, 1);
    assert.equal(result.decisions.length, 1);
  });

  it("an object with no relationships still observes cleanly, with empty context", () => {
    const result = observeProject(richState(), { scope: "object", objectId: "obj_unrelated" });
    assert.equal(result.objects.length, 1);
    assert.equal(result.requirements.length, 0);
    assert.equal(result.relationships.length, 0);
  });

  it("throws ObservationError(entity_not_found) for a nonexistent object id", () => {
    assert.throws(
      () => observeProject(richState(), { scope: "object", objectId: "does_not_exist" }),
      (error: unknown) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.kind, "entity_not_found");
        return true;
      }
    );
  });

  it("throws ObservationError(invalid_focus) for an empty objectId", () => {
    assert.throws(
      () => observeProject(richState(), { scope: "object", objectId: "" }),
      (error: unknown) => {
        assert.ok(error instanceof ObservationError);
        assert.equal(error.kind, "invalid_focus");
        return true;
      }
    );
  });
});

describe("observeProject: provenance and consistency", () => {
  it("always attributes the observation to source 'system' -- never Gemini, never a human", () => {
    const result = observeProject(richState());
    assert.equal(result.source, "system");
  });

  it("carries the project's current id and version", () => {
    const state = richState();
    const result = observeProject(state);
    assert.equal(result.projectId, state.project.id);
    assert.equal(result.projectVersion, state.project.version);
  });

  it("stamps a valid ISO observedAt timestamp", () => {
    const result = observeProject(richState());
    assert.match(result.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("observeProject: read-only / immutability", () => {
  it("never mutates the input WorldModelState", () => {
    const state = richState();
    const before = JSON.parse(JSON.stringify(state));
    observeProject(state, { scope: "project" });
    observeProject(state, { scope: "focus" });
    observeProject(state, { scope: "object", objectId: "obj_bracket" });
    assert.deepEqual(state, before);
  });

  it("returns a frozen ObservationResult that cannot be mutated by a caller", () => {
    const result = observeProject(richState());
    assert.throws(() => {
      (result as { scope: string }).scope = "focus";
    }, TypeError);
  });

  it("two observations of the identical, unmodified state produce structurally identical results (aside from id/timestamp)", () => {
    const state = richState();
    const first = observeProject(state);
    const second = observeProject(state);
    assert.deepEqual({ ...first, id: "", observedAt: "" }, { ...second, id: "", observedAt: "" });
  });

  it("REGRESSION: mutating a returned entity array cannot leak back into the World Model", () => {
    // Confirmed by direct reproduction during the P8 audit: neither
    // Project's arrays nor P1's entity factories freeze their output, so
    // an ObservationResult that merely shared references with
    // WorldModelState would let a caller corrupt the World Model via
    // .push()/property assignment on what looks like "just the result."
    const state = richState();
    const before = JSON.parse(JSON.stringify(state));
    const result = observeProject(state, { scope: "project" });

    assert.throws(() => {
      (result.requirements as unknown[]).push({});
    }, TypeError);
    assert.throws(() => {
      (result.requirements[0] as { description: string }).description = "MUTATED";
    }, TypeError);
    assert.throws(() => {
      (result.relationships[0] as { type: string }).type = "MUTATED";
    }, TypeError);
    assert.throws(() => {
      (result.metadata as Record<string, unknown>).injected = true;
    }, TypeError);

    assert.deepEqual(state, before, "the World Model must be completely unaffected by any attempted mutation above");
  });

  it("REGRESSION: entities returned by the individual query functions (getXById, getRelationshipsForEntity, ...) are ALSO immutable snapshots", () => {
    // These are independently exported and consumed outside observeProject
    // (see apps/api/src/observation-service.ts) -- the same guarantee must
    // hold for them, not just for ObservationResult.
    const state = richState();
    const before = JSON.parse(JSON.stringify(state));

    const requirement = getRequirementById(state, "req_mass")!;
    assert.throws(() => {
      (requirement as { description: string }).description = "MUTATED";
    }, TypeError);

    const relationships = getRelationshipsForEntity(state, "object", "obj_bracket");
    assert.throws(() => {
      (relationships as unknown[]).push({});
    }, TypeError);

    const focused = getFocusedObjects(state);
    assert.throws(() => {
      (focused[0] as { name: string }).name = "MUTATED";
    }, TypeError);

    assert.deepEqual(state, before);
  });
});
