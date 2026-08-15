import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlan, createWorldModelState, type ObservationResult, type PlanInput } from "@naqsh/schemas";
import { observeProject } from "../src/observe-project.js";
import { validatePlanSemantics, type PlanSemanticIssueCode } from "../src/plan-semantics.js";

/** A rich, deterministic observation with two known requirements, one
 * constraint, one object, one decision -- everything a semantic-validation
 * test needs to reference as "real" vs. "fabricated." */
function richObservation(): ObservationResult {
  const state = createWorldModelState({
    project: {
      name: "Bracket Study",
      description: "x",
      objective: { summary: "Reduce mass by 20%." },
      requirements: [{ id: "req_mass", description: "Max mass 350g" }],
      constraints: [{ id: "con_material", description: "Aluminum only" }],
      objects: [{ id: "obj_bracket", type: "part", name: "Bracket" }],
      decisions: [{ id: "dec_material", statement: "Use aluminum 6061", reason: "cost" }]
    },
    session: {}
  });
  return observeProject(state, { scope: "project" });
}

function issueCodes(issues: { code: PlanSemanticIssueCode }[]): PlanSemanticIssueCode[] {
  return issues.map((issue) => issue.code);
}

function buildPlanInput(observation: ObservationResult, overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    projectId: observation.projectId,
    projectVersion: observation.projectVersion,
    observationId: observation.id,
    objectiveSummary: observation.objectiveSummary ?? "",
    ...overrides
  };
}

describe("validatePlanSemantics: a well-formed plan produces no issues", () => {
  it("accepts a plan whose references are all real", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [
          {
            title: "Select material",
            description: "x",
            purpose: "unblock geometry",
            relevantRequirementIds: ["req_mass"],
            relevantConstraintIds: ["con_material"],
            relevantObjectIds: ["obj_bracket"],
            relevantDecisionIds: ["dec_material"]
          }
        ]
      })
    );
    assert.deepEqual(validatePlanSemantics(plan, observation), []);
  });

  it("accepts a plan with zero references (a legitimate 'not based on anything specific yet' step)", () => {
    const observation = richObservation();
    const plan = createPlan(buildPlanInput(observation, { steps: [{ title: "Research", description: "x", purpose: "y" }] }));
    assert.deepEqual(validatePlanSemantics(plan, observation), []);
  });
});

describe("validatePlanSemantics: hallucinated entity references are rejected", () => {
  it("rejects a step referencing a requirement id that does not exist in the observation", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [{ title: "x", description: "x", purpose: "x", relevantRequirementIds: ["req_does_not_exist"] }]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_requirement_reference"]);
  });

  it("rejects a step referencing a constraint id that does not exist in the observation", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [{ title: "x", description: "x", purpose: "x", relevantConstraintIds: ["con_does_not_exist"] }]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_constraint_reference"]);
  });

  it("rejects a step referencing an object id that does not exist in the observation", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [{ title: "x", description: "x", purpose: "x", relevantObjectIds: ["obj_does_not_exist"] }]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_object_reference"]);
  });

  it("rejects a step referencing a decision id that does not exist in the observation", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [{ title: "x", description: "x", purpose: "x", relevantDecisionIds: ["dec_does_not_exist"] }]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_decision_reference"]);
  });

  it("rejects a step referencing an assumption id that is not one of this plan's own assumptions", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [{ title: "x", description: "x", purpose: "x", assumptionIds: ["planasm_ghost"] }]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_assumption_reference"]);
  });
});

describe("validatePlanSemantics: dependency graph integrity", () => {
  it("rejects a step that depends on an unknown step id", () => {
    const observation = richObservation();
    const plan = createPlan(buildPlanInput(observation, { steps: [{ title: "x", description: "x", purpose: "x", dependsOn: ["planstep_ghost"] }] }));
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["unknown_dependency"]);
  });

  it("rejects a step that depends on itself", () => {
    const observation = richObservation();
    // createPlanStep assigns an id, so build the self-reference by hand via createPlan's own id generation --
    // simplest is a two-step plan where we know the ids after construction, then re-check via direct construction.
    const plan = createPlan(buildPlanInput(observation, { steps: [{ id: "planstep_self", title: "x", description: "x", purpose: "x", dependsOn: ["planstep_self"] }] }));
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["self_dependency"]);
  });

  it("REGRESSION: rejects a two-step circular dependency (A depends on B, B depends on A)", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [
          { id: "planstep_a", title: "A", description: "x", purpose: "x", dependsOn: ["planstep_b"] },
          { id: "planstep_b", title: "B", description: "x", purpose: "x", dependsOn: ["planstep_a"] }
        ]
      })
    );
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["circular_dependency"]);
  });

  it("REGRESSION: rejects a longer circular dependency (A -> B -> C -> A) without infinite-looping", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [
          { id: "planstep_a", title: "A", description: "x", purpose: "x", dependsOn: ["planstep_c"] },
          { id: "planstep_b", title: "B", description: "x", purpose: "x", dependsOn: ["planstep_a"] },
          { id: "planstep_c", title: "C", description: "x", purpose: "x", dependsOn: ["planstep_b"] }
        ]
      })
    );
    const issues = validatePlanSemantics(plan, observation);
    assert.equal(issues.filter((issue) => issue.code === "circular_dependency").length, 1, "reports the cycle exactly once, not once per node");
  });

  it("accepts a genuine DAG (no cycle) with a diamond dependency shape", () => {
    const observation = richObservation();
    const plan = createPlan(
      buildPlanInput(observation, {
        steps: [
          { id: "planstep_a", title: "A", description: "x", purpose: "x", dependsOn: [] },
          { id: "planstep_b", title: "B", description: "x", purpose: "x", dependsOn: ["planstep_a"] },
          { id: "planstep_c", title: "C", description: "x", purpose: "x", dependsOn: ["planstep_a"] },
          { id: "planstep_d", title: "D", description: "x", purpose: "x", dependsOn: ["planstep_b", "planstep_c"] }
        ]
      })
    );
    assert.deepEqual(validatePlanSemantics(plan, observation), []);
  });

  it("REGRESSION: a long linear dependency chain (10,000 steps, no cycle) does not overflow the call stack", () => {
    // Cycle detection used to be a plain recursive DFS -- a long enough
    // non-cyclic chain would blow the JS call stack (RangeError), silently
    // breaking validatePlanSemantics's "never throws" contract. Rewritten
    // to an iterative, explicit-stack DFS; this proves it holds at a depth
    // well beyond any realistic plan, and well beyond Node's default stack
    // limit for a recursive equivalent.
    const stepCount = 10_000;
    const steps = Array.from({ length: stepCount }, (_, index) => ({
      id: `planstep_${index}`,
      title: `Step ${index}`,
      description: "x",
      purpose: "x",
      dependsOn: index === 0 ? [] : [`planstep_${index - 1}`]
    }));
    const observation = richObservation();
    const plan = createPlan(buildPlanInput(observation, { steps }));
    assert.doesNotThrow(() => validatePlanSemantics(plan, observation));
    assert.deepEqual(validatePlanSemantics(plan, observation), []);
  });
});

describe("validatePlanSemantics: id uniqueness and project scoping", () => {
  it("rejects a plan built for a different project than the observation", () => {
    const observation = richObservation();
    const plan = createPlan(buildPlanInput(observation, { projectId: "proj_other" }));
    assert.deepEqual(issueCodes(validatePlanSemantics(plan, observation)), ["project_mismatch"]);
  });

  it("REGRESSION: two steps sharing the same id are flagged as duplicates", () => {
    const observation = richObservation();
    // createPlan runs createPlanStep on each entry independently -- build the
    // duplicate directly against the already-constructed Plan shape via
    // JSON round-trip, since createPlan itself would generate distinct ids
    // for two step inputs that both omit `id`.
    const base = createPlan(buildPlanInput(observation, { steps: [{ id: "planstep_dup", title: "A", description: "x", purpose: "x" }] }));
    const duplicated = { ...base, steps: [...base.steps, { ...base.steps[0]! }] };
    assert.deepEqual(issueCodes(validatePlanSemantics(duplicated, observation)), ["duplicate_step_id"]);
  });

  it("REGRESSION: two assumptions sharing the same id are flagged as duplicates", () => {
    const observation = richObservation();
    const base = createPlan(buildPlanInput(observation, { assumptions: [{ description: "x", rationale: "x" }] }));
    const duplicated = { ...base, assumptions: [...base.assumptions, { ...base.assumptions[0]! }] };
    assert.deepEqual(issueCodes(validatePlanSemantics(duplicated, observation)), ["duplicate_assumption_id"]);
  });

  it("REGRESSION: two unresolved questions sharing the same id are flagged as duplicates", () => {
    const observation = richObservation();
    const base = createPlan(buildPlanInput(observation, { unresolvedQuestions: [{ question: "x", reason: "x" }] }));
    const duplicated = { ...base, unresolvedQuestions: [...base.unresolvedQuestions, { ...base.unresolvedQuestions[0]! }] };
    assert.deepEqual(issueCodes(validatePlanSemantics(duplicated, observation)), ["duplicate_question_id"]);
  });

  it("REGRESSION: two risks sharing the same id are flagged as duplicates", () => {
    const observation = richObservation();
    const base = createPlan(buildPlanInput(observation, { risks: [{ description: "x", impact: "x", severity: "low" }] }));
    const duplicated = { ...base, risks: [...base.risks, { ...base.risks[0]! }] };
    assert.deepEqual(issueCodes(validatePlanSemantics(duplicated, observation)), ["duplicate_risk_id"]);
  });
});
