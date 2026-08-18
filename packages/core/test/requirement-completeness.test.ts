import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequirementCandidate, createWorldModelState, type RequirementCandidateInput, type WorldModelState } from "@naqsh/schemas";
import { analyzeRequirementCandidateCompleteness } from "../src/requirement-completeness.js";
import { recordTransition } from "../src/record-transition.js";
import { createChangeHistory } from "../src/change-history.js";

function buildState(overrides: { objectCount?: number } = {}): WorldModelState {
  let state = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const history = createChangeHistory();
  const objectCount = overrides.objectCount ?? 1;
  for (let i = 0; i < objectCount; i++) {
    const { state: next } = recordTransition(history, state, { kind: "add_object", object: { id: `obj_${i}`, type: "bracket", name: `Bracket ${i}` } });
    state = next;
  }
  return state;
}

function addRequirement(state: WorldModelState, overrides: { category?: string; value?: number; unit?: string | null; operator?: string; description?: string } = {}): WorldModelState {
  const history = createChangeHistory();
  const { state: next } = recordTransition(history, state, {
    kind: "add_requirement",
    requirement: {
      description: overrides.description ?? "existing requirement",
      category: overrides.category ?? "mass",
      value: overrides.value ?? 1,
      unit: overrides.unit === undefined ? "kg" : overrides.unit,
      metadata: { operator: overrides.operator ?? "lt" }
    }
  });
  return next;
}

function specificCandidate(overrides: Partial<RequirementCandidateInput> = {}) {
  return createRequirementCandidate({
    projectId: "proj_1",
    projectVersion: 1,
    statementText: "The bracket must support 500 N vertically.",
    description: "Load capacity must be at least 500 N, applied vertically.",
    category: "load",
    operator: "gte",
    value: 500,
    unit: "N",
    interpretationStatus: "specific",
    ...overrides
  });
}

function ambiguousCandidate(overrides: Partial<RequirementCandidateInput> = {}) {
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

describe("analyzeRequirementCandidateCompleteness: Test 1 -- complete requirement needs no clarification", () => {
  it('"The bracket must support 500 N vertically." -> no clarification', () => {
    const state = buildState();
    const result = analyzeRequirementCandidateCompleteness(specificCandidate(), state);
    assert.equal(result.needsClarification, false);
    assert.deepEqual(result.drafts, []);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 2 -- vague qualitative requirement", () => {
  it('"Make the bracket strong." -> clarification requesting the missing engineering criterion', () => {
    const state = buildState();
    const result = analyzeRequirementCandidateCompleteness(ambiguousCandidate(), state);
    assert.equal(result.needsClarification, true);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0]!.category, "missing_threshold");
    assert.match(result.drafts[0]!.question, /load/i);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 3 -- missing threshold", () => {
  it('"Keep the mass low." -> clarification requesting a measurable limit', () => {
    const state = buildState();
    const candidate = ambiguousCandidate({
      statementText: "Keep the mass low.",
      description: "The design should be lightweight.",
      category: "mass",
      ambiguityReason: "No specific mass target was stated."
    });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.needsClarification, true);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0]!.category, "missing_threshold");
    assert.match(result.drafts[0]!.question, /mass/i);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 4 -- missing unit", () => {
  it('"The diameter must be 20." -> clarification for the unit', () => {
    const state = buildState();
    const candidate = ambiguousCandidate({
      statementText: "The diameter must be 20.",
      description: "Diameter must equal 20.",
      category: "dimension",
      ambiguityReason: "No unit was specified for the value 20."
    });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.needsClarification, true);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0]!.category, "missing_unit");
    assert.match(result.drafts[0]!.question, /unit/i);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 5 -- missing target", () => {
  it('"It must support 500 N." -> clarification when the system cannot determine what "it" refers to (0 objects)', () => {
    const state = buildState({ objectCount: 0 });
    const candidate = specificCandidate({ statementText: "It must support 500 N.", description: "Must support 500 N." });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.needsClarification, true);
    const targetDraft = result.drafts.find((d) => d.category === "missing_target");
    assert.ok(targetDraft, "expected a missing_target clarification");
  });

  it('"It must support 500 N." -> clarification when 2+ objects exist (ambiguous which one)', () => {
    const state = buildState({ objectCount: 2 });
    const candidate = specificCandidate({ statementText: "It must support 500 N.", description: "Must support 500 N." });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.ok(result.drafts.some((d) => d.category === "missing_target"));
  });

  it('"It must support 500 N." -> resolved (no clarification) when exactly ONE object exists -- genuinely unambiguous, not invented', () => {
    const state = buildState({ objectCount: 1 });
    const candidate = specificCandidate({ statementText: "It must support 500 N.", description: "Must support 500 N." });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.drafts.some((d) => d.category === "missing_target"), false);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 6 -- multiple independent ambiguities", () => {
  it('"Make it lightweight and strong." -> a structured clarification set covering BOTH independent ambiguities', () => {
    const state = buildState({ objectCount: 1 });
    const candidate = ambiguousCandidate({
      statementText: "Make it lightweight and strong.",
      description: "The design should be lightweight and strong.",
      category: "general",
      ambiguityReason: "No specific mass limit or load requirement was stated."
    });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    const categories = result.drafts.map((d) => d.category);
    assert.equal(result.drafts.length, 2, "expected exactly two independent clarifications, not one merged/generic question");
    assert.ok(categories.includes("missing_threshold"));
    const questions = result.drafts.map((d) => d.question);
    assert.ok(questions.some((q) => /mass/i.test(q)));
    assert.ok(questions.some((q) => /load/i.test(q)));
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 7 -- no over-clarification", () => {
  it('"The plate must be 200 mm wide." -> no irrelevant questions (material/finish/tolerance/etc. never asked)', () => {
    const state = buildState({ objectCount: 1 });
    const candidate = specificCandidate({
      statementText: "The plate must be 200 mm wide.",
      description: "Plate width must equal 200 mm.",
      category: "dimension",
      operator: "eq",
      value: 200,
      unit: "mm"
    });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.needsClarification, false);
    assert.deepEqual(result.drafts, []);
  });
});

describe("analyzeRequirementCandidateCompleteness: Test 8 -- conflicting requirements", () => {
  it("mass < 1 kg (existing) vs mass > 5 kg (candidate) -> conflict identified, neither silently wins", () => {
    let state = buildState({ objectCount: 1 });
    state = addRequirement(state, { category: "mass", value: 1, unit: "kg", operator: "lt", description: "mass must be under 1 kg" });
    const candidate = specificCandidate({
      statementText: "The assembly must weigh more than 5 kg.",
      description: "Mass must exceed 5 kg.",
      category: "mass",
      operator: "gt",
      value: 5,
      unit: "kg"
    });
    const before = JSON.stringify(state);

    const result = analyzeRequirementCandidateCompleteness(candidate, state);

    assert.equal(result.needsClarification, true);
    const conflictDraft = result.drafts.find((d) => d.category === "conflicting_constraints");
    assert.ok(conflictDraft, "expected a conflicting_constraints clarification");
    assert.match(conflictDraft!.reason, /disjoint/i);
    // Neither requirement was silently modified or deleted -- the analyzer is read-only.
    assert.equal(JSON.stringify(state), before);
    assert.equal(state.project.requirements.length, 1);
  });

  it("does NOT flag a conflict when ranges genuinely overlap", () => {
    let state = buildState({ objectCount: 1 });
    state = addRequirement(state, { category: "mass", value: 10, unit: "kg", operator: "lt", description: "mass must be under 10 kg" });
    const candidate = specificCandidate({
      statementText: "The assembly must weigh more than 2 kg.",
      description: "Mass must exceed 2 kg.",
      category: "mass",
      operator: "gt",
      value: 2,
      unit: "kg"
    });
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.drafts.some((d) => d.category === "conflicting_constraints"), false);
  });

  it("does NOT flag a conflict across different categories or incompatible units", () => {
    let state = buildState({ objectCount: 1 });
    state = addRequirement(state, { category: "mass", value: 1, unit: "kg", operator: "lt" });
    const differentCategory = specificCandidate({ category: "load", operator: "gt", value: 5, unit: "N" });
    const result1 = analyzeRequirementCandidateCompleteness(differentCategory, state);
    assert.equal(result1.drafts.some((d) => d.category === "conflicting_constraints"), false);

    const incompatibleUnit = specificCandidate({ category: "mass", operator: "gt", value: 5, unit: "lb" });
    const result2 = analyzeRequirementCandidateCompleteness(incompatibleUnit, state);
    assert.equal(result2.drafts.some((d) => d.category === "conflicting_constraints"), false);
  });

  it("REGRESSION: a garbage/non-standard requirement.metadata.operator (e.g. corrupted state, or a future tool that doesn't follow P18's operator vocabulary) is skipped, never crashes the analyzer", () => {
    let state = buildState({ objectCount: 1 });
    // Simulates a Requirement whose metadata.operator is not one of P16's
    // six known operators -- Requirement.metadata is a free-form
    // Record<string, unknown> with no schema-level guarantee about what
    // "operator" contains, so the analyzer must tolerate this rather than
    // assume it's always well-formed.
    state = addRequirement(state, { category: "mass", value: 1, unit: "kg", operator: "definitely_not_a_real_operator", description: "mass must be under 1 kg" });
    const candidate = specificCandidate({
      statementText: "The assembly must weigh more than 5 kg.",
      description: "Mass must exceed 5 kg.",
      category: "mass",
      operator: "gt",
      value: 5,
      unit: "kg"
    });
    assert.doesNotThrow(() => analyzeRequirementCandidateCompleteness(candidate, state));
    const result = analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(result.drafts.some((d) => d.category === "conflicting_constraints"), false, "a requirement with an unrecognized operator cannot be conflict-checked, so no conflict is reported");
  });
});

describe("analyzeRequirementCandidateCompleteness: purity", () => {
  it("never mutates the candidate or the WorldModelState", () => {
    const state = buildState({ objectCount: 1 });
    const candidate = ambiguousCandidate();
    const beforeState = JSON.stringify(state);
    const beforeCandidate = JSON.stringify(candidate);
    analyzeRequirementCandidateCompleteness(candidate, state);
    assert.equal(JSON.stringify(state), beforeState);
    assert.equal(JSON.stringify(candidate), beforeCandidate);
  });
});
