import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertClarification,
  createClarification,
  createRequirementCandidate,
  deserializeClarification,
  serializeClarification,
  WorldModelValidationError,
  type ClarificationInput,
  type RequirementCandidate
} from "../src/index.js";

function candidate(overrides: Partial<Parameters<typeof createRequirementCandidate>[0]> = {}): RequirementCandidate {
  return createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "Make the bracket strong.",
    description: "The bracket must be strong.",
    category: "load",
    interpretationStatus: "ambiguous",
    ambiguityReason: "No specific load or direction was stated.",
    ...overrides
  });
}

function pendingInput(overrides: Partial<ClarificationInput> = {}): ClarificationInput {
  const snapshot = candidate();
  return {
    projectId: "proj_1",
    requirementCandidateId: snapshot.id,
    candidateSnapshot: snapshot,
    question: "What load must the bracket withstand, and in which direction?",
    reason: "No specific load or direction was stated.",
    category: "missing_threshold",
    affectedFields: ["value", "operator"],
    ...overrides
  };
}

describe("Clarification: pending lifecycle", () => {
  it("creates a valid pending clarification with defaults", () => {
    const clarification = createClarification(pendingInput());
    assert.equal(clarification.status, "pending");
    assert.equal(clarification.answerText, null);
    assert.equal(clarification.answeredAt, null);
    assert.equal(clarification.supersededBy, null);
    assert.equal(clarification.source, "agent");
    assert.ok(clarification.id.startsWith("clarify_"));
  });

  it("is frozen -- immutable once created", () => {
    const clarification = createClarification(pendingInput());
    assert.throws(() => {
      (clarification as { status: string }).status = "answered";
    }, TypeError);
  });

  it("rejects an empty question", () => {
    assert.throws(() => createClarification(pendingInput({ question: "" })), /clarification.question is required/);
  });

  it("rejects an empty affectedFields array -- a clarification about nothing", () => {
    assert.throws(() => createClarification(pendingInput({ affectedFields: [] })), /affectedFields must be a non-empty array/);
  });

  it("rejects an invalid category", () => {
    assert.throws(() => assertClarification({ ...createClarification(pendingInput()), category: "not_a_real_category" }), /invalid clarification.category/);
  });

  it("REGRESSION: rejects a requirementCandidateId that does not match the embedded candidateSnapshot.id", () => {
    assert.throws(() => createClarification(pendingInput({ requirementCandidateId: "reqcand_someone_elses" })), /requirementCandidateId must match candidateSnapshot\.id/);
  });

  it("REGRESSION: rejects a projectId that does not match the embedded candidateSnapshot.projectId (cross-project leak)", () => {
    const foreignCandidate = candidate({ projectId: "proj_OTHER" });
    assert.throws(
      () => createClarification(pendingInput({ projectId: "proj_1", requirementCandidateId: foreignCandidate.id, candidateSnapshot: foreignCandidate })),
      /clarification.projectId must match candidateSnapshot\.projectId/
    );
  });

  it("deep-validates the embedded candidateSnapshot -- a malformed snapshot is rejected", () => {
    assert.throws(() => createClarification(pendingInput({ candidateSnapshot: { not: "a real candidate" } as never })));
  });
});

describe("Clarification: answered lifecycle -- answerText/answeredAt travel together with status", () => {
  it("creates a valid answered clarification", () => {
    const clarification = createClarification(pendingInput({ status: "answered", answerText: "500 N vertically" }));
    assert.equal(clarification.status, "answered");
    assert.equal(clarification.answerText, "500 N vertically");
    assert.ok(clarification.answeredAt);
  });

  it("rejects an 'answered' clarification with no answerText -- normalized away by the factory, then rejected", () => {
    assert.throws(() => createClarification(pendingInput({ status: "answered", answerText: undefined })), /must carry a non-empty answerText/);
  });

  it("AUDIT-STYLE GUARD -- a 'pending' clarification that smuggles answerText/answeredAt has them stripped, never trusted", () => {
    const clarification = createClarification(
      pendingInput({ status: "pending", answerText: "sneaky answer", answeredAt: new Date().toISOString() } as Partial<ClarificationInput>)
    );
    assert.equal(clarification.answerText, null);
    assert.equal(clarification.answeredAt, null);
  });

  it("rejects a directly-constructed 'pending' clarification carrying answerText (assertClarification, not just the factory)", () => {
    const answered = createClarification(pendingInput({ status: "answered", answerText: "500 N" }));
    assert.throws(() => assertClarification({ ...answered, status: "pending" }), /must not carry an answerText/);
  });
});

describe("Clarification: superseded lifecycle -- supersededBy travels only with status", () => {
  it("creates a valid superseded clarification", () => {
    const clarification = createClarification(pendingInput({ status: "superseded", supersededBy: "clarify_newer" }));
    assert.equal(clarification.status, "superseded");
    assert.equal(clarification.supersededBy, "clarify_newer");
  });

  it("AUDIT-STYLE GUARD -- a 'pending' clarification that smuggles supersededBy has it stripped", () => {
    const clarification = createClarification(pendingInput({ status: "pending", supersededBy: "clarify_other" } as Partial<ClarificationInput>));
    assert.equal(clarification.supersededBy, null);
  });

  it("rejects a 'superseded' clarification with no supersededBy", () => {
    assert.throws(() => createClarification(pendingInput({ status: "superseded", supersededBy: null })), /must carry supersededBy/);
  });
});

describe("Clarification: dismissed lifecycle", () => {
  it("creates a valid dismissed clarification -- distinct from answered", () => {
    const clarification = createClarification(pendingInput({ status: "dismissed" }));
    assert.equal(clarification.status, "dismissed");
    assert.equal(clarification.answerText, null);
    assert.equal(clarification.supersededBy, null);
  });
});

describe("Clarification: serialization", () => {
  it("round-trips through JSON with full fidelity, including the embedded candidateSnapshot", () => {
    const clarification = createClarification(pendingInput());
    const restored = deserializeClarification(serializeClarification(clarification));
    assert.deepEqual(restored, clarification);
  });

  it("serializeClarification rejects a malformed object", () => {
    assert.throws(() => serializeClarification({ status: "pending" } as never), WorldModelValidationError);
  });

  it("deserializeClarification rejects corrupted JSON", () => {
    assert.throws(() => deserializeClarification("{not json"), SyntaxError);
  });
});
