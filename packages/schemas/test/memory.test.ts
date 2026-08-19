import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryRecord,
  deserializeMemoryRecord,
  serializeMemoryRecord,
  WorldModelValidationError,
  type MemoryRecordInput
} from "../src/index.js";

function memoryInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    kind: "lesson",
    title: "Ribbing reduces mass without sacrificing strength",
    content: "Across experiments E1-E4, ribbed brackets consistently met strength requirements at 15-20% lower mass than solid plates.",
    provenanceKind: "user_statement",
    ...overrides
  };
}

describe("MemoryRecord: creation and validation", () => {
  it("creates a valid memory record with defaults", () => {
    const memory = createMemoryRecord(memoryInput());
    assert.equal(memory.status, "active");
    assert.equal(memory.source, "agent");
    assert.equal(memory.confidence, null);
    assert.equal(memory.supersedesMemoryId, null);
    assert.equal(memory.supersededByMemoryId, null);
    assert.equal(memory.updatedAt, memory.createdAt);
    assert.ok(memory.id.startsWith("memory_"));
    assert.deepEqual(memory.references.requirementIds, []);
    assert.deepEqual(memory.references.verificationResultIds, []);
  });

  it("is frozen (immutable) after creation, including nested references", () => {
    const memory = createMemoryRecord(memoryInput());
    assert.throws(() => {
      (memory as { title: string }).title = "tampered";
    });
    assert.throws(() => {
      (memory.references.requirementIds as string[]).push("req_x");
    });
  });

  it("rejects an empty title", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ title: "" })), WorldModelValidationError);
  });

  it("rejects an empty content", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ content: "   " })), WorldModelValidationError);
  });

  it("rejects an invalid kind", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ kind: "opinion" as never })), WorldModelValidationError);
  });

  it("rejects an invalid provenanceKind", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ provenanceKind: "vibes" as never })), WorldModelValidationError);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ status: "deleted" as never })), WorldModelValidationError);
  });

  it("accepts a fully-populated set of references", () => {
    const memory = createMemoryRecord(
      memoryInput({
        references: {
          requirementIds: ["req_1"],
          constraintIds: ["con_1"],
          decisionIds: ["decision_1"],
          preferenceIds: ["pref_1"],
          objectIds: ["obj_1"],
          experimentIds: ["experiment_1"],
          candidateIds: ["candidate_1"],
          verificationResultIds: ["verifresult_1"],
          optimizationResultIds: ["optresult_1"],
          researchEvidenceIds: ["evid_1"],
          sourceIds: ["source_1"],
          checkpointIds: ["checkpoint_1"],
          changeIds: ["change_1"]
        }
      })
    );
    assert.deepEqual(memory.references.requirementIds, ["req_1"]);
    assert.deepEqual(memory.references.changeIds, ["change_1"]);
  });

  it("serialization round-trips", () => {
    const memory = createMemoryRecord(memoryInput());
    const restored = deserializeMemoryRecord(serializeMemoryRecord(memory));
    assert.deepEqual(restored, memory);
  });

  it("rejects corrupted JSON on deserialize", () => {
    assert.throws(() => deserializeMemoryRecord("{not json"), SyntaxError);
  });

  it("rejects a well-formed but invalid object on deserialize", () => {
    assert.throws(() => deserializeMemoryRecord(JSON.stringify({ not: "a memory" })), WorldModelValidationError);
  });
});

describe("MemoryRecord: confidence <-> provenanceKind consistency", () => {
  it("createMemoryRecord silently drops a stray confidence for a non-model_synthesis provenanceKind (matches createClarification's identical status-driven defaulting discipline)", () => {
    const memory = createMemoryRecord(memoryInput({ provenanceKind: "user_statement", confidence: 0.8 }));
    assert.equal(memory.confidence, null);
  });

  it("assertMemoryRecord (via deserialize) rejects a non-null confidence for a non-model_synthesis provenanceKind -- the underlying invariant is real, not merely enforced by factory defaulting", () => {
    const record = createMemoryRecord(memoryInput({ provenanceKind: "user_statement" }));
    assert.throws(() => deserializeMemoryRecord(JSON.stringify({ ...record, confidence: 0.8 })), WorldModelValidationError);
  });

  it("accepts a confidence in [0, 1] for provenanceKind model_synthesis, with at least one reference", () => {
    const memory = createMemoryRecord(
      memoryInput({
        provenanceKind: "model_synthesis",
        confidence: 0.72,
        references: { experimentIds: ["experiment_1"] }
      })
    );
    assert.equal(memory.confidence, 0.72);
  });

  it("rejects a model_synthesis memory with zero references of any kind", () => {
    assert.throws(
      () => createMemoryRecord(memoryInput({ provenanceKind: "model_synthesis", confidence: 0.5 })),
      WorldModelValidationError
    );
  });

  it("rejects a confidence outside [0, 1]", () => {
    assert.throws(
      () =>
        createMemoryRecord(
          memoryInput({ provenanceKind: "model_synthesis", confidence: 1.5, references: { experimentIds: ["experiment_1"] } })
        ),
      WorldModelValidationError
    );
  });

  it("confidence defaults to null even when provenanceKind is model_synthesis and no confidence is given", () => {
    const memory = createMemoryRecord(memoryInput({ provenanceKind: "model_synthesis", references: { experimentIds: ["experiment_1"] } }));
    assert.equal(memory.confidence, null);
  });
});

describe("MemoryRecord: provenanceKind <-> grounding-reference consistency", () => {
  it("rejects verification_result provenance with no verificationResultIds", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ kind: "verification_finding", provenanceKind: "verification_result" })), WorldModelValidationError);
  });

  it("accepts verification_result provenance with a real verificationResultIds entry", () => {
    const memory = createMemoryRecord(
      memoryInput({ kind: "verification_finding", provenanceKind: "verification_result", references: { verificationResultIds: ["verifresult_1"] } })
    );
    assert.deepEqual(memory.references.verificationResultIds, ["verifresult_1"]);
  });

  it("rejects optimization_result provenance with no optimizationResultIds", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ kind: "optimization_finding", provenanceKind: "optimization_result" })), WorldModelValidationError);
  });

  it("rejects experiment_result provenance with no experimentIds", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ kind: "experiment_finding", provenanceKind: "experiment_result" })), WorldModelValidationError);
  });

  it("rejects research_evidence provenance with no researchEvidenceIds", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ kind: "research_finding", provenanceKind: "research_evidence" })), WorldModelValidationError);
  });

  it("rejects change_model provenance with no changeIds", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ provenanceKind: "change_model" })), WorldModelValidationError);
  });

  it("world_model_state / environment_observation / system_analysis / user_statement provenance require no specific reference", () => {
    for (const provenanceKind of ["world_model_state", "environment_observation", "system_analysis", "user_statement"] as const) {
      const memory = createMemoryRecord(memoryInput({ provenanceKind }));
      assert.equal(memory.provenanceKind, provenanceKind);
    }
  });
});

describe("MemoryRecord: status <-> supersededByMemoryId consistency", () => {
  it("rejects status superseded with a null supersededByMemoryId", () => {
    assert.throws(() => createMemoryRecord(memoryInput({ status: "superseded" })), WorldModelValidationError);
  });

  it("accepts status superseded with a real supersededByMemoryId", () => {
    const memory = createMemoryRecord(memoryInput({ status: "superseded", supersededByMemoryId: "memory_new" }));
    assert.equal(memory.status, "superseded");
    assert.equal(memory.supersededByMemoryId, "memory_new");
  });

  it("assertMemoryRecord (via deserialize) rejects a non-superseded status carrying a supersededByMemoryId -- the underlying invariant is real, not merely enforced by factory defaulting", () => {
    const record = createMemoryRecord(memoryInput());
    assert.throws(() => deserializeMemoryRecord(JSON.stringify({ ...record, status: "active", supersededByMemoryId: "memory_new" })), WorldModelValidationError);
  });

  it("createMemoryRecord silently drops supersededByMemoryId when status isn't superseded (matches createClarification's identical defaulting discipline)", () => {
    const memory = createMemoryRecord(memoryInput({ supersededByMemoryId: "memory_new" }));
    assert.equal(memory.supersededByMemoryId, null);
  });

  it("rejects a record that supersedes itself", () => {
    const record = createMemoryRecord(memoryInput());
    assert.throws(
      () =>
        deserializeMemoryRecord(
          JSON.stringify({ ...record, supersedesMemoryId: record.id })
        ),
      WorldModelValidationError
    );
  });
});

describe("MemoryRecord: archived and rejected status, supersedesMemoryId forward pointer", () => {
  it("accepts status archived", () => {
    const memory = createMemoryRecord(memoryInput({ status: "archived" }));
    assert.equal(memory.status, "archived");
    assert.equal(memory.supersededByMemoryId, null);
  });

  it("accepts status rejected", () => {
    const memory = createMemoryRecord(memoryInput({ status: "rejected" }));
    assert.equal(memory.status, "rejected");
  });

  it("accepts a forward-looking supersedesMemoryId at creation, independent of status", () => {
    const memory = createMemoryRecord(memoryInput({ supersedesMemoryId: "memory_old" }));
    assert.equal(memory.supersedesMemoryId, "memory_old");
    assert.equal(memory.status, "active");
  });
});
