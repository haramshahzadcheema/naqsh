import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResearchRequest, WorldModelValidationError, type ResearchRequestInput } from "@naqsh/schemas";
import { createResearchRequestStore, deserializeResearchRequestStore } from "../src/research-request-store.js";

function requestInput(overrides: Partial<ResearchRequestInput> = {}): ResearchRequestInput {
  return { projectId: "proj_1", projectVersion: 1, query: "6061-T6 yield strength", purpose: "Evaluate requirement R-14.", ...overrides };
}

describe("ResearchRequestStore: save/getById/listForProject", () => {
  it("saves and retrieves a research request", () => {
    const store = createResearchRequestStore();
    const request = createResearchRequest(requestInput());
    store.save(request);
    assert.deepEqual(store.getById(request.id), request);
  });

  it("rejects a duplicate id -- research requests are immutable once created", () => {
    const store = createResearchRequestStore();
    const request = createResearchRequest(requestInput());
    store.save(request);
    assert.throws(() => store.save(request), WorldModelValidationError);
  });

  it("listForProject returns only requests for that project", () => {
    const store = createResearchRequestStore();
    const a = createResearchRequest(requestInput({ projectId: "proj_a" }));
    const b = createResearchRequest(requestInput({ projectId: "proj_b" }));
    store.save(a);
    store.save(b);
    assert.equal(store.listForProject("proj_a").length, 1);
    assert.equal(store.listForProject("proj_a")[0]!.id, a.id);
  });
});

describe("ResearchRequestStore: serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const store = createResearchRequestStore();
    const request = createResearchRequest(requestInput());
    store.save(request);
    const restored = deserializeResearchRequestStore(store.serialize());
    assert.deepEqual(restored.getById(request.id), request);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeResearchRequestStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeResearchRequestStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeResearchRequestStore(""), WorldModelValidationError);
  });
});
