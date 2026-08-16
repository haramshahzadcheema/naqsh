import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRequirementCandidate,
  createRequirementCandidate,
  deserializeRequirementCandidate,
  serializeRequirementCandidate,
  WorldModelValidationError,
  type RequirementCandidateInput
} from "../src/index.js";

function specificInput(overrides: Partial<RequirementCandidateInput> = {}): RequirementCandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "The bracket must support 500 N.",
    description: "Load capacity must be at least 500 N.",
    category: "load",
    operator: "gte",
    value: 500,
    unit: "N",
    interpretationStatus: "specific",
    ...overrides
  };
}

function ambiguousInput(overrides: Partial<RequirementCandidateInput> = {}): RequirementCandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "Make it lightweight.",
    description: "The design should be lightweight.",
    category: "mass",
    interpretationStatus: "ambiguous",
    ambiguityReason: "No specific mass threshold was stated.",
    ...overrides
  };
}

describe("RequirementCandidate: specific (quantitative) candidates", () => {
  it("creates a valid specific candidate with defaults", () => {
    const candidate = createRequirementCandidate(specificInput());
    assert.equal(candidate.interpretationStatus, "specific");
    assert.equal(candidate.operator, "gte");
    assert.equal(candidate.value, 500);
    assert.equal(candidate.unit, "N");
    assert.equal(candidate.ambiguityReason, null);
    assert.equal(candidate.priority, "medium");
    assert.equal(candidate.source, "agent");
    assert.ok(candidate.id.startsWith("reqcand_"));
  });

  it("supports a specific QUALITATIVE candidate -- no number required to be specific", () => {
    const candidate = createRequirementCandidate(
      specificInput({
        statementText: "The design should be easy to manufacture.",
        description: "Design for manufacturability.",
        category: "manufacturability",
        operator: null,
        value: null,
        unit: null
      })
    );
    assert.equal(candidate.interpretationStatus, "specific");
    assert.equal(candidate.operator, null);
    assert.equal(candidate.value, null);
  });

  it("rejects an operator without a value", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ value: null })), /must also carry a finite numeric value/);
  });

  it("rejects a value without an operator -- a bare number has no defined comparison semantics", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ operator: null })), /must also carry an operator/);
  });

  it("accepts zero as a legitimate finite value", () => {
    const candidate = createRequirementCandidate(specificInput({ operator: "eq", value: 0, unit: "mm" }));
    assert.equal(candidate.value, 0);
  });

  it("accepts a negative value where meaningful (e.g. a temperature)", () => {
    const candidate = createRequirementCandidate(specificInput({ operator: "gte", value: -20, unit: "C" }));
    assert.equal(candidate.value, -20);
  });

  it("rejects Infinity as a value", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ value: Number.POSITIVE_INFINITY })), /must be a finite number or null/);
  });

  it("rejects a specific candidate that carries an ambiguityReason", () => {
    assert.throws(
      () => assertRequirementCandidate({ ...createRequirementCandidate(specificInput()), ambiguityReason: "should not be here" }),
      /must not carry an ambiguityReason/
    );
  });

  it("rejects an invalid operator", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ operator: "roughly" as never })), /must be a valid numeric comparison operator or null/);
  });

  it("rejects a non-finite value", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ value: Number.NaN })), /must be a finite number or null/);
  });

  it("is frozen -- immutable once created", () => {
    const candidate = createRequirementCandidate(specificInput());
    assert.throws(() => {
      (candidate as { value: number | null }).value = 999;
    }, TypeError);
  });
});

describe("RequirementCandidate: ambiguous candidates -- never carry a fabricated criterion", () => {
  it("creates a valid ambiguous candidate", () => {
    const candidate = createRequirementCandidate(ambiguousInput());
    assert.equal(candidate.interpretationStatus, "ambiguous");
    assert.equal(candidate.operator, null);
    assert.equal(candidate.value, null);
    assert.equal(candidate.unit, null);
    assert.match(candidate.ambiguityReason!, /No specific mass threshold/);
  });

  it("AUDIT-STYLE GUARD -- an ambiguous candidate that ALSO supplies operator/value/unit has them stripped, never trusted", () => {
    const candidate = createRequirementCandidate(ambiguousInput({ operator: "lt", value: 2, unit: "kg" } as Partial<RequirementCandidateInput>));
    assert.equal(candidate.operator, null);
    assert.equal(candidate.value, null);
    assert.equal(candidate.unit, null);
  });

  it("rejects an ambiguous candidate with no ambiguityReason", () => {
    assert.throws(() => createRequirementCandidate(ambiguousInput({ ambiguityReason: undefined })), /must carry a non-empty ambiguityReason/);
  });

  it("rejects an ambiguous candidate with an empty-string ambiguityReason", () => {
    assert.throws(() => createRequirementCandidate(ambiguousInput({ ambiguityReason: "" })), /must carry a non-empty ambiguityReason/);
  });
});

describe("RequirementCandidate: shared validation", () => {
  it("rejects an empty statementText", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ statementText: "" })), /statementText is required/);
  });

  it("rejects an empty category", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ category: "" })), /category is required/);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createRequirementCandidate(specificInput({ projectVersion: 0 })), /projectVersion must be a positive integer/);
  });

  it("rejects an invalid interpretationStatus", () => {
    assert.throws(() => assertRequirementCandidate({ ...createRequirementCandidate(specificInput()), interpretationStatus: "maybe" }), /invalid requirementCandidate.interpretationStatus/);
  });

  it("round-trips through JSON with full fidelity", () => {
    const candidate = createRequirementCandidate(specificInput());
    const restored = deserializeRequirementCandidate(serializeRequirementCandidate(candidate));
    assert.deepEqual(restored, candidate);
  });

  it("serializeRequirementCandidate rejects a malformed object", () => {
    assert.throws(() => serializeRequirementCandidate({ interpretationStatus: "specific" } as never), WorldModelValidationError);
  });

  it("deserializeRequirementCandidate rejects corrupted JSON", () => {
    assert.throws(() => deserializeRequirementCandidate("{not json"), SyntaxError);
  });

  it("preserves the original statementText verbatim, distinct from the restated description", () => {
    const candidate = createRequirementCandidate(specificInput({ statementText: "the bracket needs to hold at LEAST 500N, ok?" }));
    assert.equal(candidate.statementText, "the bracket needs to hold at LEAST 500N, ok?");
    assert.notEqual(candidate.statementText, candidate.description);
  });
});
