import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBuildResult, WorldModelValidationError, type BuildResultInput } from "@naqsh/schemas";
import { createBuildResultStore, deserializeBuildResultStore } from "../src/build-result-store.js";

function buildResultInput(overrides: Partial<BuildResultInput> = {}): BuildResultInput {
  return { projectId: "proj_1", projectVersion: 1, designSpecificationId: "design_1", ...overrides };
}

describe("BuildResultStore: save/getById", () => {
  it("saves and retrieves a build result", () => {
    const store = createBuildResultStore();
    const result = createBuildResult(buildResultInput());
    store.save(result);
    assert.deepEqual(store.getById(result.id), result);
  });

  it("rejects a duplicate id -- build results are immutable once created", () => {
    const store = createBuildResultStore();
    const result = createBuildResult(buildResultInput());
    store.save(result);
    assert.throws(() => store.save(result), WorldModelValidationError);
  });

  it("listForDesign returns only results for that design", () => {
    const store = createBuildResultStore();
    const a = createBuildResult(buildResultInput({ designSpecificationId: "design_a" }));
    const b = createBuildResult(buildResultInput({ designSpecificationId: "design_b" }));
    store.save(a);
    store.save(b);
    assert.equal(store.listForDesign("design_a").length, 1);
    assert.equal(store.listForDesign("design_a")[0]!.id, a.id);
  });
});

describe("BuildResultStore: serialization", () => {
  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeBuildResultStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeBuildResultStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });

  it("rejects an empty string", () => {
    assert.throws(() => deserializeBuildResultStore(""), WorldModelValidationError);
  });
});
