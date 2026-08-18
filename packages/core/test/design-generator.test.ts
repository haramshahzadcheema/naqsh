import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createModelInvocationResult,
  createModelProviderDescriptor,
  createModelResponse,
  createPlan,
  createPlanStep,
  createRequirement,
  createConstraint,
  type Constraint,
  type Plan,
  type Requirement
} from "@naqsh/schemas";
import { generateDesignSpecification } from "../src/design-generator.js";
import { validateStructuredResult, type ModelProvider } from "../src/index.js";

function buildFakeProvider(structuredResult: Record<string, unknown>): ModelProvider {
  return {
    describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
    async generate(request) {
      const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult });
      const schemaErrors = validateStructuredResult(response, request);
      return createModelInvocationResult({
        requestId: request.id,
        providerId: "fake",
        modelId: "fake-v1",
        status: schemaErrors.length > 0 ? "error" : "success",
        response: schemaErrors.length > 0 ? undefined : response,
        error: schemaErrors.length > 0 ? { kind: "schema_validation_failed", message: schemaErrors.join("; ") } : undefined,
        startedAt: new Date().toISOString()
      });
    }
  };
}

function buildPlan(): Plan {
  return createPlan({
    projectId: "proj_1",
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Design a lightweight mounting bracket for a 500 N vertical load.",
    steps: [
      createPlanStep({
        id: "step_1",
        order: 0,
        title: "Design mounting plate",
        description: "Design a rectangular mounting plate with four mounting holes.",
        purpose: "Provide the primary load-bearing surface.",
        relevantRequirementIds: ["req_load"],
        relevantConstraintIds: ["con_material"]
      })
    ]
  });
}

function buildRequirements(): Requirement[] {
  return [createRequirement({ id: "req_load", description: "Must support 500 N vertically.", category: "load", value: 500, unit: "N" })];
}

function buildConstraints(): Constraint[] {
  return [createConstraint({ id: "con_material", description: "Must use aluminum.", category: "material", severity: "hard" })];
}

const validDesignPayload = {
  description: "A rectangular aluminum mounting plate with four mounting holes.",
  components: [
    { id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate, 100x60x5mm", dimensions: { length: 100, width: 60, thickness: 5 }, parentComponentId: null }
  ],
  relationships: [],
  parameters: {},
  material: "aluminum",
  manufacturingIntent: "CNC milled",
  relevantRequirementIds: ["req_load"],
  relevantConstraintIds: ["con_material"],
  expectedOutputs: [{ id: "out_plate", componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: { Length: 100, Width: 60, Height: 5 } }]
};

describe("generateDesignSpecification: successful generation", () => {
  it("produces a valid, semantically-checked DesignSpecification", async () => {
    const provider = buildFakeProvider(validDesignPayload);
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    assert.equal(result.design.components.length, 1);
    assert.equal(result.design.expectedOutputs.length, 1);
    assert.equal(result.design.material, "aluminum");
    assert.equal(result.design.status, "proposed");
    assert.equal(result.design.source, "agent");
  });
});

describe("generateDesignSpecification: Test 6 -- invalid design rejected", () => {
  it("rejects a design with a hallucinated requirement reference (semantic validation)", async () => {
    const provider = buildFakeProvider({ ...validDesignPayload, relevantRequirementIds: ["req_invented"] });
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("rejects a design whose expectedOutput references a nonexistent component", async () => {
    const provider = buildFakeProvider({ ...validDesignPayload, expectedOutputs: [{ id: "out_x", componentId: "comp_missing", environmentObjectType: "part", environmentGenericType: null, properties: {} }] });
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "semantic_validation_failed");
  });

  it("rejects malformed structured output (missing required fields)", async () => {
    const provider = buildFakeProvider({ description: "x" });
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
  });

  it("rejects an unknown planStepId", async () => {
    const provider = buildFakeProvider(validDesignPayload);
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_missing", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "invalid_input");
  });
});

describe("generateDesignSpecification: Test 7 -- no arbitrary code", () => {
  it("a model response that tries to smuggle code into geometryIntent is stored as inert text, never executed", async () => {
    const provider = buildFakeProvider({
      ...validDesignPayload,
      components: [
        {
          id: "comp_plate",
          name: "Mounting Plate",
          type: "plate",
          geometryIntent: "'); require('child_process').execSync('echo pwned'); //",
          dimensions: {},
          parentComponentId: null
        }
      ]
    });
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "success");
    if (result.status !== "success") return;
    // Stored as a plain string field -- never interpreted, never executed.
    assert.equal(typeof result.design.components[0]!.geometryIntent, "string");
  });
});

describe("generateDesignSpecification: model/API failure", () => {
  it("a provider that reports status:'error' is surfaced as model_unavailable, never fabricated into a design", async () => {
    const provider: ModelProvider = {
      describe: () => createModelProviderDescriptor({ providerId: "fake", modelId: "fake-v1", supportsStructuredOutput: true }),
      async generate(request) {
        return createModelInvocationResult({
          requestId: request.id,
          providerId: "fake",
          modelId: "fake-v1",
          status: "error",
          error: { kind: "api_unavailable", message: "simulated outage" },
          startedAt: new Date().toISOString()
        });
      }
    };
    const plan = buildPlan();
    const result = await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.kind, "model_unavailable");
  });
});

describe("generateDesignSpecification: purity", () => {
  it("never mutates the plan", async () => {
    const provider = buildFakeProvider(validDesignPayload);
    const plan = buildPlan();
    const before = JSON.stringify(plan);
    await generateDesignSpecification(provider, plan, "step_1", buildRequirements(), buildConstraints(), { config: { modelId: "fake-v1" } });
    assert.equal(JSON.stringify(plan), before);
  });
});
