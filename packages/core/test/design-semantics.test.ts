import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesignSpecification, createPlan, createPlanStep, createWorldModelState, type DesignSpecificationInput, type Plan } from "@naqsh/schemas";
import { validateDesignSpecificationSemantics } from "../src/design-semantics.js";

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
        description: "Design a rectangular mounting plate.",
        purpose: "Provide the primary load-bearing surface.",
        relevantRequirementIds: ["req_load", "req_mass"],
        relevantConstraintIds: ["con_material"]
      })
    ]
  });
}

function designInput(overrides: Partial<DesignSpecificationInput> = {}): DesignSpecificationInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId: "plan_x",
    planStepId: "step_1",
    objectiveSummary: "Design a lightweight mounting bracket for a 500 N vertical load.",
    description: "A rectangular mounting plate.",
    components: [{ id: "comp_plate", name: "Plate", type: "plate", geometryIntent: "Rectangular plate" }],
    expectedOutputs: [{ componentId: "comp_plate", environmentObjectType: "part" }],
    relevantRequirementIds: ["req_load"],
    relevantConstraintIds: ["con_material"],
    ...overrides
  };
}

describe("validateDesignSpecificationSemantics: plan/project linkage", () => {
  it("returns no issues for a well-formed design", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.deepEqual(issues, []);
  });

  it("flags a planId mismatch", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: "plan_other" }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "plan_mismatch"));
  });

  it("flags a projectId mismatch", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id, projectId: "proj_other" }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "project_mismatch"));
  });

  it("flags a planStepId that doesn't exist in the plan", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id, planStepId: "step_missing" }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_plan_step"));
  });
});

describe("validateDesignSpecificationSemantics: requirement/constraint reference discipline", () => {
  it("flags a requirement the plan step never cited (no hallucinated relevance)", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id, relevantRequirementIds: ["req_invented"] }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_requirement_reference"));
  });

  it("flags a constraint the plan step never cited", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id, relevantConstraintIds: ["con_invented"] }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_constraint_reference"));
  });

  it("cross-checks against the CURRENT project's real requirements/constraints when state is supplied", () => {
    const plan = buildPlan();
    const state = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const design = createDesignSpecification(designInput({ planId: plan.id }));
    const issues = validateDesignSpecificationSemantics(design, plan, state);
    // req_load/con_material are cited by the plan step but don't exist as
    // real Requirement/Constraint entities in this empty project.
    assert.ok(issues.some((issue) => issue.code === "unresolved_requirement_in_project"));
    assert.ok(issues.some((issue) => issue.code === "unresolved_constraint_in_project"));
  });
});

describe("validateDesignSpecificationSemantics: component/relationship/output references", () => {
  it("flags a parentComponentId that doesn't resolve", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(
      designInput({ planId: plan.id, components: [{ id: "comp_a", name: "A", type: "x", geometryIntent: "y", parentComponentId: "comp_missing" }] })
    );
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_component_reference"));
  });

  it("detects a parentComponentId cycle", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(
      designInput({
        planId: plan.id,
        components: [
          { id: "comp_a", name: "A", type: "x", geometryIntent: "y", parentComponentId: "comp_b" },
          { id: "comp_b", name: "B", type: "x", geometryIntent: "y", parentComponentId: "comp_a" }
        ],
        expectedOutputs: [{ componentId: "comp_a", environmentObjectType: "part" }]
      })
    );
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "component_cycle"));
  });

  it("flags a relationship referencing a nonexistent component", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(
      designInput({
        planId: plan.id,
        relationships: [{ type: "attached_to", sourceComponentId: "comp_plate", targetComponentId: "comp_missing" }]
      })
    );
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_relationship_component_reference"));
  });

  it("flags an expectedOutput referencing a nonexistent component with its own distinct code (never mislabeled as a relationship issue)", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id, expectedOutputs: [{ componentId: "comp_missing", environmentObjectType: "part" }] }));
    const issues = validateDesignSpecificationSemantics(design, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_expected_output_component_reference"));
  });
});

describe("validateDesignSpecificationSemantics: purity", () => {
  it("never mutates the design or the plan", () => {
    const plan = buildPlan();
    const design = createDesignSpecification(designInput({ planId: plan.id }));
    const beforeDesign = JSON.stringify(design);
    const beforePlan = JSON.stringify(plan);
    validateDesignSpecificationSemantics(design, plan);
    assert.equal(JSON.stringify(design), beforeDesign);
    assert.equal(JSON.stringify(plan), beforePlan);
  });
});
