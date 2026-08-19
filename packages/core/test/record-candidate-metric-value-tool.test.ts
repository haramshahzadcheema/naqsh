import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCandidate, createWorldModelState, type CandidateInput, type CandidateMetricValue, type VerificationResult, type WorldModelState } from "@naqsh/schemas";
import { createRecordCandidateMetricValueTool } from "../src/record-candidate-metric-value-tool.js";
import { createCandidateStore } from "../src/candidate-store.js";
import { createVerificationResultStore } from "../src/verification-result-store.js";
import { createCandidateMetricValueStore } from "../src/optimization-metric-store.js";
import { executeTool } from "../src/execute-tool.js";
import { createToolRegistry } from "../src/tool-registry.js";

function candidateInput(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return { projectId: "proj_1", projectVersion: 1, planId: "plan_1", planStepId: "step_1", hypothesis: "h", rationale: "r", ...overrides };
}

function fakeVerificationResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: "vr_1",
    checkId: "check_1",
    checkKind: "numeric_comparison",
    status: "pass",
    reasonKind: "satisfied",
    message: "ok",
    expected: { operator: "lte", value: 10 },
    actual: 9.4,
    evidence: null,
    projectId: "proj_1",
    projectVersion: 1,
    environmentKind: null,
    documentName: null,
    evaluatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides
  };
}

function buildHarness() {
  const candidateStore = createCandidateStore();
  const verificationResultStore = createVerificationResultStore();
  const metricValueStore = createCandidateMetricValueStore();
  let state: WorldModelState = createWorldModelState({ project: { id: "proj_1", name: "Bracket Study" }, session: {} });
  const registry = createToolRegistry();
  const { tool, handler } = createRecordCandidateMetricValueTool(candidateStore, verificationResultStore, () => state, metricValueStore);
  registry.register(tool, handler);
  return {
    registry,
    candidateStore,
    verificationResultStore,
    metricValueStore,
    getState: () => state,
    setState: (next: WorldModelState) => {
      state = next;
    }
  };
}

describe("createRecordCandidateMetricValueTool: identity and classification", () => {
  it("is classified suggest/optimization", () => {
    const { registry } = buildHarness();
    const tool = registry.getByName("record_candidate_metric_value")!;
    assert.equal(tool.mutation, "suggest");
    assert.equal(tool.target, "optimization");
  });
});

describe("createRecordCandidateMetricValueTool: measured (verification_result) -- the critical integrity gate", () => {
  it("derives value/unit/status from the real VerificationResult, ignoring any caller-supplied value/unit", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    harness.verificationResultStore.save(
      fakeVerificationResult({
        id: "vr_1",
        actual: 9.4,
        evidence: {
          id: "evidence_1",
          objectId: null,
          objectExists: null,
          observedGenericType: null,
          property: null,
          propertyExists: null,
          observedValue: 9.4,
          unit: "kg",
          observationId: null,
          stateVersion: 1,
          environmentKind: null,
          observedAt: new Date().toISOString(),
          source: "system",
          metadata: {}
        }
      })
    );

    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "verification_result", verificationResultId: "vr_1", value: 999999, unit: "lb" }
    });
    assert.equal(result.status, "success");
    const metricValue = (result.output as { metricValue: CandidateMetricValue }).metricValue;
    assert.equal(metricValue.status, "measured");
    assert.equal(metricValue.value, 9.4, "the DERIVED value from the real VerificationResult, never the caller-supplied 999999");
    assert.notEqual(metricValue.value, 999999);
  });

  it("REGRESSION: rejects a claimed 'measured' value backed by an INCONCLUSIVE VerificationResult", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    harness.verificationResultStore.save(fakeVerificationResult({ id: "vr_1", status: "inconclusive", reasonKind: "evidence_missing", actual: null }));

    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "verification_result", verificationResultId: "vr_1" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /verification_result_inconclusive/);
  });

  it("AUDIT FIX REGRESSION: rejects a VerificationResult that belongs to a DIFFERENT project than the candidate -- VerificationResultStore is not itself project-scoped, so this cross-check is the only thing preventing a 'measured' claim from being backed by a real-looking result from an unrelated project", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput({ projectId: "proj_1" }));
    harness.candidateStore.save(candidate);
    harness.verificationResultStore.save(fakeVerificationResult({ id: "vr_1", projectId: "proj_OTHER", actual: 9.4 }));

    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "verification_result", verificationResultId: "vr_1" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /verification_result_wrong_project/);
  });

  it("rejects a verificationResultId that does not exist -- a model cannot fabricate a measured claim by pointing at a nonexistent result", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "verification_result", verificationResultId: "vr_does_not_exist" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /verification_result_not_found/);
  });

  it("rejects a VerificationResult whose actual value is not numeric", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    harness.verificationResultStore.save(fakeVerificationResult({ id: "vr_1", actual: "not-a-number" }));
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "verification_result", verificationResultId: "vr_1" }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /verification_result_not_numeric/);
  });
});

describe("createRecordCandidateMetricValueTool: estimated (declared)", () => {
  it("accepts a declared estimate, recorded honestly as 'estimated', never 'measured'", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "cost", provenanceKind: "declared", value: 500 }
    });
    assert.equal(result.status, "success");
    const metricValue = (result.output as { metricValue: CandidateMetricValue }).metricValue;
    assert.equal(metricValue.status, "estimated");
    assert.equal(metricValue.value, 500);
  });

  it("REGRESSION: the brief's own example -- 'Estimated cost is $500' never becomes 'Verified cost = $500'", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "cost", provenanceKind: "declared", status: "measured", value: 500 }
    });
    assert.equal(result.status, "error", "a caller cannot force status:'measured' onto a declared estimate");
  });

  it("records status 'unavailable' with a null value when explicitly declared unavailable", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "cost", provenanceKind: "declared", status: "unavailable" }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { metricValue: CandidateMetricValue }).metricValue.value, null);
  });
});

describe("createRecordCandidateMetricValueTool: estimated (research_evidence)", () => {
  it("accepts a research-sourced estimate once the ResearchEvidence resolves in the current project", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    harness.setState(
      createWorldModelState({
        project: {
          id: "proj_1",
          name: "Bracket Study",
          sources: [{ id: "src_1", title: "Datasheet", locator: null, publisher: null, sourceType: "documentation", reliability: "medium", retrievedAt: new Date().toISOString(), publishedAt: null, contentHash: null, status: "active", source: "research", createdAt: new Date().toISOString(), metadata: {} } as never],
          researchEvidence: [{ id: "evid_1", sourceId: "src_1", claim: "Aluminum costs ~$500/unit", excerpt: null, confidence: "medium", relevanceNote: null, retrievedAt: new Date().toISOString(), status: "active", source: "research", createdAt: new Date().toISOString(), metadata: {} } as never]
        },
        session: {}
      })
    );
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "cost", provenanceKind: "research_evidence", researchEvidenceId: "evid_1", value: 500 }
    });
    assert.equal(result.status, "success");
    assert.equal((result.output as { metricValue: CandidateMetricValue }).metricValue.status, "estimated");
  });

  it("rejects a researchEvidenceId that does not exist in the current project", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "cost", provenanceKind: "research_evidence", researchEvidenceId: "evid_missing", value: 500 }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /research_evidence_not_found/);
  });
});

describe("createRecordCandidateMetricValueTool: validation", () => {
  it("rejects a candidateId that does not exist", async () => {
    const { registry } = buildHarness();
    const { result } = await executeTool(registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: "cand_missing", metricKey: "mass", provenanceKind: "declared", value: 5 }
    });
    assert.equal(result.status, "error");
    assert.match(result.error!.message, /candidate_not_found/);
  });

  it("rejects a missing metricKey", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, provenanceKind: "declared", value: 5 }
    });
    assert.equal(result.status, "error");
  });

  it("rejects an invalid provenanceKind", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const { result } = await executeTool(harness.registry, {
      toolName: "record_candidate_metric_value",
      input: { candidateId: candidate.id, metricKey: "mass", provenanceKind: "not_a_real_kind", value: 5 }
    });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "invalid_input");
  });

  it("two metric values recorded for the same (candidate, metricKey) get distinct ids -- append-only, never deduplicated", async () => {
    const harness = buildHarness();
    const candidate = createCandidate(candidateInput());
    harness.candidateStore.save(candidate);
    const input = { candidateId: candidate.id, metricKey: "mass", provenanceKind: "declared", value: 5 };
    const { result: r1 } = await executeTool(harness.registry, { toolName: "record_candidate_metric_value", input });
    const { result: r2 } = await executeTool(harness.registry, { toolName: "record_candidate_metric_value", input });
    const m1 = (r1.output as { metricValue: CandidateMetricValue }).metricValue;
    const m2 = (r2.output as { metricValue: CandidateMetricValue }).metricValue;
    assert.notEqual(m1.id, m2.id);
    assert.equal(harness.metricValueStore.listForCandidate(candidate.id).length, 2);
  });
});
