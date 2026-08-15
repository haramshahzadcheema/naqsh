import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequirement, createWorldModelState, WorldModelValidationError, type WorldModelState } from "@naqsh/schemas";
import { createChangeHistory, deserializeChangeHistory, type ChangeHistory } from "../src/change-history.js";
import { recordTransition } from "../src/record-transition.js";
import { updateWorldModel } from "../src/transitions.js";

function buildState(): WorldModelState {
  return createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "Investigate a lightweight bracket",
      objective: { summary: "Design a lightweight mounting bracket for CNC manufacturing." }
    },
    session: {}
  });
}

/**
 * Compares two WorldModelStates ignoring `project.updatedAt` and
 * `session.lastObservedAt`. Both are stamped with the wall-clock time
 * `updateWorldModel` ran, so two INDEPENDENT calls -- even with identical
 * inputs -- can legitimately differ by a millisecond if they straddle a
 * clock tick. That's not a correctness bug (see the "replaying... does NOT
 * necessarily reproduce" test below for the full rationale); every other
 * field, including all generated ids, must still match exactly.
 */
function assertSameStateContent(actual: WorldModelState, expected: WorldModelState): void {
  const { updatedAt: _actualUpdatedAt, ...actualProject } = actual.project;
  const { updatedAt: _expectedUpdatedAt, ...expectedProject } = expected.project;
  const { lastObservedAt: _actualObservedAt, ...actualSession } = actual.session;
  const { lastObservedAt: _expectedObservedAt, ...expectedSession } = expected.session;
  assert.deepEqual(actualProject, expectedProject);
  assert.deepEqual(actualSession, expectedSession);
}

describe("ChangeHistory: empty", () => {
  it("starts empty with sequence 1 and no head", () => {
    const history = createChangeHistory();
    assert.equal(history.nextSequence(), 1);
    assert.equal(history.headId(), null);
    assert.deepEqual(history.list(), []);
    assert.equal(history.latest(), undefined);
  });
});

describe("recordTransition: creates a Change alongside applying the reducer", () => {
  it("returns the same state updateWorldModel would, plus a Change", () => {
    const history = createChangeHistory();
    const state = buildState();
    const transition = {
      kind: "add_requirement" as const,
      requirement: createRequirement({ description: "Max mass 350g", category: "mass" })
    };

    const viaReducerOnly = updateWorldModel(state, transition);
    const { state: viaRecordTransition, change } = recordTransition(history, state, transition);

    assertSameStateContent(viaRecordTransition, viaReducerOnly);
    assert.equal(change.transitionKind, "add_requirement");
  });

  it("does not mutate updateWorldModel's purity: calling it directly still works with no history", () => {
    const state = buildState();
    // Directly calling updateWorldModel (no ChangeHistory involved at all)
    // must still work exactly as in P1 -- recordTransition is additive.
    const next = updateWorldModel(state, { kind: "observe" });
    assert.notEqual(next.session.lastObservedAt, null);
  });

  it("captures before/after scoped to the touched entity for add_requirement", () => {
    const history = createChangeHistory();
    const state = buildState();
    const { change } = recordTransition(history, state, {
      kind: "add_requirement",
      requirement: { description: "Max mass 350g", category: "mass" }
    });
    assert.equal(change.target.entityType, "requirement");
    assert.equal(change.before, null);
    assert.equal((change.after as { description: string }).description, "Max mass 350g");
  });

  it("captures explicit before/after for update_requirement", () => {
    const history = createChangeHistory();
    const state = buildState();
    const added = recordTransition(history, state, {
      kind: "add_requirement",
      requirement: { description: "Max mass 350g", category: "mass", status: "active" }
    });
    const requirementId = added.state.project.requirements[0]!.id;

    const updated = recordTransition(history, added.state, {
      kind: "update_requirement",
      requirementId,
      patch: { status: "satisfied" }
    });

    assert.equal((updated.change.before as { status: string }).status, "active");
    assert.equal((updated.change.after as { status: string }).status, "satisfied");
    assert.equal(updated.change.target.entityId, requirementId);
  });

  it("captures before with null after for remove_requirement", () => {
    const history = createChangeHistory();
    const state = buildState();
    const added = recordTransition(history, state, {
      kind: "add_requirement",
      requirement: { description: "Max mass 350g", category: "mass" }
    });
    const requirementId = added.state.project.requirements[0]!.id;

    const removed = recordTransition(history, added.state, { kind: "remove_requirement", requirementId });

    assert.notEqual(removed.change.before, null);
    assert.equal(removed.change.after, null);
  });

  it("captures scalar before/after for set_project_metadata (not a vague field list)", () => {
    const history = createChangeHistory();
    const state = buildState();
    const { change } = recordTransition(history, state, {
      kind: "set_project_metadata",
      metadata: { tag: "bracket" }
    });
    assert.deepEqual(change.before, {});
    assert.deepEqual(change.after, { tag: "bracket" });
  });

  it("still records a Change for a non-mutating transition like observe", () => {
    const history = createChangeHistory();
    const state = buildState();
    const { change } = recordTransition(history, state, { kind: "observe" });
    assert.equal(change.transitionKind, "observe");
    assert.equal(change.target.entityType, "session");
  });

  it("preserves provenance (source) and cause exactly as given", () => {
    const history = createChangeHistory();
    const state = buildState();
    const { change } = recordTransition(
      history,
      state,
      { kind: "set_project_metadata", metadata: { tag: "bracket" } },
      { source: "agent", cause: { kind: "agent_decision", description: "Tagging for traceability." } }
    );
    assert.equal(change.source, "agent");
    assert.equal(change.cause.kind, "agent_decision");
    assert.equal(change.cause.description, "Tagging for traceability.");
  });

  it("defaults source to system and cause to system when not specified", () => {
    const history = createChangeHistory();
    const { change } = recordTransition(history, buildState(), { kind: "observe" });
    assert.equal(change.source, "system");
    assert.equal(change.cause.kind, "system");
  });

  it("generates a distinct chg_-prefixed id for every change", () => {
    const history = createChangeHistory();
    const state = buildState();
    const first = recordTransition(history, state, { kind: "observe" });
    const second = recordTransition(history, first.state, { kind: "observe" });
    assert.match(first.change.id, /^chg_/);
    assert.match(second.change.id, /^chg_/);
    assert.notEqual(first.change.id, second.change.id);
  });

  it("rejects an unsupported transition kind clearly, before any Change is recorded", () => {
    const history = createChangeHistory();
    assert.throws(
      () => recordTransition(history, buildState(), { kind: "delete_project" } as never),
      WorldModelValidationError
    );
    assert.equal(history.list().length, 0);
  });
});

describe("ChangeHistory: ordering and appending", () => {
  it("assigns strictly increasing, gapless sequence numbers", () => {
    const history = createChangeHistory();
    let state = buildState();
    for (let i = 0; i < 3; i += 1) {
      const result = recordTransition(history, state, { kind: "observe" });
      state = result.state;
    }
    const sequences = history.list().map((change) => change.sequence);
    assert.deepEqual(sequences, [1, 2, 3]);
  });

  it("chains parentChangeId to the previous change's id", () => {
    const history = createChangeHistory();
    let state = buildState();
    const first = recordTransition(history, state, { kind: "observe" });
    state = first.state;
    const second = recordTransition(history, state, { kind: "observe" });

    assert.equal(first.change.parentChangeId, null);
    assert.equal(second.change.parentChangeId, first.change.id);
  });

  it("rejects appending a change out of sequence", () => {
    const producer = createChangeHistory();
    const first = recordTransition(producer, buildState(), { kind: "observe" });
    const second = recordTransition(producer, first.state, { kind: "observe" });

    // second.change carries sequence 2, but a fresh history expects 1.
    const freshHistory = createChangeHistory();
    assert.throws(() => freshHistory.append(second.change), /Change out of order/);
  });

  it("REGRESSION: an out-of-sequence append throws WorldModelValidationError with kind 'invalid_change_sequence'", () => {
    const producer = createChangeHistory();
    const first = recordTransition(producer, buildState(), { kind: "observe" });
    const second = recordTransition(producer, first.state, { kind: "observe" });
    const freshHistory = createChangeHistory();
    try {
      freshHistory.append(second.change);
      assert.fail("expected append to throw");
    } catch (error) {
      assert.ok(error instanceof WorldModelValidationError);
      assert.equal(error.kind, "invalid_change_sequence");
    }
  });

  it("rejects appending a duplicate change id", () => {
    const history = createChangeHistory();
    const state = buildState();
    const first = recordTransition(history, state, { kind: "observe" });
    assert.throws(
      () =>
        history.append({
          ...first.change,
          sequence: history.nextSequence(),
          parentChangeId: first.change.id,
          id: first.change.id
        }),
      /Duplicate change id/
    );
  });

  it("rejects appending a change with an incorrect parentChangeId", () => {
    const history = createChangeHistory();
    const first = recordTransition(history, buildState(), { kind: "observe" });
    assert.throws(
      () =>
        history.append({
          ...first.change,
          id: "chg_different",
          sequence: history.nextSequence(),
          parentChangeId: "chg_not_the_real_head"
        }),
      /incorrect parentChangeId/
    );
  });

  it("rejects appending a structurally invalid change", () => {
    const history = createChangeHistory();
    assert.throws(() => history.append({ not: "a change" } as never), WorldModelValidationError);
  });
});

describe("ChangeHistory: retrieval", () => {
  function seedHistory(): { history: ChangeHistory; state: WorldModelState } {
    const history = createChangeHistory();
    let state = buildState();
    const addRequirement = recordTransition(history, state, {
      kind: "add_requirement",
      requirement: { description: "Max mass 350g", category: "mass" }
    });
    state = addRequirement.state;
    const addConstraint = recordTransition(history, state, {
      kind: "add_constraint",
      constraint: { description: "Aluminum 6061", category: "material" }
    });
    state = addConstraint.state;
    const observed = recordTransition(history, state, { kind: "observe" });
    state = observed.state;
    return { history, state };
  }

  it("retrieves a change by id", () => {
    const { history } = seedHistory();
    const target = history.list()[0]!;
    assert.deepEqual(history.getById(target.id), target);
  });

  it("returns undefined for an unknown id", () => {
    const { history } = seedHistory();
    assert.equal(history.getById("chg_does_not_exist"), undefined);
  });

  it("retrieves changes for a project", () => {
    const { history, state } = seedHistory();
    const forProject = history.listForProject(state.project.id);
    assert.equal(forProject.length, 3);
  });

  it("retrieves changes for a session", () => {
    const { history, state } = seedHistory();
    const forSession = history.listForSession(state.session.id);
    assert.equal(forSession.length, 3);
  });

  it("retrieves changes affecting a specific target", () => {
    const { history, state } = seedHistory();
    const requirementId = state.project.requirements[0]!.id;
    const forTarget = history.listForTarget("requirement", requirementId);
    assert.equal(forTarget.length, 1);
    assert.equal(forTarget[0]!.transitionKind, "add_requirement");
  });

  it("reports the latest change", () => {
    const { history } = seedHistory();
    assert.equal(history.latest()!.transitionKind, "observe");
  });

  it("list() returns changes in application order", () => {
    const { history } = seedHistory();
    const kinds = history.list().map((change) => change.transitionKind);
    assert.deepEqual(kinds, ["add_requirement", "add_constraint", "observe"]);
  });
});

describe("ChangeHistory: serialization", () => {
  it("round-trips through JSON with full fidelity", () => {
    const history = createChangeHistory();
    let state = buildState();
    for (const transition of [
      { kind: "add_requirement" as const, requirement: { description: "Max mass 350g", category: "mass" } },
      { kind: "observe" as const }
    ]) {
      state = recordTransition(history, state, transition).state;
    }

    const restored = deserializeChangeHistory(history.serialize());
    assert.deepEqual(restored.list(), history.list());
    assert.equal(restored.nextSequence(), history.nextSequence());
    assert.equal(restored.headId(), history.headId());
  });

  it("rejects an empty serialized payload", () => {
    assert.throws(() => deserializeChangeHistory(""), /serialized change history is required/);
  });

  it("rejects a serialized payload that is not an array", () => {
    assert.throws(
      () => deserializeChangeHistory(JSON.stringify({ not: "an array" })),
      /serialized change history must be an array/
    );
  });

  it("rejects a serialized history with an out-of-order entry", () => {
    const history = createChangeHistory();
    const { change } = recordTransition(history, buildState(), { kind: "observe" });
    const corrupted = JSON.stringify([{ ...change, sequence: 5 }]);
    assert.throws(() => deserializeChangeHistory(corrupted), /Change out of order/);
  });
});

describe("Reconciliation: materialized state matches replaying recorded changes", () => {
  it("replaying every change's transition through updateWorldModel reproduces the final state", () => {
    const history = createChangeHistory();
    const initial = buildState();
    let state = initial;

    const transitions = [
      { kind: "add_requirement" as const, requirement: { description: "Max mass 350g", category: "mass" } },
      { kind: "add_constraint" as const, constraint: { description: "Aluminum 6061", category: "material" } },
      { kind: "set_project_metadata" as const, metadata: { tag: "bracket" } },
      { kind: "focus_objects" as const, focusObjectIds: ["obj_1"] }
    ];

    for (const transition of transitions) {
      state = recordTransition(history, state, transition).state;
    }

    let replayed = initial;
    for (const change of history.list()) {
      replayed = updateWorldModel(replayed, change.transition);
    }

    // Replay runs at a later real instant than the original sequence did,
    // so project.updatedAt / session.lastObservedAt are *expected* to
    // differ by a few milliseconds -- that's not a correctness bug, it's
    // what "replayed later" means (see assertSameStateContent above).
    // Every field that is actual business content (ids, requirements,
    // constraints, metadata, focus, version numbers) must still match
    // exactly, which is what this asserts.
    assertSameStateContent(replayed, state);
    assert.equal(typeof replayed.project.updatedAt, "string");
    assert.equal(typeof replayed.session.lastObservedAt, "string");
  });

  it("replaying the SAME transition twice does NOT necessarily reproduce it a third time -- ids are resolved once, at record time", () => {
    // This documents the P1 correction made during P2: apply() may mint a
    // new id via createId() when a caller's transition doesn't pin one.
    // recordTransition() resolves that id into the STORED transition so
    // replay is deterministic. Calling updateWorldModel directly with the
    // caller's ORIGINAL (unresolved) transition is a different story --
    // that's still free to mint a fresh id each time, which is correct:
    // outside of replay, "add a requirement" issued twice really does mean
    // two distinct requirements.
    const state = buildState();
    const rawTransition = { kind: "add_requirement" as const, requirement: { description: "x", category: "mass" } };
    const first = updateWorldModel(state, rawTransition);
    const second = updateWorldModel(state, rawTransition);
    assert.notEqual(first.project.requirements[0]!.id, second.project.requirements[0]!.id);
  });

  it("each change's resultingProjectVersion matches the project version immediately after it applied", () => {
    const history = createChangeHistory();
    let state = buildState();
    for (const transition of [
      { kind: "add_requirement" as const, requirement: { description: "x", category: "mass" } },
      { kind: "add_constraint" as const, constraint: { description: "y", category: "material" } }
    ]) {
      state = recordTransition(history, state, transition).state;
    }

    const [first, second] = history.list();
    assert.equal(first!.resultingProjectVersion, 2);
    assert.equal(second!.resultingProjectVersion, 3);
  });
});
