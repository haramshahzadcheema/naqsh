import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, type MemoryRecord } from "@naqsh/schemas";
import { describeMemoryForModel } from "../src/memoryContext.js";

function buildMemory(overrides: Partial<Parameters<typeof createMemoryRecord>[0]> = {}): MemoryRecord {
  return createMemoryRecord({
    projectId: "proj_1",
    projectVersion: 1,
    kind: "decision",
    title: "Steel rejected",
    content: "Steel was evaluated but rejected because mass exceeded the requirement.",
    provenanceKind: "user_statement",
    ...overrides
  });
}

describe("describeMemoryForModel: real project memory actually reaches the model, honestly bounded", () => {
  it("reports honestly when nothing has been recorded yet -- never a fabricated summary", () => {
    const text = describeMemoryForModel([]);
    assert.match(text, /nothing recorded yet/);
  });

  it("includes an active memory's real title and content, verbatim", () => {
    const memory = buildMemory({ title: "Aluminum selected", content: "6061 aluminum chosen for the mounting bracket over steel due to mass budget." });
    const text = describeMemoryForModel([memory]);
    assert.match(text, /Aluminum selected/);
    assert.match(text, /6061 aluminum chosen for the mounting bracket over steel due to mass budget\./);
    assert.match(text, /\[decision\]/);
  });

  it("excludes archived/rejected/superseded memory -- only ACTIVE records are current, retrievable knowledge", () => {
    const active = buildMemory({ title: "Active finding", content: "Still true." });
    const archived = createMemoryRecord({ ...buildMemory({ title: "Old finding", content: "No longer relevant." }), status: "archived" });
    const rejected = createMemoryRecord({ ...buildMemory({ title: "Wrong finding", content: "Was incorrect." }), status: "rejected" });

    const text = describeMemoryForModel([active, archived, rejected]);
    assert.match(text, /Active finding/);
    assert.doesNotMatch(text, /Old finding/);
    assert.doesNotMatch(text, /Wrong finding/);
  });

  it("bounds output to the `limit` most recently created active records, never unbounded context growth", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      buildMemory({ title: `Finding ${i}`, content: `Content ${i}`, createdAt: new Date(2024, 0, i + 1).toISOString() })
    );
    const text = describeMemoryForModel(records, 2);
    // Most recent two (index 4, 3) should be present; older ones omitted.
    assert.match(text, /Finding 4/);
    assert.match(text, /Finding 3/);
    assert.doesNotMatch(text, /Finding 0/);
    assert.match(text, /3 older active record/);
  });

  it("orders shown records most-recent-first", () => {
    const older = buildMemory({ title: "Older", content: "x", createdAt: "2024-01-01T00:00:00.000Z" });
    const newer = buildMemory({ title: "Newer", content: "y", createdAt: "2024-06-01T00:00:00.000Z" });
    const text = describeMemoryForModel([older, newer]);
    assert.ok(text.indexOf("Newer") < text.indexOf("Older"), "the more recently created record must appear first");
  });
});
