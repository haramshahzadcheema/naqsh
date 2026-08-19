import type { Approval, AuthorizationDecision, AutonomyGrant, Change, Project, Tool, ToolResult, WorldModelState } from "./types.js";
import type {
  EnvironmentDocumentInspection,
  EnvironmentObject,
  EnvironmentOperationResult,
  EnvironmentSession
} from "./environment-types.js";
import type { ModelInvocationResult, ModelRequest, ModelResponse } from "./model-types.js";
import type { Plan } from "./plan-types.js";
import type { Proposal } from "./proposal-types.js";
import type { Candidate } from "./candidate-types.js";
import type { CandidateMetricValue, OptimizationProblem, OptimizationResult } from "./optimization-types.js";
import type { MemoryRecord } from "./memory-types.js";
import type { AgentLoopRun } from "./agent-loop-types.js";
import type { Checkpoint } from "./checkpoint-types.js";
import type { Check, VerificationResult } from "./verification-types.js";
import type { ObjectiveSatisfactionResult } from "./objective-satisfaction-types.js";
import type { RequirementCandidate } from "./requirement-candidate-types.js";
import type { Clarification } from "./clarification-types.js";
import type { DesignSpecification } from "./design-specification-types.js";
import type { BuildResult } from "./build-types.js";
import type { ResearchEvidence, ResearchRequest, Source } from "./research-types.js";
import {
  assertAgentLoopRun,
  assertApproval,
  assertAuthorizationDecision,
  assertAutonomyGrant,
  assertCandidate,
  assertCandidateMetricValue,
  assertMemoryRecord,
  assertOptimizationProblem,
  assertOptimizationResult,
  assertChange,
  assertCheck,
  assertCheckpoint,
  assertClarification,
  assertDesignSpecification,
  assertBuildResult,
  assertEnvironmentDocumentInspection,
  assertEnvironmentObject,
  assertEnvironmentOperationResult,
  assertEnvironmentSession,
  assertModelInvocationResult,
  assertModelRequest,
  assertModelResponse,
  assertPlan,
  assertProject,
  assertProposal,
  assertObjectiveSatisfactionResult,
  assertRequirementCandidate,
  assertResearchEvidence,
  assertResearchRequest,
  assertSource,
  assertTool,
  assertToolResult,
  assertVerificationResult,
  assertWorldModelState,
  WorldModelValidationError
} from "./validators.js";

function requireNonEmptyString(value: string, message: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", message);
  }
}

export function serializeProject(project: Project): string {
  assertProject(project);
  return JSON.stringify(project);
}

export function deserializeProject(serialized: string): Project {
  requireNonEmptyString(serialized, "serialized project is required");
  const parsed: unknown = JSON.parse(serialized);
  assertProject(parsed);
  return parsed;
}

export function serializeWorldModelState(state: WorldModelState): string {
  assertWorldModelState(state);
  return JSON.stringify(state);
}

export function deserializeWorldModelState(serialized: string): WorldModelState {
  requireNonEmptyString(serialized, "serialized state is required");
  const parsed: unknown = JSON.parse(serialized);
  assertWorldModelState(parsed);
  return parsed;
}

export function serializeChange(change: Change): string {
  assertChange(change);
  return JSON.stringify(change);
}

export function deserializeChange(serialized: string): Change {
  requireNonEmptyString(serialized, "serialized change is required");
  const parsed: unknown = JSON.parse(serialized);
  assertChange(parsed);
  return parsed;
}

export function serializeTool(tool: Tool): string {
  assertTool(tool);
  return JSON.stringify(tool);
}

export function deserializeTool(serialized: string): Tool {
  requireNonEmptyString(serialized, "serialized tool is required");
  const parsed: unknown = JSON.parse(serialized);
  assertTool(parsed);
  return parsed;
}

export function serializeToolResult(result: ToolResult): string {
  assertToolResult(result);
  return JSON.stringify(result);
}

export function deserializeToolResult(serialized: string): ToolResult {
  requireNonEmptyString(serialized, "serialized tool result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertToolResult(parsed);
  return parsed;
}

export function serializeApproval(approval: Approval): string {
  assertApproval(approval);
  return JSON.stringify(approval);
}

export function deserializeApproval(serialized: string): Approval {
  requireNonEmptyString(serialized, "serialized approval is required");
  const parsed: unknown = JSON.parse(serialized);
  assertApproval(parsed);
  return parsed;
}

export function serializeAutonomyGrant(grant: AutonomyGrant): string {
  assertAutonomyGrant(grant);
  return JSON.stringify(grant);
}

export function deserializeAutonomyGrant(serialized: string): AutonomyGrant {
  requireNonEmptyString(serialized, "serialized autonomy grant is required");
  const parsed: unknown = JSON.parse(serialized);
  assertAutonomyGrant(parsed);
  return parsed;
}

export function serializeAuthorizationDecision(decision: AuthorizationDecision): string {
  assertAuthorizationDecision(decision);
  return JSON.stringify(decision);
}

export function deserializeAuthorizationDecision(serialized: string): AuthorizationDecision {
  requireNonEmptyString(serialized, "serialized authorization decision is required");
  const parsed: unknown = JSON.parse(serialized);
  assertAuthorizationDecision(parsed);
  return parsed;
}

export function serializeEnvironmentSession(session: EnvironmentSession): string {
  assertEnvironmentSession(session);
  return JSON.stringify(session);
}

export function deserializeEnvironmentSession(serialized: string): EnvironmentSession {
  requireNonEmptyString(serialized, "serialized environment session is required");
  const parsed: unknown = JSON.parse(serialized);
  assertEnvironmentSession(parsed);
  return parsed;
}

export function serializeEnvironmentObject(object: EnvironmentObject): string {
  assertEnvironmentObject(object);
  return JSON.stringify(object);
}

export function deserializeEnvironmentObject(serialized: string): EnvironmentObject {
  requireNonEmptyString(serialized, "serialized environment object is required");
  const parsed: unknown = JSON.parse(serialized);
  assertEnvironmentObject(parsed);
  return parsed;
}

export function serializeEnvironmentOperationResult(result: EnvironmentOperationResult): string {
  assertEnvironmentOperationResult(result);
  return JSON.stringify(result);
}

export function deserializeEnvironmentOperationResult(serialized: string): EnvironmentOperationResult {
  requireNonEmptyString(serialized, "serialized environment operation result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertEnvironmentOperationResult(parsed);
  return parsed;
}

export function serializeEnvironmentDocumentInspection(inspection: EnvironmentDocumentInspection): string {
  assertEnvironmentDocumentInspection(inspection);
  return JSON.stringify(inspection);
}

export function deserializeEnvironmentDocumentInspection(serialized: string): EnvironmentDocumentInspection {
  requireNonEmptyString(serialized, "serialized environment document inspection is required");
  const parsed: unknown = JSON.parse(serialized);
  assertEnvironmentDocumentInspection(parsed);
  return parsed;
}

export function serializeModelRequest(request: ModelRequest): string {
  assertModelRequest(request);
  return JSON.stringify(request);
}

export function deserializeModelRequest(serialized: string): ModelRequest {
  requireNonEmptyString(serialized, "serialized model request is required");
  const parsed: unknown = JSON.parse(serialized);
  assertModelRequest(parsed);
  return parsed;
}

export function serializeModelResponse(response: ModelResponse): string {
  assertModelResponse(response);
  return JSON.stringify(response);
}

export function deserializeModelResponse(serialized: string): ModelResponse {
  requireNonEmptyString(serialized, "serialized model response is required");
  const parsed: unknown = JSON.parse(serialized);
  assertModelResponse(parsed);
  return parsed;
}

export function serializePlan(plan: Plan): string {
  assertPlan(plan);
  return JSON.stringify(plan);
}

export function deserializePlan(serialized: string): Plan {
  requireNonEmptyString(serialized, "serialized plan is required");
  const parsed: unknown = JSON.parse(serialized);
  assertPlan(parsed);
  return parsed;
}

export function serializeProposal(proposal: Proposal): string {
  assertProposal(proposal);
  return JSON.stringify(proposal);
}

export function deserializeProposal(serialized: string): Proposal {
  requireNonEmptyString(serialized, "serialized proposal is required");
  const parsed: unknown = JSON.parse(serialized);
  assertProposal(parsed);
  return parsed;
}

export function serializeCandidate(candidate: Candidate): string {
  assertCandidate(candidate);
  return JSON.stringify(candidate);
}

export function deserializeCandidate(serialized: string): Candidate {
  requireNonEmptyString(serialized, "serialized candidate is required");
  const parsed: unknown = JSON.parse(serialized);
  assertCandidate(parsed);
  return parsed;
}

export function serializeCandidateMetricValue(metricValue: CandidateMetricValue): string {
  assertCandidateMetricValue(metricValue);
  return JSON.stringify(metricValue);
}

export function deserializeCandidateMetricValue(serialized: string): CandidateMetricValue {
  requireNonEmptyString(serialized, "serialized candidate metric value is required");
  const parsed: unknown = JSON.parse(serialized);
  assertCandidateMetricValue(parsed);
  return parsed;
}

export function serializeOptimizationProblem(problem: OptimizationProblem): string {
  assertOptimizationProblem(problem);
  return JSON.stringify(problem);
}

export function deserializeOptimizationProblem(serialized: string): OptimizationProblem {
  requireNonEmptyString(serialized, "serialized optimization problem is required");
  const parsed: unknown = JSON.parse(serialized);
  assertOptimizationProblem(parsed);
  return parsed;
}

export function serializeOptimizationResult(result: OptimizationResult): string {
  assertOptimizationResult(result);
  return JSON.stringify(result);
}

export function deserializeOptimizationResult(serialized: string): OptimizationResult {
  requireNonEmptyString(serialized, "serialized optimization result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertOptimizationResult(parsed);
  return parsed;
}

export function serializeMemoryRecord(record: MemoryRecord): string {
  assertMemoryRecord(record);
  return JSON.stringify(record);
}

export function deserializeMemoryRecord(serialized: string): MemoryRecord {
  requireNonEmptyString(serialized, "serialized memory record is required");
  const parsed: unknown = JSON.parse(serialized);
  assertMemoryRecord(parsed);
  return parsed;
}

export function serializeModelInvocationResult(result: ModelInvocationResult): string {
  assertModelInvocationResult(result);
  return JSON.stringify(result);
}

export function deserializeModelInvocationResult(serialized: string): ModelInvocationResult {
  requireNonEmptyString(serialized, "serialized model invocation result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertModelInvocationResult(parsed);
  return parsed;
}

export function serializeCheckpoint(checkpoint: Checkpoint): string {
  assertCheckpoint(checkpoint);
  return JSON.stringify(checkpoint);
}

export function deserializeCheckpoint(serialized: string): Checkpoint {
  requireNonEmptyString(serialized, "serialized checkpoint is required");
  const parsed: unknown = JSON.parse(serialized);
  assertCheckpoint(parsed);
  return parsed;
}

export function serializeAgentLoopRun(run: AgentLoopRun): string {
  assertAgentLoopRun(run);
  return JSON.stringify(run);
}

export function deserializeAgentLoopRun(serialized: string): AgentLoopRun {
  requireNonEmptyString(serialized, "serialized agent loop run is required");
  const parsed: unknown = JSON.parse(serialized);
  assertAgentLoopRun(parsed);
  return parsed;
}

export function serializeCheck(check: Check): string {
  assertCheck(check);
  return JSON.stringify(check);
}

export function deserializeCheck(serialized: string): Check {
  requireNonEmptyString(serialized, "serialized check is required");
  const parsed: unknown = JSON.parse(serialized);
  assertCheck(parsed);
  return parsed;
}

export function serializeVerificationResult(result: VerificationResult): string {
  assertVerificationResult(result);
  return JSON.stringify(result);
}

export function deserializeVerificationResult(serialized: string): VerificationResult {
  requireNonEmptyString(serialized, "serialized verification result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertVerificationResult(parsed);
  return parsed;
}

export function serializeObjectiveSatisfactionResult(result: ObjectiveSatisfactionResult): string {
  assertObjectiveSatisfactionResult(result);
  return JSON.stringify(result);
}

export function deserializeObjectiveSatisfactionResult(serialized: string): ObjectiveSatisfactionResult {
  requireNonEmptyString(serialized, "serialized objective satisfaction result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertObjectiveSatisfactionResult(parsed);
  return parsed;
}

export function serializeRequirementCandidate(candidate: RequirementCandidate): string {
  assertRequirementCandidate(candidate);
  return JSON.stringify(candidate);
}

export function deserializeRequirementCandidate(serialized: string): RequirementCandidate {
  requireNonEmptyString(serialized, "serialized requirement candidate is required");
  const parsed: unknown = JSON.parse(serialized);
  assertRequirementCandidate(parsed);
  return parsed;
}

export function serializeClarification(clarification: Clarification): string {
  assertClarification(clarification);
  return JSON.stringify(clarification);
}

export function deserializeClarification(serialized: string): Clarification {
  requireNonEmptyString(serialized, "serialized clarification is required");
  const parsed: unknown = JSON.parse(serialized);
  assertClarification(parsed);
  return parsed;
}

export function serializeDesignSpecification(design: DesignSpecification): string {
  assertDesignSpecification(design);
  return JSON.stringify(design);
}

export function deserializeDesignSpecification(serialized: string): DesignSpecification {
  requireNonEmptyString(serialized, "serialized design specification is required");
  const parsed: unknown = JSON.parse(serialized);
  assertDesignSpecification(parsed);
  return parsed;
}

export function serializeBuildResult(result: BuildResult): string {
  assertBuildResult(result);
  return JSON.stringify(result);
}

export function deserializeBuildResult(serialized: string): BuildResult {
  requireNonEmptyString(serialized, "serialized build result is required");
  const parsed: unknown = JSON.parse(serialized);
  assertBuildResult(parsed);
  return parsed;
}

export function serializeSource(source: Source): string {
  assertSource(source);
  return JSON.stringify(source);
}

export function deserializeSource(serialized: string): Source {
  requireNonEmptyString(serialized, "serialized source is required");
  const parsed: unknown = JSON.parse(serialized);
  assertSource(parsed);
  return parsed;
}

export function serializeResearchEvidence(evidence: ResearchEvidence): string {
  assertResearchEvidence(evidence);
  return JSON.stringify(evidence);
}

export function deserializeResearchEvidence(serialized: string): ResearchEvidence {
  requireNonEmptyString(serialized, "serialized research evidence is required");
  const parsed: unknown = JSON.parse(serialized);
  assertResearchEvidence(parsed);
  return parsed;
}

export function serializeResearchRequest(request: ResearchRequest): string {
  assertResearchRequest(request);
  return JSON.stringify(request);
}

export function deserializeResearchRequest(serialized: string): ResearchRequest {
  requireNonEmptyString(serialized, "serialized research request is required");
  const parsed: unknown = JSON.parse(serialized);
  assertResearchRequest(parsed);
  return parsed;
}
