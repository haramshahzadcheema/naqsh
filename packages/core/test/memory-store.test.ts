import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRecord, WorldModelValidationError, type MemoryRecordInput } from "@naqsh/schemas";
import { createMemoryStore, deserializeMemoryStore } from "../src/memory-store.js";

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

describe("MemoryStore: save/getById/list/listForProject", () => {
  it("saves and retrieves a memory record", () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput());
    store.save(memory);
    assert.deepEqual(store.getById(memory.id), memory);
  });

  it("rejects saving a duplicate id", () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput());
    store.save(memory);
    assert.throws(() => store.save(memory), WorldModelValidationError);
  });

  it("rejects saving a non-active record", () => {
    const store = createMemoryStore();
    assert.throws(() => store.save(createMemoryRecord(memoryInput({ status: "archived" }))), WorldModelValidationError);
  });

  it("listForProject returns only records for that project", () => {
    const store = createMemoryStore();
    store.save(createMemoryRecord(memoryInput({ projectId: "proj_1" })));
    store.save(createMemoryRecord(memoryInput({ projectId: "proj_2" })));
    assert.equal(store.listForProject("proj_1").length, 1);
    assert.equal(store.listForProject("proj_2").length, 1);
    assert.equal(store.list().length, 2);
  });

  it("listForProject returns an empty array for a project with no memories yet", () => {
    const store = createMemoryStore();
    assert.deepEqual(store.listForProject("proj_never_used"), []);
    assert.deepEqual(store.list(), []);
  });

  it("allows two ACTIVE, contradictory memories about the same subject to coexist -- memory does not rewrite or reconcile history", () => {
    const store = createMemoryStore();
    const earlier = createMemoryRecord(
      memoryInput({ title: "Material X considered acceptable", content: "Material X was considered acceptable under the original requirements.", createdAt: "2024-01-01T00:00:00.000Z" })
    );
    const later = createMemoryRecord(
      memoryInput({
        title: "Material X failed under updated requirements",
        content: "Material X failed verification once the requirements were tightened; it is no longer considered acceptable.",
        createdAt: "2024-06-01T00:00:00.000Z"
      })
    );
    store.save(earlier);
    store.save(later);
    // Both remain independently retrievable and ACTIVE -- neither silently
    // overwrites or invalidates the other. A caller who wants to formally
    // link them uses supersede(); until then, both stand as historically
    // true facts about DIFFERENT points in time.
    assert.equal(store.getById(earlier.id)!.status, "active");
    assert.equal(store.getById(later.id)!.status, "active");
    assert.equal(store.listForProject("proj_1").length, 2);
  });
});

describe("MemoryStore: archive", () => {
  it("transitions active -> archived, records archiveReason in metadata, bumps updatedAt", async () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput());
    store.save(memory);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const archived = store.archive(memory.id, { reason: "No longer relevant after redesign." });
    assert.equal(archived.status, "archived");
    assert.equal(archived.metadata.archiveReason, "No longer relevant after redesign.");
    assert.notEqual(archived.updatedAt, memory.updatedAt);
    assert.equal(archived.createdAt, memory.createdAt);
    assert.equal(archived.title, memory.title);
    assert.equal(archived.content, memory.content);
  });

  it("transitions active -> rejected when explicitly requested", () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput());
    store.save(memory);
    const rejected = store.archive(memory.id, { status: "rejected" });
    assert.equal(rejected.status, "rejected");
  });

  it("throws for a missing id", () => {
    const store = createMemoryStore();
    assert.throws(() => store.archive("memory_missing"), WorldModelValidationError);
  });

  it("throws when archiving an already-archived record", () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput());
    store.save(memory);
    store.archive(memory.id);
    assert.throws(() => store.archive(memory.id), WorldModelValidationError);
  });

  it("preserves the original archiveReason on a later attempt's context (dismissal-style: never overwrite provenance)", () => {
    const store = createMemoryStore();
    const memory = createMemoryRecord(memoryInput({ metadata: { origin: "manual review" } }));
    store.save(memory);
    const archived = store.archive(memory.id, { reason: "superseded by newer analysis" });
    assert.equal(archived.metadata.origin, "manual review");
    assert.equal(archived.metadata.archiveReason, "superseded by newer analysis");
  });
});

describe("MemoryStore: supersede", () => {
  it("transitions the OLD record active -> superseded, setting supersededByMemoryId to the new record's id", () => {
    const store = createMemoryStore();
    const oldMemory = createMemoryRecord(memoryInput({ title: "Old lesson" }));
    const newMemory = createMemoryRecord(memoryInput({ title: "Refined lesson" }));
    store.save(oldMemory);
    store.save(newMemory);
    const updated = store.supersede(oldMemory.id, newMemory.id);
    assert.equal(updated.status, "superseded");
    assert.equal(updated.supersededByMemoryId, newMemory.id);
    assert.equal(updated.content, oldMemory.content);
    // the NEW record is untouched by this call
    assert.equal(store.getById(newMemory.id)!.status, "active");
  });

  it("throws when oldId does not exist", () => {
    const store = createMemoryStore();
    const newMemory = createMemoryRecord(memoryInput());
    store.save(newMemory);
    assert.throws(() => store.supersede("memory_missing", newMemory.id), WorldModelValidationError);
  });

  it("throws when newId does not exist", () => {
    const store = createMemoryStore();
    const oldMemory = createMemoryRecord(memoryInput());
    store.save(oldMemory);
    assert.throws(() => store.supersede(oldMemory.id, "memory_missing"), WorldModelValidationError);
  });

  it("throws when oldId is not currently active (already superseded once)", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    const c = createMemoryRecord(memoryInput({ title: "C" }));
    store.save(a);
    store.save(b);
    store.save(c);
    store.supersede(a.id, b.id);
    assert.throws(() => store.supersede(a.id, c.id), WorldModelValidationError);
  });

  it("throws when a record attempts to supersede itself", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput());
    store.save(a);
    assert.throws(() => store.supersede(a.id, a.id), WorldModelValidationError);
  });

  it("supports a real A -> B -> C supersession chain, and every link remains historically retrievable", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A: initial finding" }));
    const b = createMemoryRecord(memoryInput({ title: "B: refined finding" }));
    const c = createMemoryRecord(memoryInput({ title: "C: final finding" }));
    store.save(a);
    store.save(b);
    store.save(c);

    store.supersede(a.id, b.id);
    store.supersede(b.id, c.id);

    const restoredA = store.getById(a.id)!;
    const restoredB = store.getById(b.id)!;
    const restoredC = store.getById(c.id)!;
    assert.equal(restoredA.status, "superseded");
    assert.equal(restoredA.supersededByMemoryId, b.id);
    assert.equal(restoredB.status, "superseded");
    assert.equal(restoredB.supersededByMemoryId, c.id);
    assert.equal(restoredC.status, "active");
    // A is still fully retrievable, unmutated content
    assert.equal(restoredA.content, a.content);
  });

  it("rejects a direct 2-cycle: A supersedes B, then B attempts to supersede A", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    store.save(a);
    store.save(b);
    store.supersede(a.id, b.id);
    // b is still "active" here (only a was ever the "old" side) -- so
    // requireActive alone would NOT block this call. It is the cycle check
    // (a is already reachable from b via a's own supersededByMemoryId) that
    // rejects it: b -> a would close a direct A<->B cycle.
    assert.throws(() => store.supersede(b.id, a.id), WorldModelValidationError);
  });

  it("rejects a longer cycle: C supersedes back to A after A -> B -> C", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    const c = createMemoryRecord(memoryInput({ title: "C" }));
    store.save(a);
    store.save(b);
    store.save(c);
    store.supersede(a.id, b.id);
    store.supersede(b.id, c.id);
    // c is still "active" here (only a and b were ever the "old" side) --
    // requireActive alone would NOT block this call either. It is the
    // cycle check, walking a's own supersededByMemoryId chain (a -> b -> c),
    // that finds c and rejects c -> a as closing a 3-node cycle.
    assert.throws(() => store.supersede(c.id, a.id), WorldModelValidationError);
  });

  it("does not create a cycle when a genuinely new, unrelated record supersedes an old one", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const d = createMemoryRecord(memoryInput({ title: "D: unrelated new record" }));
    store.save(a);
    store.save(d);
    const updated = store.supersede(a.id, d.id);
    assert.equal(updated.supersededByMemoryId, d.id);
  });

  it("allows ONE new memory to consolidate/supersede MULTIPLE distinct old records -- nothing restricts supersede() to a single predecessor per successor", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A: mass lesson" }));
    const b = createMemoryRecord(memoryInput({ title: "B: strength lesson" }));
    const consolidated = createMemoryRecord(memoryInput({ title: "Consolidated mass/strength lesson" }));
    store.save(a);
    store.save(b);
    store.save(consolidated);
    store.supersede(a.id, consolidated.id);
    store.supersede(b.id, consolidated.id);
    assert.equal(store.getById(a.id)!.supersededByMemoryId, consolidated.id);
    assert.equal(store.getById(b.id)!.supersededByMemoryId, consolidated.id);
    assert.equal(store.getById(consolidated.id)!.status, "active");
  });
});

describe("MemoryStore: serialization", () => {
  it("round-trips through JSON with full fidelity, including lifecycle state", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    store.save(a);
    store.save(b);
    store.supersede(a.id, b.id);

    const restored = deserializeMemoryStore(store.serialize());
    assert.deepEqual(restored.getById(a.id), store.getById(a.id));
    assert.deepEqual(restored.getById(b.id), store.getById(b.id));
    assert.equal(restored.getById(a.id)!.status, "superseded");
    assert.equal(restored.getById(a.id)!.supersededByMemoryId, b.id);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeMemoryStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeMemoryStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeMemoryStore(""), WorldModelValidationError);
  });

  it("a deserialized store can continue lifecycle transitions correctly", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    store.save(a);
    store.save(b);
    const restored = deserializeMemoryStore(store.serialize());
    const archived = restored.archive(b.id);
    assert.equal(archived.status, "archived");
  });

  it("AUDIT FIX: rejects a hand-corrupted serialized store carrying a supersededByMemoryId that does not resolve to any record in the payload -- a dangling pointer can only arise from tampering, never from real save/supersede calls, and must not be silently trusted", () => {
    const a = createMemoryRecord(memoryInput({ title: "A", status: "superseded", supersededByMemoryId: "memory_never_existed" }));
    assert.throws(() => deserializeMemoryStore(JSON.stringify([a])), WorldModelValidationError);
  });

  it("AUDIT FIX: rejects a hand-corrupted serialized store containing a supersession CYCLE (A superseded by B, B superseded by A) -- this can never arise from real supersede() calls (each record can be the 'old' side at most once), only from a tampered payload", () => {
    const a = createMemoryRecord(memoryInput({ id: "memory_cycle_a", title: "A" }));
    const b = createMemoryRecord(memoryInput({ id: "memory_cycle_b", title: "B" }));
    const corruptedA = { ...a, status: "superseded" as const, supersededByMemoryId: b.id };
    const corruptedB = { ...b, status: "superseded" as const, supersededByMemoryId: a.id };
    assert.throws(() => deserializeMemoryStore(JSON.stringify([corruptedA, corruptedB])), WorldModelValidationError);
  });

  it("AUDIT FIX: a genuine, non-cyclic A -> B -> C chain still deserializes cleanly (the graph-integrity check does not false-positive on a real, valid history)", () => {
    const store = createMemoryStore();
    const a = createMemoryRecord(memoryInput({ title: "A" }));
    const b = createMemoryRecord(memoryInput({ title: "B" }));
    const c = createMemoryRecord(memoryInput({ title: "C" }));
    store.save(a);
    store.save(b);
    store.save(c);
    store.supersede(a.id, b.id);
    store.supersede(b.id, c.id);
    const restored = deserializeMemoryStore(store.serialize());
    assert.equal(restored.getById(a.id)!.supersededByMemoryId, b.id);
    assert.equal(restored.getById(b.id)!.supersededByMemoryId, c.id);
  });
});
