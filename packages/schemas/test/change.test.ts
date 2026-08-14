import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertChange,
  assertChangeCause,
  assertChangeTarget,
  createChange,
  createChangeCause,
  deserializeChange,
  serializeChange,
  WorldModelValidationError,
  type ChangeInput,
  type WorldModelTransition
} from "../src/index.js";

const sampleTransition: WorldModelTransition = {
  kind: "add_requirement",
  requirement: { description: "Max mass 350g", category: "mass" }
};

function buildChangeInput(overrides: Partial<ChangeInput> = {}): ChangeInput {
  return {
    sequence: 1,
    parentChangeId: null,
    projectId: "proj_1",
    sessionId: "sess_1",
    transitionKind: "add_requirement",
    transition: sampleTransition,
    target: { entityType: "requirement", entityId: "req_1" },
    before: null,
    after: { id: "req_1", description: "Max mass 350g" },
    resultingProjectVersion: 2,
    ...overrides
  };
}

describe("ChangeCause", () => {
  it("defaults kind to system and description to empty string", () => {
    const cause = createChangeCause();
    assert.equal(cause.kind, "system");
    assert.equal(cause.description, "");
  });

  it("preserves an explicit kind and description", () => {
    const cause = createChangeCause({ kind: "user_request", description: "Make it lighter." });
    assert.equal(cause.kind, "user_request");
    assert.equal(cause.description, "Make it lighter.");
  });

  it("rejects an unknown cause kind", () => {
    assert.throws(
      () => assertChangeCause({ kind: "bogus", description: "" }),
      /invalid change cause kind/
    );
  });
});

describe("ChangeTarget", () => {
  it("accepts a null entityId for project/session-level changes", () => {
    assert.doesNotThrow(() => assertChangeTarget({ entityType: "project", entityId: null }));
  });

  it("rejects an empty entityType", () => {
    assert.throws(
      () => assertChangeTarget({ entityType: "", entityId: null }),
      /change target.entityType is required/
    );
  });
});

describe("Change: creation and defaults", () => {
  it("creates a valid change with generated id, default source, and default cause", () => {
    const change = createChange(buildChangeInput());
    assert.match(change.id, /^chg_/);
    assert.equal(change.source, "system");
    assert.equal(change.cause.kind, "system");
    assert.deepEqual(change.metadata, {});
    assert.equal(typeof change.createdAt, "string");
  });

  it("preserves an explicit source and cause (provenance + cause)", () => {
    const change = createChange(
      buildChangeInput({
        source: "human",
        cause: { kind: "user_request", description: "Make the bracket 20% lighter." }
      })
    );
    assert.equal(change.source, "human");
    assert.equal(change.cause.kind, "user_request");
    assert.equal(change.cause.description, "Make the bracket 20% lighter.");
  });

  it("accepts every provenance value, including the P2-added verification and tool", () => {
    for (const source of ["human", "agent", "environment", "research", "import", "system", "verification", "tool"] as const) {
      assert.doesNotThrow(() => createChange(buildChangeInput({ source })));
    }
  });

  it("preserves before/after exactly, including null for a newly created entity", () => {
    const change = createChange(buildChangeInput({ before: null, after: { id: "req_1", status: "active" } }));
    assert.equal(change.before, null);
    assert.deepEqual(change.after, { id: "req_1", status: "active" });
  });

  it("preserves before and null after for a removed entity", () => {
    const change = createChange(
      buildChangeInput({ before: { id: "req_1", status: "active" }, after: null })
    );
    assert.deepEqual(change.before, { id: "req_1", status: "active" });
    assert.equal(change.after, null);
  });

  it("preserves the full transition (the ACTUAL STATE TRANSITION), not just its kind", () => {
    const change = createChange(buildChangeInput());
    assert.deepEqual(change.transition, sampleTransition);
    assert.equal(change.transitionKind, "add_requirement");
  });

  it("preserves ordering fields exactly as given", () => {
    const change = createChange(buildChangeInput({ sequence: 5, parentChangeId: "chg_prev" }));
    assert.equal(change.sequence, 5);
    assert.equal(change.parentChangeId, "chg_prev");
  });
});

describe("Change: rejects invalid data", () => {
  it("rejects a non-positive sequence", () => {
    assert.throws(
      () => createChange(buildChangeInput({ sequence: 0 })),
      /change.sequence must be a positive integer/
    );
  });

  it("rejects a fractional sequence", () => {
    assert.throws(
      () => createChange(buildChangeInput({ sequence: 1.5 })),
      /change.sequence must be a positive integer/
    );
  });

  it("rejects an empty projectId", () => {
    assert.throws(
      () => assertChange({ ...createChange(buildChangeInput()), projectId: "" }),
      /change.projectId is required/
    );
  });

  it("rejects an invalid provenance source", () => {
    assert.throws(
      () => assertChange({ ...createChange(buildChangeInput()), source: "narrator" }),
      /invalid change source/
    );
  });

  it("rejects a transition without a kind", () => {
    assert.throws(
      () => createChange(buildChangeInput({ transition: {} as WorldModelTransition })),
      /change.transition must be an object with a non-empty kind/
    );
  });

  it("rejects a non-positive resultingProjectVersion", () => {
    assert.throws(
      () => createChange(buildChangeInput({ resultingProjectVersion: 0 })),
      /change.resultingProjectVersion must be a positive integer/
    );
  });

  it("throws WorldModelValidationError specifically, not a generic Error", () => {
    assert.throws(() => createChange(buildChangeInput({ sequence: -1 })), WorldModelValidationError);
  });
});

describe("Change: JSON-safety (no silent semantic loss on serialize)", () => {
  it("rejects a function hidden inside metadata", () => {
    assert.throws(
      () => createChange(buildChangeInput({ metadata: { onDone: () => {} } })),
      /change.metadata must be a JSON-serializable object/
    );
  });

  it("rejects a function hidden inside after", () => {
    assert.throws(
      () => createChange(buildChangeInput({ after: { id: "req_1", handler: () => {} } })),
      /change.before must be JSON-serializable|change.after must be JSON-serializable/
    );
  });

  it("rejects a Date instance (would silently become a string on round-trip)", () => {
    assert.throws(
      () => createChange(buildChangeInput({ after: { id: "req_1", capturedAt: new Date() } })),
      /change.after must be JSON-serializable/
    );
  });

  it("rejects NaN and Infinity (JSON.stringify silently turns them into null)", () => {
    assert.throws(
      () => createChange(buildChangeInput({ after: { id: "req_1", value: Number.NaN } })),
      /change.after must be JSON-serializable/
    );
    assert.throws(
      () => createChange(buildChangeInput({ after: { id: "req_1", value: Number.POSITIVE_INFINITY } })),
      /change.after must be JSON-serializable/
    );
  });

  it("rejects undefined nested inside before/after (JSON.stringify silently drops it)", () => {
    assert.throws(
      () => createChange(buildChangeInput({ after: { id: "req_1", note: undefined } })),
      /change.after must be JSON-serializable/
    );
  });

  it("accepts ordinary nested plain data: strings, numbers, booleans, null, arrays, objects", () => {
    assert.doesNotThrow(() =>
      createChange(
        buildChangeInput({
          after: { id: "req_1", tags: ["a", "b"], count: 3, active: true, note: null, nested: { ok: true } }
        })
      )
    );
  });
});

describe("Change: immutability", () => {
  it("freezes the returned Change", () => {
    const change = createChange(buildChangeInput());
    assert.throws(() => {
      (change as { source: string }).source = "human";
    }, TypeError);
  });

  it("freezes the returned Change's cause and target", () => {
    const change = createChange(buildChangeInput());
    assert.throws(() => {
      (change.cause as { kind: string }).kind = "user_request";
    }, TypeError);
    assert.throws(() => {
      (change.target as { entityType: string }).entityType = "other";
    }, TypeError);
  });
});

describe("Change: serialization", () => {
  it("round-trips through JSON with full fidelity", () => {
    const change = createChange(
      buildChangeInput({
        source: "agent",
        cause: { kind: "agent_decision", description: "Reduce wall thickness to hit the mass target." }
      })
    );
    const deserialized = deserializeChange(serializeChange(change));
    assert.deepEqual(deserialized, change);
  });

  it("rejects an empty serialized payload", () => {
    assert.throws(() => deserializeChange(""), /serialized change is required/);
  });

  it("rejects a serialized payload that isn't a valid Change", () => {
    assert.throws(() => deserializeChange(JSON.stringify({ not: "a change" })), WorldModelValidationError);
  });
});
