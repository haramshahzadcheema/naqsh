import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorldModelState } from "@naqsh/schemas";
import { buildModelContext } from "../src/context-builder.js";
import { createEmptyWorldModelState } from "../src/bootstrap.js";

describe("buildModelContext: pure, deterministic World Model -> ModelContext", () => {
  it("produces the identical context for the identical state, called twice", () => {
    const state = createEmptyWorldModelState();
    assert.deepEqual(buildModelContext(state), buildModelContext(state));
  });

  it("summarizes project identity and objective", () => {
    const state = createWorldModelState({
      project: {
        name: "Bracket Study",
        description: "A load-bearing bracket redesign.",
        objective: { summary: "Reduce mass by 20% without violating strength constraints." }
      }
    });
    const context = buildModelContext(state);
    assert.equal(context.projectName, "Bracket Study");
    assert.equal(context.projectSummary, "A load-bearing bracket redesign.");
    assert.equal(context.objectiveSummary, "Reduce mass by 20% without violating strength constraints.");
    assert.equal(context.projectId, state.project.id);
  });

  it("uses null (not empty string) for absent free-text fields", () => {
    const state = createEmptyWorldModelState();
    const context = buildModelContext(state);
    assert.equal(context.projectSummary, null);
    assert.equal(context.objectiveSummary, null);
  });

  it("counts requirements/constraints/objects/decisions rather than embedding their full bodies", () => {
    const state = createWorldModelState({
      project: {
        name: "x",
        description: "",
        objective: { summary: "" },
        requirements: [{ description: "Must fit in 200x200mm envelope.", category: "geometry" }],
        constraints: [{ description: "Yield strength >= 250 MPa.", category: "material", severity: "hard" }],
        objects: [{ type: "part", name: "Bracket" }],
        decisions: [{ statement: "Use aluminum 6061.", reason: "Cost and machinability." }]
      }
    });
    const context = buildModelContext(state);
    assert.equal(context.requirementCount, 1);
    assert.equal(context.constraintCount, 1);
    assert.equal(context.objectCount, 1);
    assert.equal(context.decisionCount, 1);
    // Bounded: the actual requirement/constraint/object/decision text never
    // appears anywhere on ModelContext -- only counts and identifiers do.
    assert.equal("requirements" in context, false);
    assert.equal("objects" in context, false);
  });

  it("carries session mode and focus object ids", () => {
    const state = createWorldModelState({
      project: { name: "x", description: "", objective: { summary: "" } },
      session: { mode: "designing", focusObjectIds: ["envobj_1", "envobj_2"] }
    });
    const context = buildModelContext(state);
    assert.equal(context.sessionMode, "designing");
    assert.deepEqual(context.focusObjectIds, ["envobj_1", "envobj_2"]);
  });

  it("returns a JSON-serializable value (bounded and transportable)", () => {
    const state = createEmptyWorldModelState();
    const context = buildModelContext(state);
    assert.doesNotThrow(() => JSON.stringify(context));
  });
});
