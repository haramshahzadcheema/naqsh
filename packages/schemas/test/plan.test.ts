import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPlan,
  createPlanAssumption,
  createPlanQuestion,
  createPlanRisk,
  createPlanStep,
  deserializePlan,
  serializePlan,
  WorldModelValidationError,
  type PlanInput
} from "../src/index.js";

function buildInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    observationId: "obs_1",
    objectiveSummary: "Reduce mass by 20%.",
    ...overrides
  };
}

describe("PlanAssumption / PlanQuestion / PlanRisk: creation and validation", () => {
  it("creates an assumption with a generated id", () => {
    const assumption = createPlanAssumption({ description: "Aluminum is acceptable", rationale: "no material requirement exists yet" });
    assert.match(assumption.id, /^planasm_/);
  });

  it("rejects an assumption with an empty description", () => {
    assert.throws(() => createPlanAssumption({ description: "", rationale: "x" }), /planAssumption.description is required/);
  });

  it("creates a question with a generated id", () => {
    const question = createPlanQuestion({ question: "What is the max load?", reason: "blocks material selection" });
    assert.match(question.id, /^planq_/);
  });

  it("creates a risk and validates severity", () => {
    const risk = createPlanRisk({ description: "Material shortage", impact: "delays build", severity: "medium" });
    assert.equal(risk.severity, "medium");
    assert.throws(
      () => createPlanRisk({ description: "x", impact: "y", severity: "catastrophic" as never }),
      /invalid planRisk.severity/
    );
  });
});

describe("PlanStep: creation and validation", () => {
  it("creates a step with sane defaults", () => {
    const step = createPlanStep({ title: "Clarify load requirements", description: "x", purpose: "unblock material selection" });
    assert.match(step.id, /^planstep_/);
    assert.equal(step.order, 0);
    assert.equal(step.status, "pending");
    assert.deepEqual(step.dependsOn, []);
    assert.deepEqual(step.relevantRequirementIds, []);
    assert.equal(step.verificationIntent, null);
  });

  it("rejects an empty title", () => {
    assert.throws(() => createPlanStep({ title: "", description: "x", purpose: "y" }), /planStep.title is required/);
  });

  it("rejects a whitespace-only title (an LLM producing '   ' must not slip past a naive non-empty check)", () => {
    assert.throws(() => createPlanStep({ title: "   ", description: "x", purpose: "y" }), /planStep.title is required/);
  });

  it("REGRESSION: rejects an empty description -- an opaque step with no stated content defeats P9's traceability requirement", () => {
    assert.throws(() => createPlanStep({ title: "x", description: "", purpose: "y" }), /planStep.description is required/);
  });

  it("REGRESSION: rejects an empty purpose -- a step with no stated WHY is exactly the opaque 'design it, test it, improve it' plan P9 must reject", () => {
    assert.throws(() => createPlanStep({ title: "x", description: "x", purpose: "" }), /planStep.purpose is required/);
  });

  it("rejects a non-JSON-safe metadata value", () => {
    assert.throws(
      () => createPlanStep({ title: "x", description: "x", purpose: "x", metadata: { fn: () => {} } as never }),
      WorldModelValidationError
    );
  });

  it("freezes the returned step, including nested arrays", () => {
    const step = createPlanStep({ title: "x", description: "x", purpose: "x", dependsOn: ["planstep_a"] });
    assert.throws(() => {
      (step.dependsOn as string[]).push("planstep_b");
    }, TypeError);
  });
});

describe("Plan: creation and validation", () => {
  it("creates a plan with sane defaults", () => {
    const plan = createPlan(buildInput());
    assert.match(plan.id, /^plan_/);
    assert.equal(plan.status, "proposed");
    assert.equal(plan.version, 1);
    assert.equal(plan.supersedesPlanId, null);
    assert.equal(plan.source, "agent");
    assert.deepEqual(plan.steps, []);
    assert.deepEqual(plan.assumptions, []);
    assert.deepEqual(plan.missingInformation, []);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => createPlan(buildInput({ status: "in_progress" as never })), /invalid plan.status/);
  });

  it("rejects a non-positive projectVersion", () => {
    assert.throws(() => createPlan(buildInput({ projectVersion: 0 })), /plan.projectVersion must be a positive integer/);
  });

  it("validates every nested step/assumption/question/risk", () => {
    assert.throws(
      () => createPlan(buildInput({ steps: [{ title: "", description: "x", purpose: "x" } as never] })),
      /planStep.title is required/
    );
  });

  it("builds a plan with real steps referencing real assumptions", () => {
    const plan = createPlan(
      buildInput({
        assumptions: [{ description: "aluminum acceptable", rationale: "no material requirement yet" }],
        steps: [{ title: "Select material", description: "x", purpose: "unblock geometry", order: 0 }]
      })
    );
    assert.equal(plan.assumptions.length, 1);
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]?.title, "Select material");
  });

  it("round-trips through JSON with full fidelity", () => {
    const plan = createPlan(
      buildInput({
        steps: [
          {
            title: "Clarify requirements",
            description: "x",
            purpose: "y",
            relevantRequirementIds: ["req_1"],
            dependsOn: []
          }
        ],
        risks: [{ description: "delay", impact: "schedule slip", severity: "low" }],
        unresolvedQuestions: [{ question: "what load?", reason: "blocks sizing" }]
      })
    );
    const roundTripped = JSON.parse(JSON.stringify(plan));
    assert.deepEqual(roundTripped, plan);
  });

  it("REGRESSION: serializePlan/deserializePlan round-trip with full fidelity and re-validate on the way back in", () => {
    const plan = createPlan(
      buildInput({
        steps: [
          {
            title: "Clarify requirements",
            description: "x",
            purpose: "y",
            relevantRequirementIds: ["req_1"],
            dependsOn: []
          }
        ],
        assumptions: [{ description: "x", rationale: "y" }],
        risks: [{ description: "delay", impact: "schedule slip", severity: "low" }],
        unresolvedQuestions: [{ question: "what load?", reason: "blocks sizing" }]
      })
    );
    const serialized = serializePlan(plan);
    assert.equal(typeof serialized, "string");
    const deserialized = deserializePlan(serialized);
    assert.deepEqual(deserialized, plan);
  });

  it("deserializePlan rejects a malformed serialized plan rather than silently accepting it", () => {
    assert.throws(() => deserializePlan(JSON.stringify({ not: "a plan" })), WorldModelValidationError);
    assert.throws(() => deserializePlan(""), WorldModelValidationError);
  });

  it("REGRESSION: freezes the returned plan, including nested step/assumption/risk arrays", () => {
    const plan = createPlan(
      buildInput({
        steps: [{ title: "x", description: "x", purpose: "x" }],
        assumptions: [{ description: "x", rationale: "x" }]
      })
    );
    assert.throws(() => {
      (plan.steps as unknown[]).push({});
    }, TypeError);
    assert.throws(() => {
      (plan.steps[0] as { title: string }).title = "MUTATED";
    }, TypeError);
    assert.throws(() => {
      (plan.assumptions as unknown[]).push({});
    }, TypeError);
    assert.throws(() => {
      (plan.missingInformation as unknown[]).push("x");
    }, TypeError);
  });
});
