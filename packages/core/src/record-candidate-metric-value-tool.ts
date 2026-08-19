import {
  createCandidateMetricValue,
  ENTITY_SOURCES,
  METRIC_VALUE_PROVENANCE_KINDS,
  ToolError,
  WorldModelValidationError,
  createTool,
  type CandidateMetricValueInput,
  type EntitySource,
  type MetricValueProvenanceKind,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { CandidateStore } from "./candidate-store.js";
import type { CandidateMetricValueStore } from "./optimization-metric-store.js";
import type { VerificationResultStore } from "./verification-result-store.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 23's METRIC-RECORDING tool -- the one place a `CandidateMetricValue`
 * ever gets created, and therefore the ONE place the brief's central rule
 * ("NAQSH may optimize based on VERIFIED/MEASURED engineering results, it
 * must NOT optimize based on arbitrary LLM opinions") is actually enforced
 * against a live store, not merely a shape rule. `assertCandidateMetricValue`
 * (schemas) already guarantees status/provenanceKind/value are internally
 * consistent -- what it CANNOT check (it has no store to consult) is
 * whether a claimed `verificationResultId`/`researchEvidenceId` is REAL.
 * This tool closes that gap, mirroring `create-check-tool.ts`'s (P16)
 * `requirement_not_found` cross-check precedent exactly:
 *
 *   - `provenanceKind: "verification_result"` -- `verificationResultId`
 *     MUST resolve to a real `VerificationResult` (P16) whose OWN `status`
 *     is `"pass"` or `"fail"` (never `"inconclusive"` -- an inconclusive
 *     verification cannot honestly back a "measured" claim), AND whose
 *     `projectId` matches the CANDIDATE's own project -- `VerificationResultStore`
 *     is not itself project-scoped (the exact same fact
 *     `ObjectiveSatisfactionResult`'s (P17) own `verification_result_wrong_project`
 *     check already exists to guard against; AUDIT FIX: an earlier version
 *     of this file carried over P16's `inconclusive` rejection but not
 *     P17's already-established sibling check for the identical
 *     not-project-scoped store, which meant a "measured" metric could be
 *     backed by a real-looking result belonging to a COMPLETELY DIFFERENT
 *     project). The metric's
 *     `value`/`unit` are DERIVED directly from that `VerificationResult`'s
 *     own `actual`/`evidence.unit` -- a caller-supplied `value` for this
 *     provenanceKind is IGNORED, never trusted, so a "measured" claim is
 *     structurally impossible to fabricate: the number comes FROM the real
 *     verification result, never from an unverified assertion merely
 *     POINTING at one.
 *   - `provenanceKind: "research_evidence"` -- `researchEvidenceId` MUST
 *     resolve to a real `ResearchEvidence` (P21) in the CURRENT project.
 *     Unlike verification, research evidence carries no single authoritative
 *     number of its own (a `ResearchEvidence.claim` is prose, not a typed
 *     measurement) -- the caller-supplied `value` IS what's recorded, but
 *     `status` can only ever be `"estimated"`, never `"measured"` (enforced
 *     at the schema layer already; re-affirmed here for defense in depth).
 *   - `provenanceKind: "declared"` -- no reference required; a plain
 *     human/agent-declared estimate, the brief's own "Estimated cost is
 *     $500" example, always `status: "estimated"` or `"unavailable"`.
 *
 * Classified `mutation: "suggest"` -- `CandidateMetricValue` lives in its
 * own store (`CandidateMetricValueStore`), never `WorldModelState`, the
 * same classification `create_check`/`create_candidate` use for the
 * identical reason.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    candidateId: { type: "string", description: "The Candidate this metric describes." },
    metricKey: { type: "string", description: "Which measurable quantity this is, e.g. 'mass', 'cost'." },
    status: { type: "string", enum: ["measured", "estimated", "unavailable"], nullable: true, description: "Defaults based on provenanceKind/value when omitted." },
    value: { type: "number", nullable: true, description: "Ignored (and derived instead) when provenanceKind is 'verification_result'." },
    unit: { type: "string", nullable: true, description: "Ignored (and derived instead) when provenanceKind is 'verification_result'." },
    provenanceKind: { type: "string", enum: METRIC_VALUE_PROVENANCE_KINDS as string[] },
    verificationResultId: { type: "string", nullable: true },
    researchEvidenceId: { type: "string", nullable: true },
    experimentId: { type: "string", nullable: true },
    provenance: { type: "string", nullable: true, description: "Who/what is recording this metric -- one of EntitySource. Defaults to 'agent'." }
  },
  required: ["candidateId", "metricKey", "provenanceKind"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: { metricValue: { type: "object", properties: {}, additionalProperties: true } },
  required: ["metricValue"]
};

interface RecordCandidateMetricValueToolInput {
  candidateId: string;
  metricKey: string;
  status: "measured" | "estimated" | "unavailable" | null;
  value: number | null;
  unit: string | null;
  provenanceKind: MetricValueProvenanceKind;
  verificationResultId: string | null;
  researchEvidenceId: string | null;
  experimentId: string | null;
  provenance: EntitySource | null;
}

function toRecordCandidateMetricValueToolInput(rawInput: unknown): RecordCandidateMetricValueToolInput {
  const record = rawInput as {
    candidateId?: unknown;
    metricKey?: unknown;
    status?: unknown;
    value?: unknown;
    unit?: unknown;
    provenanceKind?: unknown;
    verificationResultId?: unknown;
    researchEvidenceId?: unknown;
    experimentId?: unknown;
    provenance?: unknown;
  };
  if (typeof record.candidateId !== "string" || record.candidateId.trim().length === 0) {
    throw new ToolError("invalid_input", "candidateId is required and must be a non-empty string");
  }
  if (typeof record.metricKey !== "string" || record.metricKey.trim().length === 0) {
    throw new ToolError("invalid_input", "metricKey is required and must be a non-empty string");
  }
  if (!(METRIC_VALUE_PROVENANCE_KINDS as readonly string[]).includes(record.provenanceKind as string)) {
    throw new ToolError("invalid_input", `provenanceKind is required and must be one of: ${METRIC_VALUE_PROVENANCE_KINDS.join(", ")}`);
  }
  if (record.status !== undefined && record.status !== null && !["measured", "estimated", "unavailable"].includes(record.status as string)) {
    throw new ToolError("invalid_input", "status must be one of: measured, estimated, unavailable");
  }
  if (record.provenance !== undefined && record.provenance !== null && !(ENTITY_SOURCES as readonly string[]).includes(record.provenance as string)) {
    throw new ToolError("invalid_input", `provenance must be one of: ${ENTITY_SOURCES.join(", ")}`);
  }

  return {
    candidateId: record.candidateId,
    metricKey: record.metricKey,
    status: typeof record.status === "string" ? (record.status as "measured" | "estimated" | "unavailable") : null,
    value: typeof record.value === "number" ? record.value : null,
    unit: typeof record.unit === "string" ? record.unit : null,
    provenanceKind: record.provenanceKind as MetricValueProvenanceKind,
    verificationResultId: typeof record.verificationResultId === "string" ? record.verificationResultId : null,
    researchEvidenceId: typeof record.researchEvidenceId === "string" ? record.researchEvidenceId : null,
    experimentId: typeof record.experimentId === "string" ? record.experimentId : null,
    provenance: typeof record.provenance === "string" ? (record.provenance as EntitySource) : null
  };
}

export function createRecordCandidateMetricValueTool(
  candidateStore: CandidateStore,
  verificationResultStore: VerificationResultStore,
  getState: () => WorldModelState,
  metricValueStore: CandidateMetricValueStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "record_candidate_metric_value",
    description:
      "Records a single measurable value for a Candidate on one metric (e.g. mass, cost). A 'measured' claim is only ever accepted when it is DERIVED from a real, non-inconclusive VerificationResult -- never trusted as a bare caller-supplied number. An 'estimated' claim (declared or research-sourced) is always recorded as an estimate, never as authoritative fact.",
    target: "optimization",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = (rawInput) => {
    const input = toRecordCandidateMetricValueToolInput(rawInput);

    const candidate = candidateStore.getById(input.candidateId);
    if (!candidate) {
      throw new ToolError("invalid_input", `candidate_not_found: no candidate "${input.candidateId}" exists`);
    }

    let value = input.value;
    let unit = input.unit;
    let status = input.status;

    if (input.provenanceKind === "verification_result") {
      if (input.verificationResultId === null) {
        throw new ToolError("invalid_input", 'verificationResultId is required when provenanceKind is "verification_result"');
      }
      const verificationResult = verificationResultStore.getById(input.verificationResultId);
      if (!verificationResult) {
        throw new ToolError("invalid_input", `verification_result_not_found: no VerificationResult "${input.verificationResultId}" exists`);
      }
      if (verificationResult.status === "inconclusive") {
        throw new ToolError(
          "invalid_input",
          `verification_result_inconclusive: VerificationResult "${input.verificationResultId}" is inconclusive and cannot back a "measured" metric value`
        );
      }
      if (verificationResult.projectId !== candidate.projectId) {
        throw new ToolError(
          "invalid_input",
          `verification_result_wrong_project: VerificationResult "${input.verificationResultId}" belongs to project "${verificationResult.projectId}", not candidate "${candidate.id}"'s project "${candidate.projectId}"`
        );
      }
      if (typeof verificationResult.actual !== "number" || !Number.isFinite(verificationResult.actual)) {
        throw new ToolError(
          "invalid_input",
          `verification_result_not_numeric: VerificationResult "${input.verificationResultId}"'s actual value is not a finite number and cannot back a numeric metric`
        );
      }
      // DERIVED, not trusted from caller input -- see this file's own top doc comment.
      value = verificationResult.actual;
      unit = verificationResult.evidence?.unit ?? null;
      status = "measured";
    } else if (input.provenanceKind === "research_evidence") {
      if (input.researchEvidenceId === null) {
        throw new ToolError("invalid_input", 'researchEvidenceId is required when provenanceKind is "research_evidence"');
      }
      const state = getState();
      if (!state.project.researchEvidence.some((evidence) => evidence.id === input.researchEvidenceId)) {
        throw new ToolError("invalid_input", `research_evidence_not_found: no ResearchEvidence "${input.researchEvidenceId}" exists in the current project`);
      }
      status = status ?? "estimated";
      if (status === "measured") {
        throw new ToolError("invalid_input", 'research-sourced metrics can never be recorded with status "measured" -- only "estimated" or "unavailable"');
      }
    } else {
      status = status ?? (value === null ? "unavailable" : "estimated");
      if (status === "measured") {
        throw new ToolError("invalid_input", 'a "declared" metric can never be recorded with status "measured" -- only "estimated" or "unavailable"');
      }
    }

    const metricValueInput: CandidateMetricValueInput = {
      candidateId: input.candidateId,
      metricKey: input.metricKey,
      status,
      value,
      unit,
      provenanceKind: input.provenanceKind,
      verificationResultId: input.provenanceKind === "verification_result" ? input.verificationResultId : null,
      researchEvidenceId: input.provenanceKind === "research_evidence" ? input.researchEvidenceId : null,
      experimentId: input.experimentId,
      source: input.provenance ?? "agent"
    };

    let metricValue;
    try {
      metricValue = createCandidateMetricValue(metricValueInput);
    } catch (error) {
      if (error instanceof WorldModelValidationError) {
        throw new ToolError("invalid_input", `candidate metric value is invalid: ${error.message}`);
      }
      throw error;
    }

    metricValueStore.save(metricValue);
    return { metricValue };
  };

  return { tool, handler };
}
