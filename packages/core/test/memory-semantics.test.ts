import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, createWorldModelState, type MemoryRecordInput, type WorldModelState } from "@naqsh/schemas";
import { createMemoryStore } from "../src/memory-store.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { getRelatedMemoryRecords, searchMemoryRecords, validateMemoryRecordSemantics, MAX_MEMORY_SEARCH_RESULTS } from "../src/memory-semantics.js";

function memoryInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    kind: "lesson",
    title: "Ribbing reduces mass",
    content: "Ribbed brackets consistently met strength at lower mass than solid plates.",
    provenanceKind: "user_statement",
    ...overrides
  };
}

describe("validateMemoryRecordSemantics: project scoping", () => {
  it("reports project_mismatch when the record's projectId differs from live state", () => {
    const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const memory = createMemoryRecord(memoryInput({ projectId: "proj_other" }));
    const issues = validateMemoryRecordSemantics(memory, { state });
    assert.ok(issues.some((issue) => issue.code === "project_mismatch"));
  });

  it("reports no issues for a well-formed, self-contained memory with no state/store dependencies", () => {
    const memory = createMemoryRecord(memoryInput());
    assert.deepEqual(validateMemoryRecordSemantics(memory), []);
  });
});

describe("validateMemoryRecordSemantics: World Model reference checks", () => {
  it("reports unresolved_requirement_in_project for a nonexistent requirement id", () => {
    const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const memory = createMemoryRecord(memoryInput({ references: { requirementIds: ["req_missing"] } }));
    const issues = validateMemoryRecordSemantics(memory, { state });
    assert.ok(issues.some((issue) => issue.code === "unresolved_requirement_in_project"));
  });

  it("reports unresolved_decision_in_project for a nonexistent decision id", () => {
    const state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const memory = createMemoryRecord(memoryInput({ references: { decisionIds: ["decision_missing"] } }));
    const issues = validateMemoryRecordSemantics(memory, { state });
    assert.ok(issues.some((issue) => issue.code === "unresolved_decision_in_project"));
  });

  it("accepts a real requirement/decision id present in the project", () => {
    const state: WorldModelState = createWorldModelState({
      project: { id: "proj_1", name: "Bracket Study", requirements: [{ description: "d", category: "mass" }], decisions: [{ statement: "s", reason: "r" }] },
      session: {}
    });
    const requirementId = state.project.requirements[0]!.id;
    const decisionId = state.project.decisions[0]!.id;
    const memory = createMemoryRecord(memoryInput({ references: { requirementIds: [requirementId], decisionIds: [decisionId] } }));
    const issues = validateMemoryRecordSemantics(memory, { state });
    assert.deepEqual(issues, []);
  });
});

describe("validateMemoryRecordSemantics: store cross-reference checks", () => {
  it("reports unknown_candidate_reference for a nonexistent candidate id", () => {
    const candidateStore = createCandidateStore();
    const memory = createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_missing"] } }));
    const issues = validateMemoryRecordSemantics(memory, { candidateStore });
    assert.ok(issues.some((issue) => issue.code === "unknown_candidate_reference"));
  });

  it("skips a check entirely when its dependency is not supplied", () => {
    const memory = createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_missing"] } }));
    assert.deepEqual(validateMemoryRecordSemantics(memory), []);
  });
});

describe("validateMemoryRecordSemantics: duplicate detection", () => {
  it("reports possible_duplicate_memory for a same (projectId, kind, title) active record", () => {
    const memoryStore = createMemoryStore();
    memoryStore.save(createMemoryRecord(memoryInput({ title: "Same title" })));
    const candidate = createMemoryRecord(memoryInput({ title: "Same title" }));
    const issues = validateMemoryRecordSemantics(candidate, { memoryStore });
    assert.ok(issues.some((issue) => issue.code === "possible_duplicate_memory"));
  });

  it("does not flag a duplicate against a SUPERSEDED record with the same title", () => {
    const memoryStore = createMemoryStore();
    const original = createMemoryRecord(memoryInput({ title: "Same title" }));
    const replacement = createMemoryRecord(memoryInput({ title: "Different title" }));
    memoryStore.save(original);
    memoryStore.save(replacement);
    memoryStore.supersede(original.id, replacement.id);
    const candidate = createMemoryRecord(memoryInput({ title: "Same title" }));
    const issues = validateMemoryRecordSemantics(candidate, { memoryStore });
    assert.deepEqual(issues, []);
  });

  it("does not flag a duplicate across DIFFERENT projects", () => {
    const memoryStore = createMemoryStore();
    memoryStore.save(createMemoryRecord(memoryInput({ projectId: "proj_other", title: "Same title" })));
    const candidate = createMemoryRecord(memoryInput({ projectId: "proj_1", title: "Same title" }));
    const issues = validateMemoryRecordSemantics(candidate, { memoryStore });
    assert.deepEqual(issues, []);
  });
});

describe("searchMemoryRecords: project isolation", () => {
  it("never returns a record from a different project, even if not filtered by the caller", () => {
    const records = [createMemoryRecord(memoryInput({ projectId: "proj_1" })), createMemoryRecord(memoryInput({ projectId: "proj_2" }))];
    const result = searchMemoryRecords(records, { projectId: "proj_1" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.projectId, "proj_1");
  });
});

describe("searchMemoryRecords: filters", () => {
  it("defaults to status active only", () => {
    const active = createMemoryRecord(memoryInput({ title: "Active one" }));
    const archived = createMemoryRecord(memoryInput({ title: "Archived one" }));
    const records = [active, { ...archived, status: "archived" as const, updatedAt: archived.updatedAt }];
    const result = searchMemoryRecords(records, { projectId: "proj_1" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.id, active.id);
  });

  it("filters by kind", () => {
    const records = [createMemoryRecord(memoryInput({ kind: "lesson" })), createMemoryRecord(memoryInput({ kind: "failure" }))];
    const result = searchMemoryRecords(records, { projectId: "proj_1", kind: "failure" });
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]!.kind, "failure");
  });

  it("filters by provenanceKind", () => {
    const records = [
      createMemoryRecord(memoryInput({ provenanceKind: "user_statement" })),
      createMemoryRecord(memoryInput({ provenanceKind: "system_analysis" }))
    ];
    const result = searchMemoryRecords(records, { projectId: "proj_1", provenanceKind: "system_analysis" });
    assert.equal(result.records.length, 1);
  });

  it("filters by referencedEntityId across any reference field", () => {
    const records = [
      createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_7"] } })),
      createMemoryRecord(memoryInput({ references: { experimentIds: ["candidate_7"] } })),
      createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_9"] } }))
    ];
    const result = searchMemoryRecords(records, { projectId: "proj_1", referencedEntityId: "candidate_7" });
    assert.equal(result.records.length, 2);
  });

  it("filters by textQuery, case-insensitively, against title or content", () => {
    const records = [
      createMemoryRecord(memoryInput({ title: "Steel evaluation", content: "considered but rejected" })),
      createMemoryRecord(memoryInput({ title: "Aluminum bracket", content: "mentions STEEL as an alternative" })),
      createMemoryRecord(memoryInput({ title: "Unrelated", content: "nothing relevant here" }))
    ];
    const result = searchMemoryRecords(records, { projectId: "proj_1", textQuery: "steel" });
    assert.equal(result.records.length, 2);
  });
});

describe("searchMemoryRecords: deterministic ordering", () => {
  it("orders a title match before a content-only match when textQuery is given", () => {
    const contentMatch = createMemoryRecord(memoryInput({ title: "Unrelated title", content: "mentions steel here" }));
    const titleMatch = createMemoryRecord(memoryInput({ title: "Steel evaluation", content: "no mention" }));
    const result = searchMemoryRecords([contentMatch, titleMatch], { projectId: "proj_1", textQuery: "steel" });
    assert.equal(result.records[0]!.id, titleMatch.id);
    assert.equal(result.records[1]!.id, contentMatch.id);
  });

  it("orders by createdAt descending (most recent first) when there is no textQuery", () => {
    const older = createMemoryRecord(memoryInput({ title: "Older", createdAt: "2024-01-01T00:00:00.000Z" }));
    const newer = createMemoryRecord(memoryInput({ title: "Newer", createdAt: "2024-06-01T00:00:00.000Z" }));
    const result = searchMemoryRecords([older, newer], { projectId: "proj_1" });
    assert.equal(result.records[0]!.id, newer.id);
    assert.equal(result.records[1]!.id, older.id);
  });

  it("uses id as a stable final tiebreak when createdAt is identical", () => {
    const timestamp = "2024-06-01T00:00:00.000Z";
    const a = createMemoryRecord(memoryInput({ id: "memory_aaa", title: "A", createdAt: timestamp }));
    const b = createMemoryRecord(memoryInput({ id: "memory_bbb", title: "B", createdAt: timestamp }));
    const result1 = searchMemoryRecords([b, a], { projectId: "proj_1" });
    const result2 = searchMemoryRecords([a, b], { projectId: "proj_1" });
    assert.deepEqual(
      result1.records.map((record) => record.id),
      result2.records.map((record) => record.id)
    );
    assert.deepEqual(
      result1.records.map((record) => record.id),
      ["memory_aaa", "memory_bbb"]
    );
  });

  it("produces identical output across repeated calls with identical input (determinism)", () => {
    const records = [
      createMemoryRecord(memoryInput({ title: "One" })),
      createMemoryRecord(memoryInput({ title: "Two" })),
      createMemoryRecord(memoryInput({ title: "Three" }))
    ];
    const first = searchMemoryRecords(records, { projectId: "proj_1" });
    const second = searchMemoryRecords(records, { projectId: "proj_1" });
    assert.deepEqual(first, second);
  });
});

describe("searchMemoryRecords: bounds", () => {
  it("defaults to a limit of 20", () => {
    const records = Array.from({ length: 30 }, (_, index) => createMemoryRecord(memoryInput({ title: `Memory ${index}` })));
    const result = searchMemoryRecords(records, { projectId: "proj_1" });
    assert.equal(result.records.length, 20);
    assert.equal(result.totalMatched, 30);
  });

  it("clamps an oversized limit to MAX_MEMORY_SEARCH_RESULTS", () => {
    const records = Array.from({ length: 150 }, (_, index) => createMemoryRecord(memoryInput({ title: `Memory ${index}` })));
    const result = searchMemoryRecords(records, { projectId: "proj_1", limit: 10000 });
    assert.equal(result.records.length, MAX_MEMORY_SEARCH_RESULTS);
    assert.equal(result.limit, MAX_MEMORY_SEARCH_RESULTS);
  });

  it("clamps a non-positive limit up to at least 1", () => {
    const records = [createMemoryRecord(memoryInput())];
    const result = searchMemoryRecords(records, { projectId: "proj_1", limit: -5 });
    assert.equal(result.limit, 1);
  });
});

describe("getRelatedMemoryRecords", () => {
  it("returns an empty array for an unknown memory id", () => {
    assert.deepEqual(getRelatedMemoryRecords([createMemoryRecord(memoryInput())], "memory_missing"), []);
  });

  it("returns records sharing at least one reference id", () => {
    const shared = createMemoryRecord(memoryInput({ references: { candidateIds: ["candidate_7"] } }));
    const related = createMemoryRecord(memoryInput({ title: "Related", references: { candidateIds: ["candidate_7"] } }));
    const unrelated = createMemoryRecord(memoryInput({ title: "Unrelated", references: { candidateIds: ["candidate_9"] } }));
    const results = getRelatedMemoryRecords([shared, related, unrelated], shared.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.record.id, related.id);
    assert.equal(results[0]!.relation, "shares_reference");
  });

  it("returns the direct supersession predecessor and successor with the correct relation labels", () => {
    const store_a = createMemoryRecord(memoryInput({ title: "A" }));
    const store_b = createMemoryRecord(memoryInput({ title: "B" }));
    const superseded_a = { ...store_a, status: "superseded" as const, supersededByMemoryId: store_b.id };
    const results = getRelatedMemoryRecords([superseded_a, store_b], store_b.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.record.id, superseded_a.id);
    assert.equal(results[0]!.relation, "supersedes");

    const resultsFromOld = getRelatedMemoryRecords([superseded_a, store_b], superseded_a.id);
    assert.equal(resultsFromOld.length, 1);
    assert.equal(resultsFromOld[0]!.record.id, store_b.id);
    assert.equal(resultsFromOld[0]!.relation, "superseded_by");
  });

  it("AUDIT FIX: returns EVERY predecessor when one memory consolidates/supersedes multiple older records, not just the first match -- MemoryStore.supersede never limits how many old records can point supersededByMemoryId at the same successor", () => {
    const a = createMemoryRecord(memoryInput({ title: "A: mass lesson" }));
    const b = createMemoryRecord(memoryInput({ title: "B: strength lesson" }));
    const consolidated = createMemoryRecord(memoryInput({ title: "Consolidated lesson" }));
    const supersededA = { ...a, status: "superseded" as const, supersededByMemoryId: consolidated.id };
    const supersededB = { ...b, status: "superseded" as const, supersededByMemoryId: consolidated.id };
    const results = getRelatedMemoryRecords([supersededA, supersededB, consolidated], consolidated.id);
    const supersedesEntries = results.filter((entry) => entry.relation === "supersedes");
    assert.equal(supersedesEntries.length, 2);
    assert.deepEqual(
      supersedesEntries.map((entry) => entry.record.id).sort(),
      [supersededA.id, supersededB.id].sort()
    );
  });
});
