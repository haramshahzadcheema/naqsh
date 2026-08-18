import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertBuildResult,
  assertDesignSpecification,
  createBuildOperation,
  createBuildResult,
  createDesignSpecification,
  deserializeBuildResult,
  deserializeDesignSpecification,
  serializeBuildResult,
  serializeDesignSpecification,
  WorldModelValidationError,
  type BuildResultInput,
  type DesignSpecificationInput
} from "../src/index.js";

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_1",
    planStepId: "planstep_1",
    objectiveSummary: "Design a lightweight mounting bracket for a 500 N vertical load.",
    description: "A rectangular mounting plate with four mounting holes.",
    components: [
      { id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate, 100x60x5mm", dimensions: { length: 100, width: 60, thickness: 5 } }
    ],
    expectedOutputs: [
      { id: "out_plate", componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { Length: 100, Width: 60, Height: 5 } }
    ],
    relevantRequirementIds: ["req_load"],
    ...overrides
  };
}

describe("DesignSpecification: creation and validation", () => {
  it("creates a valid design specification with defaults", () => {
    const design = createDesignSpecification(designInput());
    assert.equal(design.status, "proposed");
    assert.equal(design.version, 1);
    assert.equal(design.supersedesDesignSpecificationId, null);
    assert.equal(design.components.length, 1);
    assert.equal(design.expectedOutputs.length, 1);
    assert.ok(design.id.startsWith("design_"));
  });

  it("is frozen (deeply) -- components/expectedOutputs cannot be mutated after construction", () => {
    const design = createDesignSpecification(designInput());
    assert.throws(() => {
      (design as { description: string }).description = "hacked";
    }, TypeError);
    assert.throws(() => {
      (design.components[0] as { name: string }).name = "hacked";
    }, TypeError);
  });

  it("rejects a design with no components but an expectedOutput referencing one (unvalidated shape-level -- componentId is just required to be a non-empty string here)", () => {
    // Shape validation alone does not cross-check componentId resolves --
    // that's design-semantics.ts's job (core layer). Confirm shape-only
    // validation still accepts a structurally valid but dangling reference.
    const design = createDesignSpecification(designInput({ components: [], expectedOutputs: [{ componentId: "comp_missing", environmentObjectType: "part" }] }));
    assert.equal(design.components.length, 0);
    assert.equal(design.expectedOutputs[0]!.componentId, "comp_missing");
  });

  it("rejects a non-finite dimension", () => {
    assert.throws(
      () =>
        createDesignSpecification(
          designInput({ components: [{ name: "x", type: "plate", geometryIntent: "y", dimensions: { length: Number.NaN } }] })
        ),
      /must be a finite number/
    );
  });

  it("rejects an empty description", () => {
    assert.throws(() => createDesignSpecification(designInput({ description: "" })), /designSpecification.description is required/);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => assertDesignSpecification({ ...createDesignSpecification(designInput()), status: "not_a_real_status" }), /invalid designSpecification.status/);
  });

  it("supports versioning via supersedesDesignSpecificationId", () => {
    const v1 = createDesignSpecification(designInput());
    const v2 = createDesignSpecification(designInput({ version: 2, supersedesDesignSpecificationId: v1.id, description: "Revised: added a reinforcing rib." }));
    assert.equal(v2.supersedesDesignSpecificationId, v1.id);
    assert.equal(v2.version, 2);
    assert.notEqual(v2.id, v1.id);
  });
});

describe("DesignSpecification: environment independence", () => {
  it("carries no FreeCAD-specific field names anywhere in its own shape", () => {
    const design = createDesignSpecification(designInput());
    const serialized = JSON.stringify(design).toLowerCase();
    for (const forbidden of ["freecad", "part::feature", "part::box", "app.activedocument", "fc.opendocument"]) {
      assert.equal(serialized.includes(forbidden), false, `design specification must not mention "${forbidden}"`);
    }
  });
});

describe("DesignSpecification: serialization", () => {
  it("round-trips through JSON with full fidelity", () => {
    const design = createDesignSpecification(designInput());
    const restored = deserializeDesignSpecification(serializeDesignSpecification(design));
    assert.deepEqual(restored, design);
  });

  it("serializeDesignSpecification rejects a malformed object", () => {
    assert.throws(() => serializeDesignSpecification({ status: "proposed" } as never), WorldModelValidationError);
  });

  it("deserializeDesignSpecification rejects corrupted JSON", () => {
    assert.throws(() => deserializeDesignSpecification("{not json"), SyntaxError);
  });
});

function buildResultInput(overrides: Partial<BuildResultInput> = {}): BuildResultInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    designSpecificationId: "design_1",
    ...overrides
  };
}

describe("BuildResult: creation and validation", () => {
  it("creates a valid pending build result with defaults", () => {
    const result = createBuildResult(buildResultInput());
    assert.equal(result.status, "pending");
    assert.equal(result.buildSuccess, false);
    assert.deepEqual(result.operations, []);
  });

  it("buildSuccess is ALWAYS derived from status, never independently trusted", () => {
    const completed = createBuildResult(buildResultInput({ status: "completed", buildSuccess: false }));
    assert.equal(completed.buildSuccess, true, "buildSuccess must be forced true when status is completed, regardless of caller input");

    const failed = createBuildResult(buildResultInput({ status: "failed", buildSuccess: true }));
    assert.equal(failed.buildSuccess, false, "buildSuccess must be forced false when status is failed, regardless of caller input");
  });

  it("rejects a hand-constructed object where buildSuccess disagrees with status", () => {
    const result = createBuildResult(buildResultInput({ status: "completed" }));
    assert.throws(() => assertBuildResult({ ...result, buildSuccess: false }), /buildSuccess must be true if and only if status/);
  });
});

describe("BuildOperation: lifecycle invariants", () => {
  it("a succeeded operation must carry startedAt/completedAt and no error", () => {
    const operation = createBuildOperation({ expectedOutputId: "out_1", toolName: "create_environment_object", status: "succeeded", output: { ok: true } });
    assert.equal(operation.status, "succeeded");
    assert.equal(operation.error, null);
    assert.ok(operation.startedAt);
    assert.ok(operation.completedAt);
  });

  it("a failed operation must carry an error and no output", () => {
    const operation = createBuildOperation({
      expectedOutputId: "out_1",
      toolName: "create_environment_object",
      status: "failed",
      error: { kind: "execution_failure", message: "adapter rejected the operation" }
    });
    assert.equal(operation.status, "failed");
    assert.equal(operation.output, null);
    assert.equal(operation.error!.message, "adapter rejected the operation");
  });

  it("a pending/skipped operation carries no output/error/timestamps regardless of what the caller smuggled in", () => {
    const operation = createBuildOperation({
      expectedOutputId: "out_1",
      toolName: "create_environment_object",
      status: "skipped",
      output: { sneaky: true },
      error: { kind: "x", message: "y" }
    });
    assert.equal(operation.output, null);
    assert.equal(operation.error, null);
    assert.equal(operation.startedAt, null);
    assert.equal(operation.completedAt, null);
  });
});

describe("BuildResult: serialization", () => {
  it("round-trips through JSON with full fidelity, including nested operations", () => {
    const result = createBuildResult(
      buildResultInput({
        status: "completed",
        operations: [{ expectedOutputId: "out_1", toolName: "create_environment_object", status: "succeeded", output: { id: "envobj_1" } }]
      })
    );
    const restored = deserializeBuildResult(serializeBuildResult(result));
    assert.deepEqual(restored, result);
  });

  it("deserializeBuildResult rejects corrupted JSON", () => {
    assert.throws(() => deserializeBuildResult("{not json"), SyntaxError);
  });
});
