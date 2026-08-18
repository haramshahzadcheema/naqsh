import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesignSpecification, WorldModelValidationError, type DesignSpecificationInput } from "@naqsh/schemas";
import { createDesignSpecificationStore, deserializeDesignSpecificationStore } from "../src/design-specification-store.js";

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket.",
    description: "A rectangular mounting plate.",
    ...overrides
  };
}

describe("DesignSpecificationStore: save/getById", () => {
  it("saves and retrieves a design", () => {
    const store = createDesignSpecificationStore();
    const design = createDesignSpecification(designInput());
    store.save(design);
    assert.deepEqual(store.getById(design.id), design);
  });

  it("rejects saving a duplicate id -- designs are immutable once created", () => {
    const store = createDesignSpecificationStore();
    const design = createDesignSpecification(designInput());
    store.save(design);
    assert.throws(() => store.save(design), WorldModelValidationError);
  });

  it("listForPlan returns only designs for that plan", () => {
    const store = createDesignSpecificationStore();
    const a = createDesignSpecification(designInput({ planId: "plan_1" }));
    const b = createDesignSpecification(designInput({ planId: "plan_2" }));
    store.save(a);
    store.save(b);
    assert.equal(store.listForPlan("plan_1").length, 1);
    assert.equal(store.listForPlan("plan_1")[0]!.id, a.id);
  });
});

describe("DesignSpecificationStore: Test 16 -- design versioning with traceability", () => {
  it("v2 supersedes v1; the revision chain is discoverable from either id", () => {
    const store = createDesignSpecificationStore();
    const v1 = createDesignSpecification(designInput({ description: "Design v1: plain plate." }));
    store.save(v1);
    const v2 = createDesignSpecification(designInput({ version: 2, supersedesDesignSpecificationId: v1.id, description: "Design v2: added a reinforcing rib." }));
    store.save(v2);

    const chainFromV1 = store.listRevisionChain(v1.id);
    assert.equal(chainFromV1.length, 2);
    assert.equal(chainFromV1[0]!.id, v1.id);
    assert.equal(chainFromV1[1]!.id, v2.id);

    const chainFromV2 = store.listRevisionChain(v2.id);
    assert.equal(chainFromV2.length, 2);
    assert.equal(chainFromV2[0]!.id, v1.id, "the chain always starts from the earliest ancestor, regardless of which id you query from");

    // v1 itself is untouched by v2's existence -- versioning never mutates
    // an earlier record, matching the schema's own immutability.
    assert.equal(store.getById(v1.id)!.description, "Design v1: plain plate.");
  });

  it("a design with no revisions has a single-entry chain", () => {
    const store = createDesignSpecificationStore();
    const design = createDesignSpecification(designInput());
    store.save(design);
    assert.equal(store.listRevisionChain(design.id).length, 1);
  });

  it("an unknown id has an empty chain", () => {
    const store = createDesignSpecificationStore();
    assert.deepEqual(store.listRevisionChain("design_missing"), []);
  });
});

describe("DesignSpecificationStore: serialization", () => {
  it("round-trips through JSON with full fidelity", () => {
    const store = createDesignSpecificationStore();
    const design = createDesignSpecification(designInput());
    store.save(design);
    const restored = deserializeDesignSpecificationStore(store.serialize());
    assert.deepEqual(restored.getById(design.id), design);
  });

  it("rejects corrupted JSON", () => {
    assert.throws(() => deserializeDesignSpecificationStore("{not json"), SyntaxError);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => deserializeDesignSpecificationStore(JSON.stringify({ not: "an array" })), WorldModelValidationError);
  });
});
