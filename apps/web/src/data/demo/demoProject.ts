/**
 * DEMO DATA — built entirely from real `@naqsh/schemas` entity factories,
 * NOT hand-rolled JSON that merely looks like the real shape. Every record
 * here would pass the exact same runtime validation
 * (`assertX`/`createX`) the real backend applies — this is what "isolate
 * mock data, do not pretend it is production behavior" means in practice:
 * the DATA's structure is completely real and would deserialize/validate
 * identically to a live run; only its SOURCE (hand-authored here, instead
 * of produced by a running agent loop against a real project) is a demo
 * stand-in. See `NaqshDataSource.ts` for the seam a real backend would
 * plug into instead of this module.
 *
 * Scenario: a mounting bracket for a 50 kg static load, worked through
 * requirements -> clarification -> plan -> research -> three candidate
 * designs -> a pending proposal -> verification -> objective satisfaction
 * -> memory -> one running background experiment. Every timestamp is
 * fixed (never `Date.now()`) so the demo renders identically on every
 * load.
 */
import {
  createBackgroundJob,
  createCandidate,
  createCheck,
  createClarification,
  createConstraint,
  createDecision,
  createDesignSpecification,
  createEngineeringObject,
  createExperiment,
  createJobEvent,
  createMemoryRecord,
  createObjectiveSatisfactionResult,
  createPlan,
  createProposal,
  createRequirement,
  createRequirementCandidate,
  createResearchEvidence,
  createSource,
  createVerificationResult,
  type BackgroundJob,
  type Candidate,
  type Check,
  type Clarification,
  type Constraint,
  type Decision,
  type DesignSpecification,
  type EngineeringObject,
  type Experiment,
  type JobEvent,
  type MemoryRecord,
  type ObjectiveSatisfactionResult,
  type Plan,
  type Proposal,
  type Requirement,
  type ResearchEvidence,
  type Source,
  type VerificationResult
} from "@naqsh/schemas";

const T0 = "2026-01-14T09:00:00.000Z";
const at = (offsetMinutes: number): string => new Date(new Date(T0).getTime() + offsetMinutes * 60_000).toISOString();

export const DEMO_PROJECT = {
  id: "proj_bracket_01",
  name: "Motor Mounting Bracket",
  version: 7,
  createdAt: T0
};

export const requirements: Requirement[] = [
  createRequirement({
    id: "req_load",
    description: "Bracket must support a static load of 50 kg without yielding.",
    category: "structural",
    value: 50,
    unit: "kg",
    priority: "high",
    status: "active",
    source: "human"
  }),
  createRequirement({
    id: "req_thickness",
    description: "Maximum wall thickness of 12 mm to fit the existing enclosure.",
    category: "geometric",
    value: 12,
    unit: "mm",
    priority: "medium",
    status: "active",
    source: "human"
  })
];

export const constraints: Constraint[] = [
  createConstraint({
    id: "con_clearance",
    description: "Mounting hole edge clearance must be at least 5 mm.",
    category: "manufacturability",
    value: 5,
    unit: "mm",
    severity: "hard",
    status: "active",
    source: "agent"
  })
];

const materialCandidate = createRequirementCandidate({
  id: "reqcand_material",
  projectId: DEMO_PROJECT.id,
  projectVersion: 2,
  statementText: "It needs to handle the load and fit in the same space as the old one.",
  description: "Bracket material was not specified by the user.",
  category: "material",
  interpretationStatus: "ambiguous",
  ambiguityReason: "No material or finish was named in the original statement.",
  priority: "medium",
  source: "agent",
  createdAt: at(2)
});

export const clarifications: Clarification[] = [
  createClarification({
    id: "clar_material",
    projectId: DEMO_PROJECT.id,
    requirementCandidateId: materialCandidate.id,
    candidateSnapshot: materialCandidate,
    question: "What material should the bracket be made from?",
    reason: "No material was specified, and structural/mass targets depend on it.",
    category: "missing_target",
    affectedFields: ["value", "unit"],
    status: "pending",
    source: "agent",
    createdAt: at(2)
  })
];

export const plan: Plan = createPlan({
  id: "plan_bracket",
  projectId: DEMO_PROJECT.id,
  projectVersion: 3,
  observationId: "obs_bracket_01",
  objectiveSummary: "Design a mounting bracket that supports 50 kg within a 12 mm thickness envelope.",
  status: "executing",
  steps: [
    {
      id: "step_geometry",
      title: "Establish base geometry",
      description: "Define the mounting plate and hole pattern within the thickness constraint.",
      purpose: "Satisfy the geometric envelope requirement.",
      relevantRequirementIds: ["req_thickness"],
      status: "in_progress"
    },
    {
      id: "step_material",
      title: "Select material and validate strength",
      description: "Choose a material and confirm the load requirement is met.",
      purpose: "Satisfy the structural load requirement.",
      relevantRequirementIds: ["req_load"],
      status: "pending"
    }
  ],
  source: "agent",
  createdAt: at(5)
});

export const sources: Source[] = [
  createSource({
    id: "src_al6061",
    title: "Aluminum 6061-T6 Mechanical Properties",
    sourceType: "standard",
    publisher: "MatWeb",
    locator: "https://matweb.com/al-6061-t6",
    reliability: "high",
    retrievedAt: at(8)
  })
];

export const evidence: ResearchEvidence[] = [
  createResearchEvidence({
    id: "ev_al6061_yield",
    sourceId: "src_al6061",
    claim: "Aluminum 6061-T6 has a yield strength of approximately 276 MPa, suitable for load-bearing brackets of this size.",
    excerpt: "Typical yield strength (T6 temper): 276 MPa.",
    confidence: "high",
    relevanceNote: "Supports selecting 6061-T6 to satisfy the 50 kg load requirement.",
    retrievedAt: at(8)
  })
];

// ---- Candidate designs -----------------------------------------------

function buildCandidate(id: string, hypothesis: string, rationale: string, offsetMinutes: number): { candidate: Candidate; design: DesignSpecification } {
  const design = createDesignSpecification({
    id: `design_${id}`,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    planId: plan.id,
    planStepId: "step_geometry",
    objectiveSummary: plan.objectiveSummary,
    description: hypothesis,
    components: [{ id: "comp_plate", name: "Mounting Plate", type: "plate", geometryIntent: "Rectangular plate with two mounting holes", dimensions: { length: 90, width: 60, thickness: 8 } }],
    expectedOutputs: [{ id: "out_plate", componentId: "comp_plate", environmentObjectType: "part", environmentGenericType: "solid", properties: {} }],
    createdAt: at(offsetMinutes)
  });
  const candidate = createCandidate({
    id: `cand_${id}`,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    planId: plan.id,
    planStepId: "step_geometry",
    designSpecificationId: design.id,
    hypothesis,
    rationale,
    relevantRequirementIds: ["req_load", "req_thickness"],
    source: "agent",
    createdAt: at(offsetMinutes)
  });
  return { candidate, design };
}

const candidateA = buildCandidate("a", "Solid 8 mm plate, two M6 mounting holes.", "Simplest geometry; maximizes stiffness margin.", 12);
const candidateB = buildCandidate("b", "Ribbed 6 mm plate with a single reinforcing rib.", "Reduces mass while keeping edge clearance and strength within target.", 13);
const candidateC = buildCandidate("c", "Thin 4 mm plate, no ribbing.", "Minimizes mass; expected to fail the strength requirement.", 14);

export const candidates: Candidate[] = [candidateA.candidate, candidateB.candidate, candidateC.candidate];
export const designSpecifications: DesignSpecification[] = [candidateA.design, candidateB.design, candidateC.design];

// ---- Checks + verification results ------------------------------------

export const checks: Check[] = [
  createCheck({ id: "check_clearance_a", kind: "bounds_check", description: "Edge clearance >= 5 mm", objectId: "envobj_a", property: "edgeClearanceMm", min: 5, max: null, unit: "mm" }),
  createCheck({ id: "check_clearance_b", kind: "bounds_check", description: "Edge clearance >= 5 mm", objectId: "envobj_b", property: "edgeClearanceMm", min: 5, max: null, unit: "mm" }),
  createCheck({ id: "check_clearance_c", kind: "bounds_check", description: "Edge clearance >= 5 mm", objectId: "envobj_c", property: "edgeClearanceMm", min: 5, max: null, unit: "mm" }),
  createCheck({ id: "check_strength_c", kind: "bounds_check", description: "Yield margin >= 1.5x", objectId: "envobj_c", property: "yieldMarginRatio", min: 1.5, max: null, unit: "x" })
];

export const verificationResults: VerificationResult[] = [
  createVerificationResult({
    id: "vr_clearance_a",
    checkId: "check_clearance_a",
    checkKind: "bounds_check",
    status: "pass",
    reasonKind: "satisfied",
    message: "Edge clearance 8.2 mm satisfies the 5 mm minimum.",
    expected: { min: 5, max: null, unit: "mm" },
    actual: 8.2,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    evaluatedAt: at(30)
  }),
  createVerificationResult({
    id: "vr_clearance_b",
    checkId: "check_clearance_b",
    checkKind: "bounds_check",
    status: "pass",
    reasonKind: "satisfied",
    message: "Edge clearance 6.1 mm satisfies the 5 mm minimum.",
    expected: { min: 5, max: null, unit: "mm" },
    actual: 6.1,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    evaluatedAt: at(31)
  }),
  createVerificationResult({
    id: "vr_clearance_c",
    checkId: "check_clearance_c",
    checkKind: "bounds_check",
    status: "fail",
    reasonKind: "violated",
    message: "Edge clearance 4.2 mm — below the 5 mm minimum.",
    expected: { min: 5, max: null, unit: "mm" },
    actual: 4.2,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    evaluatedAt: at(32)
  }),
  createVerificationResult({
    id: "vr_strength_c",
    checkId: "check_strength_c",
    checkKind: "bounds_check",
    status: "fail",
    reasonKind: "violated",
    message: "Yield margin 1.1x is below the 1.5x requirement.",
    expected: { min: 1.5, max: null, unit: "x" },
    actual: 1.1,
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    evaluatedAt: at(33)
  })
];

// ---- Experiments --------------------------------------------------------

export const experiments: Experiment[] = [
  createExperiment({
    id: "exp_a",
    objective: plan.objectiveSummary,
    hypothesis: candidateA.candidate.hypothesis,
    candidateId: candidateA.candidate.id,
    verificationResultIds: ["vr_clearance_a"],
    status: "complete",
    conclusion: "Meets all requirements; heaviest of the three candidates.",
    createdAt: at(30)
  }),
  createExperiment({
    id: "exp_b",
    objective: plan.objectiveSummary,
    hypothesis: candidateB.candidate.hypothesis,
    candidateId: candidateB.candidate.id,
    verificationResultIds: ["vr_clearance_b"],
    status: "complete",
    conclusion: "Meets all requirements at lower mass than Candidate A.",
    createdAt: at(31)
  }),
  createExperiment({
    id: "exp_c",
    objective: plan.objectiveSummary,
    hypothesis: candidateC.candidate.hypothesis,
    candidateId: candidateC.candidate.id,
    verificationResultIds: ["vr_clearance_c", "vr_strength_c"],
    status: "failed",
    conclusion: "Fails both edge clearance and strength requirements.",
    createdAt: at(32)
  })
];

export const objectiveSatisfaction: ObjectiveSatisfactionResult = createObjectiveSatisfactionResult({
  id: "objsat_bracket",
  projectId: DEMO_PROJECT.id,
  projectVersion: 4,
  objectiveSummary: plan.objectiveSummary,
  status: "satisfied",
  reason: "Candidate B satisfies every required condition (clearance, strength) with no violated hard constraints.",
  conditions: [
    {
      checkId: "check_clearance_b",
      checkKind: "bounds_check",
      requirementId: "req_load",
      constraintId: "con_clearance",
      required: true,
      verificationResultId: "vr_clearance_b",
      effectiveStatus: "pass",
      reasonKind: "satisfied",
      message: "Edge clearance 6.1 mm satisfies the 5 mm minimum."
    }
  ],
  evaluatedAt: at(34)
});

// ---- Engineering objects (World Model) ---------------------------------
// The CURRENT state the pending proposal below would change -- without
// this, `ProposalCard` would only ever be able to show the "after" side
// of a change (`Proposal.input.value`), never a genuine Before -> After
// diff. `envobj_b` matches `proposal.target.entityId` exactly.

export const objects: EngineeringObject[] = [
  createEngineeringObject({
    id: "envobj_b",
    type: "part",
    name: "Candidate B mounting plate",
    description: "The mounting plate geometry the pending proposal would modify.",
    properties: { holeOffsetMm: 2.4, thicknessMm: 6 }
  })
];

// ---- Proposal (pending approval) ---------------------------------------

export const proposal: Proposal = createProposal({
  id: "prop_offset",
  projectId: DEMO_PROJECT.id,
  projectVersion: 5,
  planId: plan.id,
  planStepId: "step_geometry",
  objectiveSummary: "Increase mounting-hole offset to restore edge clearance margin.",
  toolName: "modify_environment_object",
  toolTarget: "environment",
  input: { objectId: "envobj_b", propertyKey: "holeOffsetMm", value: 5.0 },
  target: { entityType: "object", entityId: "envobj_b" },
  rationale: "Candidate B's mounting hole sits 2.4 mm from the edge, which leaves only a narrow margin above the 5 mm minimum once manufacturing tolerance is included.",
  expectedEffect: "Edge clearance increases from 2.4 mm to approximately 5.0 mm, without changing the plate's outer dimensions.",
  relevantRequirementIds: ["req_thickness"],
  relevantConstraintIds: ["con_clearance"],
  status: "proposed",
  source: "agent",
  createdAt: at(40)
});

// ---- Memory ---------------------------------------------------------------

export const decisions: Decision[] = [
  createDecision({
    id: "dec_candidate_b",
    statement: "Select Candidate B (ribbed 6 mm plate) as the baseline design.",
    reason: "Only candidate meeting every requirement at the lowest mass; Candidate C fails strength and clearance.",
    source: "agent",
    createdAt: at(35)
  })
];

export const memoryRecords: MemoryRecord[] = [
  createMemoryRecord({
    id: "mem_edge_clearance",
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    kind: "decision",
    title: "Prefer 5 mm minimum edge clearance",
    content: "A previous prototype with 3 mm edge clearance failed vibration testing at the mounting holes. Treat 5 mm as the practical minimum, not just the nominal constraint value.",
    provenanceKind: "user_statement",
    references: { requirementIds: ["req_thickness"], constraintIds: ["con_clearance"] },
    createdAt: at(1)
  }),
  createMemoryRecord({
    id: "mem_material_pref",
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    kind: "preference",
    title: "Prefer aluminum 6061-T6 for load-bearing brackets of this class",
    content: "Consistently satisfies strength requirements in the 20–75 kg static load range while remaining easy to machine.",
    provenanceKind: "verification_result",
    references: { verificationResultIds: ["vr_clearance_b"] },
    createdAt: at(36)
  }),
  createMemoryRecord({
    id: "mem_candidate_b_selected",
    projectId: DEMO_PROJECT.id,
    projectVersion: 4,
    kind: "decision",
    title: "Candidate B selected for the mounting bracket",
    content: "Candidate B was selected because it was the only feasible candidate on the Pareto frontier for the mass/strength tradeoff.",
    provenanceKind: "experiment_result",
    references: { decisionIds: ["dec_candidate_b"], candidateIds: [candidateB.candidate.id, candidateC.candidate.id], experimentIds: ["exp_b", "exp_c"] },
    createdAt: at(37)
  })
];

// ---- Background job (running) -----------------------------------------

export const backgroundJob: BackgroundJob = createBackgroundJob({
  id: "job_sweep",
  projectId: DEMO_PROJECT.id,
  projectVersion: 5,
  status: "running",
  objective: "Sweep rib thickness across 20 candidates to further reduce mass.",
  candidateIds: candidates.map((c) => c.id),
  autonomyLevel: "approved_modify",
  allowedTools: ["create_checkpoint", "add_experiment", "update_experiment", "modify_environment_object"],
  budget: { maxIterations: 20, maxDurationMs: 600_000, maxToolCalls: 400, maxModelCalls: 40, maxCandidates: 20 },
  consumption: { iterationsUsed: 7, durationMsUsed: 214_000, toolCallsUsed: 132, modelCallsUsed: 14, candidatesEvaluated: 7 },
  source: "agent",
  createdAt: at(50),
  startedAt: at(50)
});

export const jobEvents: JobEvent[] = [
  createJobEvent({ id: "jev_1", jobId: backgroundJob.id, projectId: DEMO_PROJECT.id, kind: "candidate_completed", message: 'Candidate 6 verification passed.', createdAt: at(58) }),
  createJobEvent({ id: "jev_2", jobId: backgroundJob.id, projectId: DEMO_PROJECT.id, kind: "candidate_completed", message: "Candidate 5 verification failed (strength margin 1.2x).", createdAt: at(55) }),
  createJobEvent({ id: "jev_3", jobId: backgroundJob.id, projectId: DEMO_PROJECT.id, kind: "candidate_completed", message: "Candidate 4 dominated by candidate 2 on mass and strength.", createdAt: at(52) }),
  createJobEvent({ id: "jev_4", jobId: backgroundJob.id, projectId: DEMO_PROJECT.id, kind: "candidate_started", message: "Starting candidate 7.", createdAt: at(60) })
];
