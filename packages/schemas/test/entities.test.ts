import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertConstraint,
  assertDecision,
  assertEngineeringObject,
  assertEntityRelationship,
  assertExperiment,
  assertPreference,
  assertRequirement,
  assertSessionState,
  createConstraint,
  createDecision,
  createEngineeringObject,
  createEntityRelationship,
  createExperiment,
  createId,
  createObjective,
  createPreference,
  createProject,
  createRequirement,
  createSessionState,
  createWorldModelState,
  deserializeProject,
  deserializeWorldModelState,
  isIsoTimestamp,
  isValid,
  serializeProject,
  serializeWorldModelState,
  WorldModelValidationError
} from "../src/index.js";

describe("ids", () => {
  it("namespaces ids by prefix", () => {
    const id = createId("req");
    assert.match(id, /^req_/);
  });

  it("generates distinct ids across calls", () => {
    const first = createId("req");
    const second = createId("req");
    assert.notEqual(first, second);
  });

  it("honors a caller-supplied value instead of generating one", () => {
    assert.equal(createId("req", "fixed"), "req_fixed");
  });

  it("recognizes ISO 8601 timestamps and rejects everything else", () => {
    assert.equal(isIsoTimestamp("2026-08-14T00:00:00.000Z"), true);
    assert.equal(isIsoTimestamp("2026-08-14"), false);
    assert.equal(isIsoTimestamp(1234), false);
  });
});

describe("entity factories default and validate", () => {
  it("creates a requirement with sane defaults", () => {
    const requirement = createRequirement({ description: "Max mass 350g", category: "mass" });
    assertRequirement(requirement);
    assert.equal(requirement.priority, "medium");
    assert.equal(requirement.status, "active");
    assert.equal(requirement.source, "human");
  });

  it("rejects a requirement with an invalid priority", () => {
    assert.throws(
      () => createRequirement({ description: "x", category: "mass", priority: "urgent" as never }),
      WorldModelValidationError
    );
  });

  it("REGRESSION: rejects a requirement with a non-JSON-safe metadata value (a function slipping past validation would silently vanish on serialization)", () => {
    assert.throws(
      () => createRequirement({ description: "x", category: "mass", metadata: { audit: () => {} } as never }),
      WorldModelValidationError
    );
  });

  it("REGRESSION: rejects a requirement with a non-string, non-null unit (previously typed but never validated)", () => {
    assert.throws(
      () => createRequirement({ description: "x", category: "mass", unit: 42 as never }),
      /requirement.unit must be a string or null/
    );
  });

  it("throws WorldModelValidationError with kind 'invalid_shape' for a malformed entity", () => {
    try {
      createRequirement({ description: "x", category: "mass", priority: "urgent" as never });
      assert.fail("expected createRequirement to throw");
    } catch (error) {
      assert.ok(error instanceof WorldModelValidationError);
      assert.equal(error.kind, "invalid_shape");
    }
  });

  it("creates and validates a constraint", () => {
    const constraint = createConstraint({ description: "Aluminum only", category: "material" });
    assertConstraint(constraint);
    assert.equal(constraint.severity, "hard");
  });

  it("rejects a constraint with an invalid severity", () => {
    assert.throws(
      () => createConstraint({ description: "x", category: "material", severity: "maybe" as never }),
      /invalid constraint severity/
    );
  });

  it("creates and validates an engineering object", () => {
    const object = createEngineeringObject({ type: "component", name: "Main Bracket" });
    assertEngineeringObject(object);
    assert.deepEqual(object.relationships, []);
  });

  it("requires a non-empty type on an engineering object", () => {
    assert.throws(
      () => createEngineeringObject({ type: "", name: "x" }),
      /object.type is required/
    );
  });

  it("creates and validates a decision with a timestamp", () => {
    const decision = createDecision({ statement: "Use aluminum", reason: "lower mass" });
    assertDecision(decision);
    assert.equal(isIsoTimestamp(decision.createdAt), true);
  });

  it("requires a non-empty decision statement", () => {
    assert.throws(() => createDecision({ statement: "  ", reason: "x" }), /decision.statement is required/);
  });

  it("creates and validates an experiment", () => {
    const experiment = createExperiment({ objective: "Compare thickness", hypothesis: "8mm is worse" });
    assertExperiment(experiment);
    assert.equal(experiment.status, "planned");
    assert.equal(experiment.updatedAt, experiment.createdAt);
  });

  it("creates and validates a preference", () => {
    const preference = createPreference({ description: "Prefer simple geometry", category: "complexity" });
    assertPreference(preference);
    assert.equal(preference.status, "active");
  });

  it("rejects an unknown preference status", () => {
    assert.throws(
      () => createPreference({ description: "x", category: "y", status: "archived" as never }),
      /invalid preference status/
    );
  });

  it("creates and validates a session state", () => {
    const session = createSessionState({ mode: "designing" });
    assertSessionState(session);
    assert.equal(session.projectId, null);
  });

  it("rejects an unknown session id", () => {
    assert.throws(() => assertSessionState({ id: "", mode: "idle" }), /session.id is required/);
  });

  it("creates and validates an entity relationship", () => {
    const relationship = createEntityRelationship({
      type: "satisfies",
      sourceType: "object",
      sourceId: "obj_1",
      targetType: "requirement",
      targetId: "req_1"
    });
    assertEntityRelationship(relationship);
    assert.match(relationship.id, /^rel_/);
    assert.equal(relationship.source, "system");
  });

  it("rejects an entity relationship with an invalid sourceType", () => {
    assert.throws(
      () =>
        createEntityRelationship({
          type: "satisfies",
          sourceType: "freecad_part" as never,
          sourceId: "x",
          targetType: "requirement",
          targetId: "y"
        }),
      /invalid entityRelationship.sourceType/
    );
  });

  it("rejects an entity relationship with an empty type", () => {
    assert.throws(
      () =>
        createEntityRelationship({
          type: "",
          sourceType: "object",
          sourceId: "x",
          targetType: "requirement",
          targetId: "y"
        }),
      /entityRelationship.type is required/
    );
  });

  it("rejects an entity relationship with an empty targetId", () => {
    assert.throws(
      () =>
        createEntityRelationship({
          type: "satisfies",
          sourceType: "object",
          sourceId: "x",
          targetType: "requirement",
          targetId: ""
        }),
      /entityRelationship.targetId is required/
    );
  });
});

describe("project composition", () => {
  it("builds a project from raw partial nested input", () => {
    const project = createProject({
      name: "Bracket Study",
      description: "Investigate a lightweight bracket",
      objective: { summary: "Design a lightweight mounting bracket for CNC manufacturing." },
      requirements: [{ description: "Max mass 350g", category: "mass" }]
    });

    assert.equal(project.version, 1);
    assert.equal(project.requirements.length, 1);
    assert.ok(project.requirements[0]?.id.startsWith("req_"));
  });

  it("requires a non-empty project name", () => {
    assert.throws(
      () => createProject({ description: "Missing name", objective: { summary: "" } }),
      /project.name is required/
    );
  });

  it("round-trips a project through JSON", () => {
    const project = createProject({ name: "Bracket Study", description: "x" });
    const deserialized = deserializeProject(serializeProject(project));
    assert.deepEqual(deserialized, project);
  });

  it("rejects an empty serialized payload", () => {
    assert.throws(() => deserializeProject(""), /serialized project is required/);
  });

  it("defaults relationships to an empty array", () => {
    const project = createProject({ name: "Bracket Study", description: "x" });
    assert.deepEqual(project.relationships, []);
  });

  it("builds a project with relationships linking a requirement and an object", () => {
    const project = createProject({
      name: "Bracket Study",
      description: "x",
      requirements: [{ id: "req_1", description: "Max mass 350g" }],
      objects: [{ id: "obj_1", type: "part", name: "Bracket" }],
      relationships: [{ type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_1" }]
    });
    assert.equal(project.relationships.length, 1);
    assert.equal(project.relationships[0]?.sourceId, "obj_1");
  });

  it("rejects a project whose relationships array contains a malformed entry", () => {
    assert.throws(
      () =>
        createProject({
          name: "x",
          description: "x",
          relationships: [{ type: "", sourceType: "object", sourceId: "a", targetType: "requirement", targetId: "b" }]
        }),
      /entityRelationship.type is required/
    );
  });

  it("round-trips a project WITH relationships through JSON", () => {
    const project = createProject({
      name: "Bracket Study",
      description: "x",
      requirements: [{ id: "req_1", description: "x" }],
      objects: [{ id: "obj_1", type: "part", name: "Bracket" }],
      relationships: [{ type: "satisfies", sourceType: "object", sourceId: "obj_1", targetType: "requirement", targetId: "req_1" }]
    });
    const deserialized = deserializeProject(serializeProject(project));
    assert.deepEqual(deserialized, project);
  });
});

describe("world model state", () => {
  it("composes a project and session, validated together", () => {
    const project = createProject({ name: "Bracket Study", description: "x" });
    const state = createWorldModelState({
      project,
      session: createSessionState({ projectId: project.id, mode: "designing" })
    });
    assert.equal(state.session.projectId, project.id);
  });

  it("round-trips through JSON", () => {
    const project = createProject({ name: "Bracket Study", description: "x" });
    const state = createWorldModelState({ project, session: { projectId: project.id } });
    const deserialized = deserializeWorldModelState(serializeWorldModelState(state));
    assert.deepEqual(deserialized, state);
  });
});

describe("createObjective", () => {
  it("defaults source to human and metadata to an empty object", () => {
    const objective = createObjective({ summary: "Design a bracket" });
    assert.equal(objective.source, "human");
    assert.deepEqual(objective.metadata, {});
  });
});

describe("isValid", () => {
  it("returns false instead of throwing for invalid input", () => {
    assert.equal(isValid(assertRequirement, { id: "" }), false);
  });

  it("returns true and narrows the type for valid input", () => {
    const requirement = createRequirement({ description: "x", category: "mass" });
    assert.equal(isValid(assertRequirement, requirement), true);
  });
});
