import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createDecision, createEvidence, createExperiment, createWorldModelState, type WorldModelState } from "@naqsh/schemas";
import { createCheck } from "@naqsh/schemas";
import { evaluateCheck } from "../src/verify.js";
import { updateWorldModel } from "../src/transitions.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createCandidateMetricValueStore } from "../src/optimization-metric-store.js";
import { createOptimizationProblemStore } from "../src/optimization-problem-store.js";
import { createOptimizationResultStore } from "../src/optimization-result-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { computeOptimizationResult } from "../src/optimization-engine.js";
import { createMemoryStore } from "../src/memory-store.js";
import { createMemoryAddTool } from "../src/memory-add-tool.js";
import { createMemoryGetTool } from "../src/memory-get-tool.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";
import { createCandidateMetricValue, createOptimizationProblem, type Candidate, type MemoryRecord, type OptimizationResult } from "@naqsh/schemas";

/**
 * PHASE 24 END-TO-END: the brief's own realistic scenario.
 *
 *   Project P1, Requirement "minimize mass while maintaining strength"
 *     -> Candidate A (mass=8, strength=120), Candidate B (mass=10, strength=150)
 *     -> Experiment E1 (Candidate A fails strength verification)
 *     -> Experiment E2 (Candidate B satisfies verification)
 *     -> Optimization: B is the (only feasible) Pareto-optimal candidate
 *     -> Decision D1: choose B
 *     -> MemoryRecord grounded in ALL of the above
 *
 * Every fact the memory cites is produced by REAL, existing phase machinery
 * (P16's `evaluateCheck`, P23's `computeOptimizationResult`) -- never
 * fabricated JSON standing in for what those systems would have computed.
 * The test then proves the memory can answer "why was B selected?" by
 * WALKING ITS OWN REFERENCES back to those real records, and that the
 * memory remains fully valid and unchanged after the project's own state
 * moves on.
 */
describe("P24 end-to-end: mass/strength/Pareto/decision scenario", () => {
  it("produces a durable memory that answers 'why was Candidate B selected?' using only real, cross-checkable evidence, and remains valid after the project state changes", async () => {
    let state: WorldModelState = createWorldModelState({
      project: {
        id: "proj_bracket",
        name: "Mounting Bracket",
        requirements: [{ id: "req_mass_strength", description: "Minimize mass while maintaining strength.", category: "structural", priority: "high" }]
      },
      session: {}
    });

    const candidateStore = createCandidateStore();
    const metricStore = createCandidateMetricValueStore();
    const problemStore = createOptimizationProblemStore();
    const resultStore = createOptimizationResultStore();
    const verificationResultStore = createVerificationResultStore();
    const memoryStore = createMemoryStore();

    // ---- Candidates -------------------------------------------------
    const candidateA: Candidate = createCandidate({
      projectId: state.project.id,
      projectVersion: state.project.version,
      planId: "plan_bracket",
      relevantRequirementIds: [state.project.requirements[0]!.id],
      hypothesis: "A thin ribbed bracket meets the mass target.",
      rationale: "Ribbing was expected to preserve strength at lower mass."
    });
    const candidateB: Candidate = createCandidate({
      projectId: state.project.id,
      projectVersion: state.project.version,
      planId: "plan_bracket",
      relevantRequirementIds: [state.project.requirements[0]!.id],
      hypothesis: "A thicker solid bracket reliably meets the strength requirement.",
      rationale: "A solid cross-section trades some mass for strength margin."
    });
    candidateStore.save(candidateA);
    candidateStore.save(candidateB);

    // ---- Verification: strength check, evaluated against each candidate's build ----
    const strengthCheck = createCheck({
      kind: "bounds_check",
      description: "Bracket strength must be at least 130 N to satisfy the load requirement.",
      objectId: "envobj_bracket",
      property: "strength",
      min: 130,
      max: null,
      unit: "N"
    });

    const evidenceA = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "strength", propertyExists: true, observedValue: 120, unit: "N", stateVersion: state.project.version, source: "system" });
    const verificationA = evaluateCheck(strengthCheck, evidenceA, { projectId: state.project.id, projectVersion: state.project.version });
    assert.equal(verificationA.status, "fail");

    const evidenceB = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "strength", propertyExists: true, observedValue: 150, unit: "N", stateVersion: state.project.version, source: "system" });
    const verificationB = evaluateCheck(strengthCheck, evidenceB, { projectId: state.project.id, projectVersion: state.project.version });
    assert.equal(verificationB.status, "pass");

    // A second check for mass, so both metrics are REAL, verification-backed measurements.
    const massCheck = createCheck({ kind: "numeric_comparison", description: "Record the bracket's mass.", objectId: "envobj_bracket", property: "mass", operator: "eq", expectedValue: 8, tolerance: 0.01 });
    const massEvidenceA = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "mass", propertyExists: true, observedValue: 8, unit: "kg", stateVersion: state.project.version, source: "system" });
    const massVerificationA = evaluateCheck(massCheck, massEvidenceA, { projectId: state.project.id, projectVersion: state.project.version });
    const massCheckB = createCheck({ kind: "numeric_comparison", description: "Record the bracket's mass.", objectId: "envobj_bracket", property: "mass", operator: "eq", expectedValue: 10, tolerance: 0.01 });
    const massEvidenceB = createEvidence({ objectId: "envobj_bracket", objectExists: true, property: "mass", propertyExists: true, observedValue: 10, unit: "kg", stateVersion: state.project.version, source: "system" });
    const massVerificationB = evaluateCheck(massCheckB, massEvidenceB, { projectId: state.project.id, projectVersion: state.project.version });

    // Every VerificationResult is persisted to a REAL store, so a memory
    // that later cites one of these ids gets genuinely cross-checked by
    // validateMemoryRecordSemantics (below) -- not merely shape-validated.
    for (const verification of [verificationA, verificationB, massVerificationA, massVerificationB]) {
      verificationResultStore.save(verification);
    }

    // ---- Experiments --------------------------------------------------
    const experimentA = createExperiment({
      objective: "Test Candidate A against the strength requirement.",
      hypothesis: candidateA.hypothesis,
      candidateId: candidateA.id,
      verificationResultIds: [verificationA.id, massVerificationA.id],
      status: "failed",
      conclusion: "Candidate A failed the strength requirement (120 N < 130 N minimum)."
    });
    const experimentB = createExperiment({
      objective: "Test Candidate B against the strength requirement.",
      hypothesis: candidateB.hypothesis,
      candidateId: candidateB.id,
      verificationResultIds: [verificationB.id, massVerificationB.id],
      status: "complete",
      conclusion: "Candidate B satisfied the strength requirement (150 N >= 130 N minimum)."
    });
    state = updateWorldModel(state, { kind: "add_experiment", experiment: experimentA });
    state = updateWorldModel(state, { kind: "add_experiment", experiment: experimentB });
    assert.equal(state.project.experiments.length, 2);

    // ---- Candidate metric values (grounded in the REAL VerificationResults) ----
    metricStore.save(createCandidateMetricValue({ candidateId: candidateA.id, metricKey: "mass", status: "measured", provenanceKind: "verification_result", verificationResultId: massVerificationA.id, value: 8 }));
    metricStore.save(createCandidateMetricValue({ candidateId: candidateA.id, metricKey: "strength", status: "measured", provenanceKind: "verification_result", verificationResultId: verificationA.id, value: 120 }));
    metricStore.save(createCandidateMetricValue({ candidateId: candidateB.id, metricKey: "mass", status: "measured", provenanceKind: "verification_result", verificationResultId: massVerificationB.id, value: 10 }));
    metricStore.save(createCandidateMetricValue({ candidateId: candidateB.id, metricKey: "strength", status: "measured", provenanceKind: "verification_result", verificationResultId: verificationB.id, value: 150 }));

    // ---- Optimization: A is infeasible, B is the only Pareto-optimal candidate ----
    const problem = createOptimizationProblem({
      projectId: state.project.id,
      projectVersion: state.project.version,
      candidateIds: [candidateA.id, candidateB.id],
      objectives: [
        { metricKey: "mass", description: "Minimize mass.", direction: "minimize" },
        { metricKey: "strength", description: "Maximize strength.", direction: "maximize" }
      ],
      constraints: [{ metricKey: "strength", description: "Strength must be at least 130 N.", operator: "gte", threshold: 130 }]
    });
    problemStore.save(problem);
    const optimizationResult: OptimizationResult = computeOptimizationResult(problem, metricStore);
    resultStore.save(optimizationResult);

    assert.deepEqual(optimizationResult.infeasibleCandidateIds, [candidateA.id]);
    assert.deepEqual(optimizationResult.paretoOptimalCandidateIds, [candidateB.id]);

    // ---- Decision: choose B -------------------------------------------
    const decision = createDecision({
      statement: "Select Candidate B for the mounting bracket.",
      reason: "Candidate B was the only feasible candidate: it satisfied the strength requirement (150 N) while Candidate A failed it (120 N < 130 N)."
    });
    state = updateWorldModel(state, { kind: "add_decision", decision });
    assert.equal(state.project.decisions.length, 1);

    // ---- Memory: record WHY B was selected, grounded in real ids only ----
    const memoryRegistry = createToolRegistry();
    const { tool: addTool, handler: addHandler } = createMemoryAddTool(memoryStore, () => state, {
      candidateStore,
      optimizationResultStore: resultStore,
      verificationResultStore
    });
    const { tool: getTool, handler: getHandler } = createMemoryGetTool(memoryStore, () => state);
    memoryRegistry.register(addTool, addHandler);
    memoryRegistry.register(getTool, getHandler);

    // AUDIT FIX: prove the verificationResultStore wiring above is genuinely
    // ACTIVE, not merely passed through unused -- a memory claiming
    // "verification_result" grounding via a FABRICATED id must be rejected,
    // exactly like the real citations below must be accepted.
    const { result: fabricatedResult } = await executeTool(memoryRegistry, {
      toolName: "memory_add",
      input: {
        kind: "verification_finding",
        title: "Fabricated verification claim",
        content: "This claims a verification result that was never actually produced.",
        provenanceKind: "verification_result",
        references: { verificationResultIds: ["verifresult_never_ran"] }
      }
    });
    assert.equal(fabricatedResult.status, "error");
    assert.match(fabricatedResult.error!.message, /unknown_verification_result_reference/);

    const { result: addResult } = await executeTool(memoryRegistry, {
      toolName: "memory_add",
      input: {
        kind: "decision",
        title: "Candidate B selected for the mounting bracket",
        content:
          "Candidate B was selected because it was the only feasible candidate on the Pareto frontier for the mass/strength tradeoff: Candidate A failed the strength verification (120 N < 130 N), while Candidate B passed it (150 N) at a modest mass cost (10 kg vs 8 kg).",
        provenanceKind: "optimization_result",
        references: {
          decisionIds: [decision.id],
          candidateIds: [candidateA.id, candidateB.id],
          experimentIds: [experimentA.id, experimentB.id],
          verificationResultIds: [verificationA.id, verificationB.id, massVerificationA.id, massVerificationB.id],
          optimizationResultIds: [optimizationResult.id],
          requirementIds: [state.project.requirements[0]!.id]
        }
      }
    });
    assert.equal(addResult.status, "success");
    const memory = (addResult.output as { memory: MemoryRecord }).memory;

    // ---- Verify the memory can answer "why was B selected?" by walking
    // its OWN references back to real, independently-verifiable records --
    // never a standalone explanation disconnected from evidence. ----
    assert.equal(memory.references.decisionIds[0], decision.id);
    assert.equal(memory.references.optimizationResultIds[0], optimizationResult.id);

    const citedOptimizationResult = resultStore.getById(memory.references.optimizationResultIds[0]!)!;
    assert.deepEqual(citedOptimizationResult.paretoOptimalCandidateIds, [candidateB.id]);
    assert.deepEqual(citedOptimizationResult.infeasibleCandidateIds, [candidateA.id]);

    const citedVerificationA = memory.references.verificationResultIds.map((id) => (id === verificationA.id ? verificationA : null)).find(Boolean);
    assert.equal(citedVerificationA!.status, "fail");
    const citedVerificationB = memory.references.verificationResultIds.map((id) => (id === verificationB.id ? verificationB : null)).find(Boolean);
    assert.equal(citedVerificationB!.status, "pass");

    const citedDecision = state.project.decisions.find((entry) => entry.id === memory.references.decisionIds[0]);
    assert.equal(citedDecision!.statement, "Select Candidate B for the mounting bracket.");

    // memory_get's own related-memory walk works from this record too.
    const { result: getResult } = await executeTool(memoryRegistry, { toolName: "memory_get", input: { memoryId: memory.id } });
    assert.equal(getResult.status, "success");
    assert.equal((getResult.output as { memory: MemoryRecord }).memory.id, memory.id);

    // ---- Change the current project state -----------------------------
    const projectBeforeExtraRequirement = state.project;
    const versionBeforeChange = state.project.version;
    state = updateWorldModel(state, {
      kind: "add_requirement",
      requirement: { description: "The bracket must also tolerate -20C operating temperature.", category: "environmental", priority: "medium" }
    });
    assert.ok(state.project.version > versionBeforeChange);
    assert.equal(state.project.requirements.length, 2);

    // AUDIT FIX (Section 18): a checkpoint RESTORE (P15) works, at the
    // World Model reducer level, by applying a `restore_project`
    // transition -- the exact mechanism `restore_checkpoint`'s tool uses
    // under the hood. Prove that rolling the project back to its
    // pre-change content does NOT touch MemoryStore at all: memory lives
    // in a completely separate store `restore_project` has no reference
    // to, so a checkpoint restore can never silently erase historical
    // memory, by construction.
    state = updateWorldModel(state, { kind: "restore_project", project: projectBeforeExtraRequirement });
    assert.equal(state.project.requirements.length, 1);
    assert.deepEqual(memoryStore.getById(memory.id), memory);
    assert.ok(resultStore.getById(optimizationResult.id));

    // ---- The historical memory remains fully valid and unchanged ------
    const memoryAfterStateChange = memoryStore.getById(memory.id);
    assert.deepEqual(memoryAfterStateChange, memory);
    assert.equal(memoryAfterStateChange!.status, "active");
    assert.equal(memoryAfterStateChange!.content, memory.content);

    // The referenced records remain independently retrievable, unaffected
    // by the project state change -- none of them live in WorldModelState.
    assert.ok(candidateStore.getById(candidateA.id));
    assert.ok(candidateStore.getById(candidateB.id));
    assert.ok(resultStore.getById(optimizationResult.id));
    assert.deepEqual(resultStore.getById(optimizationResult.id)!.paretoOptimalCandidateIds, [candidateB.id]);
  });
});
