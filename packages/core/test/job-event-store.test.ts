import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJobEvent, WorldModelValidationError, type JobEventInput } from "@naqsh/schemas";
import { createJobEventStore, deserializeJobEventStore } from "../src/job-event-store.js";

function eventInput(overrides: Partial<JobEventInput> = {}): JobEventInput {
  return { jobId: "job_1", projectId: "proj_1", kind: "submitted", message: "Job submitted.", ...overrides };
}

describe("JobEventStore: append-only", () => {
  it("saves and retrieves an event by id", () => {
    const store = createJobEventStore();
    const event = createJobEvent(eventInput());
    store.save(event);
    assert.deepEqual(store.getById(event.id), event);
  });

  it("rejects saving a duplicate id -- events are never overwritten", () => {
    const store = createJobEventStore();
    const event = createJobEvent(eventInput());
    store.save(event);
    assert.throws(() => store.save(event), WorldModelValidationError);
  });

  it("has no update/delete method on its public interface", () => {
    const store = createJobEventStore();
    assert.equal((store as unknown as { update?: unknown }).update, undefined);
    assert.equal((store as unknown as { delete?: unknown }).delete, undefined);
  });
});

describe("JobEventStore: listing", () => {
  it("listForJob returns only events for that job, in save order", () => {
    const store = createJobEventStore();
    const e1 = createJobEvent(eventInput({ jobId: "job_1", kind: "submitted" }));
    const e2 = createJobEvent(eventInput({ jobId: "job_1", kind: "started" }));
    const e3 = createJobEvent(eventInput({ jobId: "job_2", kind: "submitted" }));
    store.save(e1);
    store.save(e2);
    store.save(e3);
    assert.deepEqual(store.listForJob("job_1"), [e1, e2]);
  });

  it("listForProject scopes correctly across multiple jobs", () => {
    const store = createJobEventStore();
    const e1 = createJobEvent(eventInput({ jobId: "job_1", projectId: "proj_a" }));
    const e2 = createJobEvent(eventInput({ jobId: "job_2", projectId: "proj_a" }));
    const e3 = createJobEvent(eventInput({ jobId: "job_3", projectId: "proj_b" }));
    store.save(e1);
    store.save(e2);
    store.save(e3);
    assert.deepEqual(store.listForProject("proj_a").map((e) => e.id).sort(), [e1.id, e2.id].sort());
  });
});

describe("JobEventStore: serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const store = createJobEventStore();
    const event = createJobEvent(eventInput());
    store.save(event);
    const restored = deserializeJobEventStore(store.serialize());
    assert.deepEqual(restored.list(), store.list());
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeJobEventStore("{not json"), SyntaxError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeJobEventStore(""), WorldModelValidationError);
  });

  it("rejects a non-array JSON value", () => {
    assert.throws(() => deserializeJobEventStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });
});
