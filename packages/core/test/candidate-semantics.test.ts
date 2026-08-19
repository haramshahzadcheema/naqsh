import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCandidate,
  createConstraint,
  createPlan,
  createPlanStep,
  createRequirement,
  createResearchEvidence,
  createSource,
  createWorldModelState,
  type CandidateInput,
  type Plan
} from "@naqsh/schemas";
import { validateCandidateSemantics } from "../src/candidate-semantics.js";
import { createDesignSpecificationStore } from "../src/design-specification-store.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createDesignSpecification } from "@naqsh/schemas";

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
        relevantConstraintIds: ["con_material"],
        assumptionIds: ["asm_1"]
      }),
      createPlanStep({
        id: "step_2",
        order: 1,
        title: "Design fasteners",
        description: "Select fastener hardware.",
        purpose: "Attach the plate to its host structure.",
        relevantRequirementIds: ["req_fastener"],
        relevantConstraintIds: []
      })
    ],
    assumptions: [{ id: "asm_1", description: "Load is static, not cyclic.", rationale: "No fatigue spec was given." }]
  });
}

function candidateInput(planId: string, overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projectId: "proj_1",
    projectVersion: 1,
    planId,
    planStepId: "step_1",
    hypothesis: "A ribbed aluminum bracket meets the 500 N load requirement at lower mass than a solid plate.",
    rationale: "Ribbing adds stiffness without adding much mass.",
    relevantRequirementIds: ["req_load"],
    relevantConstraintIds: ["con_material"],
    ...overrides
  };
}

describe("validateCandidateSemantics: plan/project linkage", () => {
  it("returns no issues for a well-formed candidate", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id));
    assert.deepEqual(validateCandidateSemantics(candidate, plan), []);
  });

  it("flags a planId mismatch", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput("plan_other"));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "plan_mismatch"));
  });

  it("flags a projectId mismatch", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { projectId: "proj_other" }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "project_mismatch"));
  });

  it("flags a planStepId that doesn't exist in the plan", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { planStepId: "step_missing" }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_plan_step"));
  });
});

describe("validateCandidateSemantics: requirement/constraint reference discipline (step-scoped)", () => {
  it("flags a requirement the plan step never cited", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { relevantRequirementIds: ["req_invented"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_requirement_reference"));
  });

  it("flags a constraint the plan step never cited", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { relevantConstraintIds: ["con_invented"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_constraint_reference"));
  });

  it("accepts a requirement cited by a DIFFERENT step when the candidate is scoped to its own step (still flags it)", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { planStepId: "step_1", relevantRequirementIds: ["req_fastener"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_requirement_reference"), "req_fastener belongs to step_2, not step_1");
  });
});

describe("validateCandidateSemantics: whole-plan candidate (planStepId === null)", () => {
  it("accepts requirements/constraints from ANY step when checked against the plan-wide union", () => {
    const plan = buildPlan();
    const candidate = createCandidate(
      candidateInput(plan.id, { planStepId: null, relevantRequirementIds: ["req_load", "req_fastener"], relevantConstraintIds: ["con_material"] })
    );
    const issues = validateCandidateSemantics(candidate, plan);
    assert.deepEqual(issues, []);
  });

  it("flags a requirement no step of the plan cites, even in whole-plan mode", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { planStepId: null, relevantRequirementIds: ["req_invented"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_requirement_reference"));
  });
});

describe("validateCandidateSemantics: assumption references", () => {
  it("accepts an assumption that exists in the plan", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { assumptionIds: ["asm_1"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.deepEqual(issues, []);
  });

  it("flags an assumption that does not exist in the plan", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id, { assumptionIds: ["asm_invented"] }));
    const issues = validateCandidateSemantics(candidate, plan);
    assert.ok(issues.some((issue) => issue.code === "unknown_assumption_reference"));
  });
});

describe("validateCandidateSemantics: project-level cross-check (state supplied)", () => {
  it("flags requirement/constraint/evidence ids that don't exist as real project entities", () => {
    const plan = buildPlan();
    const state = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
    const candidate = createCandidate(candidateInput(plan.id, { relevantResearchEvidenceIds: ["evid_missing"] }));
    const issues = validateCandidateSemantics(candidate, plan, { state });
    assert.ok(issues.some((issue) => issue.code === "unresolved_requirement_in_project"));
    assert.ok(issues.some((issue) => issue.code === "unresolved_constraint_in_project"));
    assert.ok(issues.some((issue) => issue.code === "unresolved_research_evidence_in_project"));
  });

  it("resolves cleanly once the requirement/constraint/evidence actually exist in the project", () => {
    const plan = buildPlan();
    const source = createSource({ title: "Aluminum alloy datasheet", locator: "https://example.com/al-6061", sourceType: "documentation" });
    const state = createWorldModelState({
      project: {
        id: "proj_1",
        name: "Bracket Study",
        requirements: [createRequirement({ id: "req_load", description: "Withstand 500 N." })],
        constraints: [createConstraint({ id: "con_material", description: "Must use recyclable material." })],
        sources: [source],
        researchEvidence: [createResearchEvidence({ id: "evid_1", sourceId: source.id, claim: "6061 aluminum tolerates 500 N in this geometry." })]
      },
      session: {}
    });
    const candidate = createCandidate(candidateInput(plan.id, { relevantResearchEvidenceIds: ["evid_1"] }));
    const issues = validateCandidateSemantics(candidate, plan, { state });
    assert.deepEqual(issues, []);
  });
});

describe("validateCandidateSemantics: DesignSpecification cross-check", () => {
  it("flags a designSpecificationId that does not exist", () => {
    const plan = buildPlan();
    const designSpecificationStore = createDesignSpecificationStore();
    const candidate = createCandidate(candidateInput(plan.id, { designSpecificationId: "design_missing" }));
    const issues = validateCandidateSemantics(candidate, plan, { designSpecificationStore });
    assert.ok(issues.some((issue) => issue.code === "unknown_design_specification_reference"));
  });

  it("flags a designSpecification generated for a different plan/step", () => {
    const plan = buildPlan();
    const designSpecificationStore = createDesignSpecificationStore();
    const design = createDesignSpecification({
      projectId: "proj_1",
      projectVersion: 1,
      planId: "plan_other",
      planStepId: "step_other",
      objectiveSummary: "Design a lightweight mounting bracket.",
      description: "A rectangular mounting plate."
    });
    designSpecificationStore.save(design);
    const candidate = createCandidate(candidateInput(plan.id, { designSpecificationId: design.id }));
    const issues = validateCandidateSemantics(candidate, plan, { designSpecificationStore });
    assert.ok(issues.some((issue) => issue.code === "design_specification_plan_mismatch"));
  });

  it("resolves cleanly when the designSpecification matches the candidate's own plan/step", () => {
    const plan = buildPlan();
    const designSpecificationStore = createDesignSpecificationStore();
    const design = createDesignSpecification({
      projectId: "proj_1",
      projectVersion: 1,
      planId: plan.id,
      planStepId: "step_1",
      objectiveSummary: "Design a lightweight mounting bracket.",
      description: "A rectangular mounting plate."
    });
    designSpecificationStore.save(design);
    const candidate = createCandidate(candidateInput(plan.id, { designSpecificationId: design.id }));
    const issues = validateCandidateSemantics(candidate, plan, { designSpecificationStore });
    assert.deepEqual(issues, []);
  });
});

describe("validateCandidateSemantics: parentCandidate cross-check", () => {
  it("flags a parentCandidateId that does not exist", () => {
    const plan = buildPlan();
    const candidateStore = createCandidateStore();
    const candidate = createCandidate(candidateInput(plan.id, { parentCandidateId: "cand_missing" }));
    const issues = validateCandidateSemantics(candidate, plan, { candidateStore });
    assert.ok(issues.some((issue) => issue.code === "unknown_parent_candidate_reference"));
  });

  it("resolves cleanly once the parent candidate actually exists", () => {
    const plan = buildPlan();
    const candidateStore = createCandidateStore();
    const parent = createCandidate(candidateInput(plan.id));
    candidateStore.save(parent);
    const child = createCandidate(candidateInput(plan.id, { parentCandidateId: parent.id }));
    const issues = validateCandidateSemantics(child, plan, { candidateStore });
    assert.deepEqual(issues, []);
  });
});

describe("validateCandidateSemantics: purity", () => {
  it("never mutates the candidate or the plan", () => {
    const plan = buildPlan();
    const candidate = createCandidate(candidateInput(plan.id));
    const beforeCandidate = JSON.stringify(candidate);
    const beforePlan = JSON.stringify(plan);
    validateCandidateSemantics(candidate, plan);
    assert.equal(JSON.stringify(candidate), beforeCandidate);
    assert.equal(JSON.stringify(plan), beforePlan);
  });
});
