import {
  createExecuteToolAuthorizer,
  executeTool,
  generateDesignSpecification,
  generatePlanProposal,
  generateProposal,
  isProposalStale,
  observeProject,
  requestProposalApproval,
  resumeAgentLoopRunAfterApproval,
  selectFirstPendingPlanStep,
  type ModelProvider
} from "@naqsh/core";
import {
  createAgentLoopRun,
  type Approval,
  type AuthorizationDecision,
  type Candidate,
  type Check,
  type Checkpoint,
  type DesignSpecification,
  type EnvironmentObject,
  type EnvironmentSession,
  type LoopDiscrepancy,
  type ModelRequestConfigInput,
  type ObjectiveSatisfactionResult,
  type Plan,
  type Proposal,
  type VerificationResult
} from "@naqsh/schemas";
import { ensureEnvironmentSession, indexProposal, type ProjectRuntime } from "./projectRuntime.js";
import { describeMemoryForModel } from "./memoryContext.js";

/**
 * The Phase "real engineering agent execution" service layer: OBSERVE ->
 * PLAN -> PROPOSE -> APPROVE -> EXECUTE -> VERIFY -> REPORT, entirely
 * through existing P8/P9/P10/P4/P3/P15/P16/P17 functions -- this file adds
 * ORCHESTRATION and ACTIVITY LOGGING, never a second implementation of
 * any of them. Nothing here mutates `WorldModelState`/the environment
 * directly; every mutation goes through `executeTool` with a real
 * `authorize` hook, exactly like `projectRuntime.ts`'s existing
 * `captureRequirementFromStatement`.
 */

export interface WorkflowFailure {
  kind: string;
  message: string;
}

function authorizerFor(runtime: ProjectRuntime, onDecision?: (decision: AuthorizationDecision) => void) {
  return createExecuteToolAuthorizer({
    autonomyLevel: "approved_modify",
    approvals: runtime.approvals,
    autonomyGrants: runtime.autonomyGrants,
    onDecision
  });
}

/** Same pre-authorized "autonomous" level `captureRequirementFromStatement`/
 * `syncEnvironmentObjectsIntoWorldModel` already use (via
 * `grantChatRequirementCaptureAutonomy`, projectRuntime.ts) -- generating
 * and saving conceptual design ALTERNATIVES is exactly the same kind of
 * low-risk bookkeeping: a new, independent, additive record, never a
 * mutation of `WorldModelState` or the live environment. Nothing here
 * skips the real approval gate that still protects EXECUTING a proposal
 * that would actually modify the environment -- only the "record what
 * the model conceptually proposed" step is autonomous. */
function autonomousAuthorizerFor(runtime: ProjectRuntime) {
  return createExecuteToolAuthorizer({ autonomyLevel: "autonomous", approvals: runtime.approvals, autonomyGrants: runtime.autonomyGrants });
}

// ---- PART 3: Observation ---------------------------------------------------

export function observeCurrentProject(runtime: ProjectRuntime) {
  const observation = observeProject(runtime.getState(), { scope: "project" });
  runtime.logActivity("observed", "Observed", `${observation.objects.length} object(s), ${observation.requirements.length} requirement(s), ${observation.constraints.length} constraint(s).`);
  return observation;
}

/**
 * Bridges P8's own documented gap: `ObservationResult.objects` comes
 * exclusively from `WorldModelState.project.objects`, never from the live
 * environment (P8 deliberately never touches it). Without this, a plan
 * step could never legitimately cite a real environment object id
 * (`plan-semantics.ts`), so no proposal could ever legitimately target one
 * either (`proposal-semantics.ts`). This reconciles what the connected
 * environment ACTUALLY reports into the World Model, through the real
 * `sync_environment_object` tool -- same `executeTool`/authorize boundary
 * as every other mutation, never a direct write. Purely descriptive: never
 * creates/modifies/deletes anything in the environment itself.
 *
 * Uses `autonomyLevel: "autonomous"` (matching `captureRequirementFromStatement`'s
 * own `add_requirement` call) because that's the level `grantChatRequirementCaptureAutonomy`'s
 * AutonomyGrant actually applies at (`evaluateToolAuthorization` only
 * consults AutonomyGrants when `autonomyLevel === "autonomous"`; anything
 * else falls through to requiring a real per-call Approval, which bookkeeping
 * this routine deliberately doesn't need).
 */
async function syncEnvironmentObjectsIntoWorldModel(runtime: ProjectRuntime): Promise<void> {
  let session: EnvironmentSession;
  try {
    session = await ensureEnvironmentSession(runtime);
  } catch {
    return;
  }
  const listed = await runtime.environmentAdapter.listObjects(session);
  if (listed.status !== "success") return;
  const objects = listed.data as EnvironmentObject[];

  const authorize = createExecuteToolAuthorizer({
    autonomyLevel: "autonomous",
    approvals: runtime.approvals,
    autonomyGrants: runtime.autonomyGrants
  });

  for (const object of objects) {
    if (runtime.getState().project.objects.some((existing) => existing.id === object.id)) continue;
    const properties: Record<string, unknown> = {};
    for (const property of object.properties) properties[property.key] = property.value;
    await executeTool(runtime.registry, {
      toolName: "sync_environment_object",
      input: { id: object.id, type: object.type, name: object.name, properties },
      source: "agent",
      target: null,
      authorize
    });
  }
}

// ---- PART 4: Planning -------------------------------------------------------

export type PlanOutcome = { status: "success"; plan: Plan } | { status: "error"; error: WorkflowFailure };

/** OBSERVE -> construct planning context -> call the ModelProvider ->
 * validate structured output -> semantically validate -> persist. The
 * model's output never directly becomes executable: `generatePlanProposal`
 * (P9, unmodified) returns a `Plan` -- a reasoning artifact, not an
 * action. */
export async function generateProjectPlan(runtime: ProjectRuntime, provider: ModelProvider, modelConfig: ModelRequestConfigInput): Promise<PlanOutcome> {
  // A plan step can only be realized by a later Proposal that targets an
  // object the step itself cited (validateProposalSemantics, P10) -- so
  // real environment objects must exist in the World Model BEFORE
  // observing, or no step could ever legitimately cite the thing a
  // proposal would actually need to modify.
  await syncEnvironmentObjectsIntoWorldModel(runtime);
  const observation = observeCurrentProject(runtime);
  const environmentContext = await describeEnvironmentForModel(runtime);
  const memoryContext = describeMemoryForModel(runtime.memory.listForProject(runtime.projectId));
  const result = await generatePlanProposal(provider, observation, { config: modelConfig, additionalInstruction: `${environmentContext}\n\n${memoryContext}` });

  if (result.status === "error") {
    runtime.logActivity("note", "Planning failed", result.error.message);
    return { status: "error", error: result.error };
  }

  runtime.plans.set(result.plan.id, result.plan);
  runtime.logActivity("reasoning", "Plan created", result.plan.objectiveSummary || "(no objective stated)");
  return { status: "success", plan: result.plan };
}

// ---- PART 5: Proposals -------------------------------------------------------

export type ProposalOutcome = { status: "success"; proposal: Proposal; approvalId: string } | { status: "error"; error: WorkflowFailure };

/** Describes the environment's REAL, currently-observable objects to the
 * model in plain text -- `generateProposal` (P10) has no live environment
 * access of its own (by design: it never holds an EnvironmentAdapter
 * reference), so this is how the model learns real object ids/property
 * keys it's allowed to target, via `GenerateProposalOptions.
 * additionalInstruction`. Never invents ids -- if the environment can't
 * be reached, says so plainly instead of fabricating a fixture. */
async function describeEnvironmentForModel(runtime: ProjectRuntime): Promise<string> {
  try {
    const session = await ensureEnvironmentSession(runtime);
    const listed = await runtime.environmentAdapter.listObjects(session);
    if (listed.status !== "success") {
      return "The connected environment could not be inspected right now -- do not propose modify_environment_object.";
    }
    const objects = listed.data as EnvironmentObject[];
    if (objects.length === 0) {
      return "The connected environment currently has no objects -- do not propose modify_environment_object.";
    }
    const lines = objects.map(
      (object) =>
        `  - objectId: "${object.id}", name: "${object.name}", type: "${object.type}", properties: ${JSON.stringify(
          object.properties.map((property) => ({ key: property.key, value: property.value, readOnly: property.readOnly }))
        )}`
    );
    return `Objects that ACTUALLY EXIST in the connected environment right now (use these exact ids/property keys -- never invent one):\n${lines.join("\n")}`;
  } catch (error) {
    return `The environment is not currently connectable (${error instanceof Error ? error.message : String(error)}) -- do not propose modify_environment_object.`;
  }
}

/** A PlanStep -> a concrete Proposal, immediately paired with a real,
 * pending Approval (P4) -- so "a Proposal exists" and "someone can
 * authorize it" are established together, exactly like
 * `beginAgentLoopRun` (P11) already does. No execution happens here. */
export async function generateProjectProposal(
  runtime: ProjectRuntime,
  provider: ModelProvider,
  planId: string,
  modelConfig: ModelRequestConfigInput,
  planStepId?: string
): Promise<ProposalOutcome> {
  const plan = runtime.plans.get(planId);
  if (!plan) {
    return { status: "error", error: { kind: "plan_not_found", message: `No plan with id "${planId}" exists in this project.` } };
  }

  const stepId = planStepId ?? selectFirstPendingPlanStep(plan);
  if (!stepId) {
    return { status: "error", error: { kind: "no_pending_step", message: "This plan has no pending step left to realize." } };
  }

  const step = plan.steps.find((candidate) => candidate.id === stepId);
  runtime.logActivity("reasoning", "Preparing proposal", step ? `Realizing step: "${step.title}"` : `Realizing step "${stepId}"`);

  const environmentContext = await describeEnvironmentForModel(runtime);
  const memoryContext = describeMemoryForModel(runtime.memory.listForProject(runtime.projectId));
  const additionalInstruction = `${environmentContext}\n\n${memoryContext}`;
  const result = await generateProposal(provider, runtime.registry, plan, stepId, { config: modelConfig, additionalInstruction });

  if (result.status === "error") {
    runtime.logActivity("note", "Proposal generation failed", result.error.message);
    return { status: "error", error: result.error };
  }

  const approval = requestProposalApproval(runtime.approvals, result.proposal, { requestedBy: "agent" });
  runtime.proposals.set(result.proposal.id, { proposal: result.proposal, approvalId: approval.id });
  indexProposal(result.proposal.id, runtime.projectId);
  runtime.logActivity("proposal", "Proposal ready", result.proposal.rationale);

  return { status: "success", proposal: result.proposal, approvalId: approval.id };
}

// ---- PART 5b: Candidate generation (P20/P22, wired to a real HTTP surface
// for the first time -- an audit found `generateDesignSpecification`
// fully built/tested but never actually called from apps/api, and
// `DesignSpecificationStore.save` never called by anything at all) -------

export interface GeneratedCandidate {
  designSpecification: DesignSpecification;
  candidate: Candidate;
}

export type CandidatesOutcome = { status: "success"; candidates: GeneratedCandidate[]; failures: WorkflowFailure[] } | { status: "error"; error: WorkflowFailure };

/**
 * PlanStep -> N independently-generated `DesignSpecification`s, each
 * immediately turned into a real, stored `Candidate` -- "propose N
 * meaningfully different engineering alternatives for this step," the
 * concrete capability `create-candidate-tool.ts`'s own doc comment
 * describes as deliberately deferred ("Full candidate GENERATION from a
 * natural-language request... depends on a design-specification-
 * generation pipeline this phase doesn't add"). That pipeline already
 * existed, fully built and tested, in `generateDesignSpecification`
 * (P20) -- this function is the orchestration that finally calls it from
 * a live project, exactly the "connect what already exists" gap this
 * pass exists to close, never a second design-generation implementation.
 *
 * BEST-EFFORT, not all-or-nothing: a single variation failing (a model
 * hiccup, non-conforming structured output) does not discard the
 * variations that succeeded -- `failures` reports every individual miss
 * honestly, and the overall call only reports `status: "error"` when
 * NOTHING could be generated. Matches this codebase's own "partial,
 * honestly-labeled success beats an all-or-nothing wall" precedent
 * (background job runs report partial results the same way).
 */
export async function generateProjectCandidates(
  runtime: ProjectRuntime,
  provider: ModelProvider,
  planId: string,
  planStepId: string,
  count: number,
  modelConfig: ModelRequestConfigInput
): Promise<CandidatesOutcome> {
  const plan = runtime.plans.get(planId);
  if (!plan) {
    return { status: "error", error: { kind: "plan_not_found", message: `No plan with id "${planId}" exists in this project.` } };
  }
  const step = plan.steps.find((candidate) => candidate.id === planStepId);
  if (!step) {
    return { status: "error", error: { kind: "unknown_plan_step", message: `No step with id "${planStepId}" exists in plan "${planId}".` } };
  }

  const state = runtime.getState();
  runtime.logActivity("reasoning", "Exploring alternatives", `Generating ${count} candidate design${count === 1 ? "" : "s"} for step: "${step.title}"`);

  const authorize = autonomousAuthorizerFor(runtime);
  const results: GeneratedCandidate[] = [];
  const failures: WorkflowFailure[] = [];
  const memoryContext = describeMemoryForModel(runtime.memory.listForProject(runtime.projectId));

  for (let index = 0; index < count; index++) {
    const variationInstruction =
      count > 1
        ? `Generate variation ${index + 1} of ${count}. It must be a genuinely DIFFERENT design approach from any other variation in this batch (different geometry strategy, component arrangement, or material intent) -- never a restatement of the same idea with cosmetic wording changes.`
        : null;
    const additionalInstruction = [memoryContext, variationInstruction].filter((part): part is string => part !== null).join("\n\n");

    const designResult = await generateDesignSpecification(provider, plan, planStepId, state.project.requirements, state.project.constraints, { config: modelConfig, additionalInstruction });
    if (designResult.status === "error") {
      failures.push({ kind: designResult.error.kind, message: designResult.error.message });
      continue;
    }

    const savedDesign = await executeTool(runtime.registry, {
      toolName: "save_design_specification",
      input: { designSpecification: designResult.design },
      source: "agent",
      target: null,
      authorize
    });
    if (savedDesign.result.status === "error") {
      failures.push({ kind: savedDesign.result.error?.kind ?? "save_failed", message: savedDesign.result.error?.message ?? "Could not save this design specification." });
      continue;
    }
    const design = (savedDesign.result.output as { designSpecification: DesignSpecification }).designSpecification;

    const candidateResult = await executeTool(runtime.registry, {
      toolName: "create_candidate",
      input: {
        plan,
        planStepId,
        designSpecificationId: design.id,
        relevantRequirementIds: design.relevantRequirementIds,
        relevantConstraintIds: design.relevantConstraintIds,
        hypothesis: design.description,
        rationale: design.manufacturingIntent ?? "One of several alternative approaches explored for this plan step."
      },
      source: "agent",
      target: null,
      authorize
    });
    if (candidateResult.result.status === "error") {
      failures.push({ kind: candidateResult.result.error?.kind ?? "candidate_failed", message: candidateResult.result.error?.message ?? "Could not record this candidate." });
      continue;
    }
    const candidate = (candidateResult.result.output as { candidate: Candidate }).candidate;
    results.push({ designSpecification: design, candidate });
  }

  if (results.length === 0) {
    const firstFailure = failures[0] ?? { kind: "generation_failed", message: "No candidates could be generated." };
    runtime.logActivity("note", "Candidate generation failed", firstFailure.message);
    return { status: "error", error: firstFailure };
  }

  runtime.logActivity(
    "recommendation",
    "Candidates ready",
    `${results.length} of ${count} requested candidate${count === 1 ? "" : "s"} generated for step: "${step.title}"${failures.length > 0 ? ` (${failures.length} failed)` : ""}`
  );
  return { status: "success", candidates: results, failures };
}

// ---- PART 5c: Exploration (Section 5: "explore alternatives") -------------
// Candidates -> a ready-to-run BackgroundJob request, gated behind REAL,
// human-approved Approval records for every mutate-tool the job's builds
// will need -- never auto-approved (see jobsWorkflow.ts's submitBackgroundJob,
// which the frontend calls once every returned pendingApprovalId is
// approved via the generic approval routes, server.ts). This function only
// PREPARES the exploration (generates candidates, requests approval); it
// never itself calls submitBackgroundJob -- starting the job is a
// deliberately separate, human-gated step.

/** The exact "mutate"-classified tools a candidate's build (and its
 * verifyCandidateBuild-driven checks) can call -- see build-operations.ts
 * (create/modify) and experiment-executor.ts (add/update experiment).
 * create_checkpoint/create_check/run_verification are NOT "mutate" (suggest/
 * suggest/verify), so they need no approval at "approved_modify" and are
 * simply included in allowedTools directly, without a matching Approval. */
const EXPLORATION_MUTATE_TOOLS = ["add_experiment", "update_experiment", "create_environment_object", "modify_environment_object"];
export const EXPLORATION_ALLOWED_TOOLS = ["create_checkpoint", ...EXPLORATION_MUTATE_TOOLS, "create_check", "run_verification"];

export interface PreparedExploration {
  planId: string;
  planStepId: string;
  candidates: GeneratedCandidate[];
  failures: WorkflowFailure[];
  pendingApprovals: Approval[];
  allowedTools: string[];
}

export type ExplorationOutcome = { status: "success"; exploration: PreparedExploration } | { status: "error"; error: WorkflowFailure };

/**
 * Generates N candidates for the current project's most recently created
 * Plan's next pending step (mirrors `generateProjectProposal`'s own
 * `selectFirstPendingPlanStep` default -- reuses that exact P9 helper,
 * never a second "which step" heuristic), then requests one real, pending
 * Approval per tool `EXPLORATION_MUTATE_TOOLS` names. Candidates are
 * generated regardless of whether approval is later granted (generating a
 * candidate is a real but non-mutating record, same "autonomous" tier
 * `generateProjectCandidates` itself already uses) -- only BUILDING them
 * (a background job's job) requires the human to act on the approvals this
 * returns.
 */
export async function prepareExploration(runtime: ProjectRuntime, provider: ModelProvider, modelConfig: ModelRequestConfigInput, count: number): Promise<ExplorationOutcome> {
  const plans = Array.from(runtime.plans.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const plan = plans[0];
  if (!plan) {
    return { status: "error", error: { kind: "no_plan", message: "There's no plan yet to explore alternatives for -- ask me to design it first." } };
  }
  const planStepId = selectFirstPendingPlanStep(plan);
  if (!planStepId) {
    return { status: "error", error: { kind: "no_pending_step", message: "This plan has no pending step left to explore alternatives for." } };
  }

  const generated = await generateProjectCandidates(runtime, provider, plan.id, planStepId, count, modelConfig);
  if (generated.status === "error") return generated;

  const pendingApprovals = EXPLORATION_MUTATE_TOOLS.map((toolName) =>
    runtime.approvals.create({
      toolName,
      targetType: null,
      targetId: null,
      proposalId: null,
      reason: `Exploring ${generated.candidates.length} alternative(s) for plan step "${planStepId}"`,
      requestedBy: "agent"
    })
  );
  runtime.logActivity(
    "recommendation",
    "Exploration ready for approval",
    `${generated.candidates.length} candidate(s) generated -- approve the ${pendingApprovals.length} pending action(s) to run and verify them.`
  );

  return {
    status: "success",
    exploration: { planId: plan.id, planStepId, candidates: generated.candidates, failures: generated.failures, pendingApprovals, allowedTools: EXPLORATION_ALLOWED_TOOLS }
  };
}

// ---- PART 6: Approval --------------------------------------------------------

export type DecisionOutcome = { status: "success"; proposal: Proposal; approval: Approval } | { status: "error"; error: WorkflowFailure };

export function approveProposal(runtime: ProjectRuntime, proposalId: string, reason?: string): DecisionOutcome {
  const tracked = runtime.proposals.get(proposalId);
  if (!tracked) return { status: "error", error: { kind: "proposal_not_found", message: `No proposal "${proposalId}" in this project.` } };
  try {
    const approval = runtime.approvals.approve(tracked.approvalId, "human", reason);
    runtime.logActivity("recommendation", "Approved", `Proposal "${proposalId}" was approved.`);
    return { status: "success", proposal: tracked.proposal, approval };
  } catch (error) {
    return { status: "error", error: { kind: "approval_failed", message: error instanceof Error ? error.message : String(error) } };
  }
}

export function rejectProposal(runtime: ProjectRuntime, proposalId: string, reason?: string): DecisionOutcome {
  const tracked = runtime.proposals.get(proposalId);
  if (!tracked) return { status: "error", error: { kind: "proposal_not_found", message: `No proposal "${proposalId}" in this project.` } };
  try {
    const approval = runtime.approvals.reject(tracked.approvalId, "human", reason);
    runtime.logActivity("note", "Rejected", `Proposal "${proposalId}" was rejected.`);
    return { status: "success", proposal: tracked.proposal, approval };
  } catch (error) {
    return { status: "error", error: { kind: "rejection_failed", message: error instanceof Error ? error.message : String(error) } };
  }
}

// ---- PART 7/8: Execution + Verification + Objective satisfaction -----------

export type ExecutionStatus = "success" | "failed";
export type VerificationStatus = "passed" | "failed" | "inconclusive" | "not_run";
export type ObjectiveStatus = "satisfied" | "not_satisfied" | "unknown";

export interface ExecutionReport {
  execution: { status: ExecutionStatus; message: string; checkpointId: string | null; propertyChanges: unknown[] };
  verification: { status: VerificationStatus; results: VerificationResult[]; checks: Check[] };
  objective: { status: ObjectiveStatus; result: ObjectiveSatisfactionResult | null };
  /** P11's real "COMMAND SUCCEEDED != OBJECTIVE SATISFIED" structural check
   * (agent-loop.ts's `detectDiscrepancy`, via `resumeAgentLoopRunAfterApproval`):
   * a deterministic before/after comparison of the proposal's declared
   * target entity, independent of deterministic verification (which checks
   * a specific property against a specific expected value) and independent
   * of `execution.status` (which only reflects whether the tool call itself
   * reported success). `null` when discrepancy detection never ran for this
   * outcome (execution was rejected/stale/failed before reaching it). */
  discrepancy: LoopDiscrepancy | null;
}

export type ExecuteOutcome = { status: "success"; report: ExecutionReport } | { status: "error"; error: WorkflowFailure };

/**
 * Approval already exists and must be genuinely "approved" -- executeTool
 * re-checks this itself (via evaluateApproval, re-reading the store, never
 * trusting a stale copy). This function's own job is everything AROUND
 * that: freshness, environment capability, checkpoint-before-mutation, and
 * deterministic verification immediately after. If any pre-check fails,
 * NOTHING is mutated -- the environment/World Model are never touched
 * before every earlier step already succeeded.
 */
export async function executeProposal(runtime: ProjectRuntime, proposalId: string): Promise<ExecuteOutcome> {
  const tracked = runtime.proposals.get(proposalId);
  if (!tracked) return { status: "error", error: { kind: "proposal_not_found", message: `No proposal "${proposalId}" in this project.` } };
  const { proposal } = tracked;

  // Revalidate freshness -- a stale proposal (project changed since it was
  // generated) is refused outright, never executed against a moved target.
  if (isProposalStale(proposal, runtime.getState())) {
    runtime.logActivity("note", "Proposal stale", `Proposal "${proposalId}" is stale -- the project has changed since it was generated.`);
    return { status: "error", error: { kind: "proposal_stale", message: "This proposal is stale (the project has changed since it was generated). Generate a new proposal instead of executing this one." } };
  }

  // Revalidate environment capability BEFORE touching anything.
  const descriptor = runtime.environmentAdapter.describe();
  if (proposal.toolTarget === "environment" && !descriptor.capabilities.includes("modify")) {
    runtime.logActivity("note", "Capability missing", `The "${runtime.environmentKind}" environment does not support modification.`);
    return { status: "error", error: { kind: "capability_missing", message: `The connected "${runtime.environmentKind}" environment does not support the "modify" capability this proposal needs.` } };
  }

  let session: EnvironmentSession | null = null;
  if (proposal.toolTarget === "environment") {
    try {
      session = await ensureEnvironmentSession(runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.logActivity("note", "Environment unavailable", message);
      return { status: "error", error: { kind: "environment_unavailable", message } };
    }
  }
  void session;

  // Checkpoint BEFORE mutation -- if this fails, execution is aborted and
  // nothing else runs.
  const checkpointExec = await executeTool(runtime.registry, {
    toolName: "create_checkpoint",
    input: { reason: `Before executing proposal "${proposal.id}": ${proposal.rationale}` },
    source: "agent",
    target: null,
    authorize: authorizerFor(runtime)
  });
  if (checkpointExec.result.status === "error") {
    const message = checkpointExec.result.error?.message ?? "Could not create a checkpoint.";
    runtime.logActivity("note", "Checkpoint failed", message);
    return { status: "error", error: { kind: "checkpoint_failed", message: `Execution aborted -- could not create a safety checkpoint: ${message}` } };
  }
  const checkpoint = (checkpointExec.result.output as { checkpoint: Checkpoint }).checkpoint;
  runtime.logActivity("note", "Checkpoint created", `Checkpoint "${checkpoint.id}" captured before execution.`);

  // EXECUTE -> OBSERVE, through P11's real controlled agent loop
  // (agent-loop.ts) -- an audit found `resumeAgentLoopRunAfterApproval` had
  // ZERO callers anywhere in apps/api despite being real, independently
  // tested code. The Plan/Proposal/Approval this proposal already carries
  // (from generateProjectPlan/generateProjectProposal/approveProposal,
  // unchanged above) are exactly what a real `AgentLoopRun` needs -- this
  // function assembles the "awaiting_approval" seed those records already
  // describe, then hands EXECUTE+OBSERVE (authorization re-verification,
  // staleness, the real `executeTool` call, post-execution observation, AND
  // genuine before/after discrepancy detection) entirely to the real
  // primitive, never a second hand-rolled copy of any of it.
  const plan = runtime.plans.get(proposal.planId);
  if (!plan) {
    const message = `The plan this proposal came from ("${proposal.planId}") no longer exists in this project.`;
    runtime.logActivity("note", "Plan missing", message);
    return { status: "error", error: { kind: "plan_not_found", message } };
  }
  const approval = runtime.approvals.getById(tracked.approvalId);
  if (!approval) {
    const message = `This proposal's approval record ("${tracked.approvalId}") no longer exists.`;
    runtime.logActivity("note", "Approval missing", message);
    return { status: "error", error: { kind: "approval_not_found", message } };
  }

  const seedRun = createAgentLoopRun({
    projectId: runtime.projectId,
    observationBefore: observeCurrentProject(runtime),
    plan,
    planStepId: proposal.planStepId,
    proposal,
    approval,
    status: "awaiting_approval",
    source: "agent"
  });

  const loopOutcome = await resumeAgentLoopRunAfterApproval({
    run: seedRun,
    getState: runtime.getState,
    registry: runtime.registry,
    approvals: runtime.approvals,
    autonomyGrants: runtime.autonomyGrants,
    autonomyLevel: "approved_modify",
    source: "agent"
  });

  if (loopOutcome.status === "error") {
    if (loopOutcome.error.kind === "not_approved") {
      // The approval exists but is still "pending" (never decided) or was
      // already consumed by an earlier execution -- executeTool's own
      // authorize hook would deny this identically; reported the SAME
      // honest "execution failed" way as any other authorization denial,
      // never a top-level orchestration error (a frontend must be able to
      // treat this exactly like any other execution.status "failed").
      runtime.logActivity("note", "Execution not authorized", loopOutcome.error.message);
      return {
        status: "success",
        report: {
          execution: { status: "failed", message: loopOutcome.error.message, checkpointId: checkpoint.id, propertyChanges: [] },
          verification: { status: "not_run", results: [], checks: [] },
          objective: { status: "unknown", result: null },
          discrepancy: null
        }
      };
    }
    // Only reachable if `seedRun` itself were malformed (a mismatched
    // approval, a run not "awaiting_approval") -- structurally shouldn't
    // happen given it was just constructed above from this exact proposal's
    // own approval, but handled honestly rather than assumed impossible.
    runtime.logActivity("note", "Execution could not proceed", loopOutcome.error.message);
    return { status: "error", error: { kind: loopOutcome.error.kind, message: loopOutcome.error.message } };
  }

  const run = loopOutcome.run;
  runtime.agentLoopRuns.save(run);

  if (run.status === "rejected" || run.status === "stale") {
    const message = run.status === "rejected" ? "This proposal's approval was rejected or revoked." : "This proposal is stale -- the project changed since it was approved.";
    runtime.logActivity("note", "Execution not authorized", message);
    return {
      status: "success",
      report: {
        execution: { status: "failed", message, checkpointId: checkpoint.id, propertyChanges: [] },
        verification: { status: "not_run", results: [], checks: [] },
        objective: { status: "unknown", result: null },
        discrepancy: null
      }
    };
  }

  if (run.status === "execution_failed") {
    const message = run.executionResult?.toolResult?.error?.message ?? "Execution failed.";
    runtime.logActivity("note", "Execution failed", message);
    return {
      status: "success",
      report: {
        execution: { status: "failed", message, checkpointId: checkpoint.id, propertyChanges: [] },
        verification: { status: "not_run", results: [], checks: [] },
        objective: { status: "unknown", result: null },
        discrepancy: null
      }
    };
  }

  if (run.status !== "executed" && run.status !== "completed") {
    // Genuinely unreachable from resumeAgentLoopRunAfterApproval (it only
    // ever returns one of the five statuses handled above/below) -- an
    // honest, non-crashing fallback rather than silently treating an
    // unrecognized status as success.
    const message = `Unexpected agent loop run status "${run.status}" after execution.`;
    runtime.logActivity("note", "Execution outcome unclear", message);
    return { status: "error", error: { kind: "execution_failed", message } };
  }

  // run.status is "executed" or "completed" -- executeTool genuinely
  // succeeded (ExecutionResult's own doc comment: outcome "succeeded" is
  // only ever set from a real ToolResult, never assumed).
  const output = (run.executionResult?.toolResult?.output as { propertyChanges?: unknown[] } | undefined) ?? {};
  runtime.logActivity("recommendation", "Executed", `"${proposal.toolName}" applied successfully.`);
  if (run.discrepancy?.detected) {
    runtime.logActivity("note", "Discrepancy detected", run.discrepancy.description);
  }

  // Deterministic verification -- built from what was ACTUALLY requested,
  // never Gemini's opinion of whether it worked. A SEPARATE, complementary
  // signal from run.discrepancy: this checks a specific property against a
  // specific expected value; discrepancy checks the target entity actually
  // changed AT ALL. Neither one substitutes for the other.
  const { verificationStatus, verificationResults, verificationChecks, objectiveStatus, objectiveResult } = await verifyExecutedProposal(runtime, proposal);

  return {
    status: "success",
    report: {
      execution: { status: "success", message: "Execution completed.", checkpointId: checkpoint.id, propertyChanges: output.propertyChanges ?? [] },
      verification: { status: verificationStatus, results: verificationResults, checks: verificationChecks },
      objective: { status: objectiveStatus, result: objectiveResult },
      discrepancy: run.discrepancy
    }
  };
}

async function verifyExecutedProposal(
  runtime: ProjectRuntime,
  proposal: Proposal
): Promise<{
  verificationStatus: VerificationStatus;
  verificationResults: VerificationResult[];
  verificationChecks: Check[];
  objectiveStatus: ObjectiveStatus;
  objectiveResult: ObjectiveSatisfactionResult | null;
}> {
  const notRun = {
    verificationStatus: "not_run" as VerificationStatus,
    verificationResults: [],
    verificationChecks: [] as Check[],
    objectiveStatus: "unknown" as ObjectiveStatus,
    objectiveResult: null
  };

  if (proposal.toolName !== "modify_environment_object" || typeof proposal.input !== "object" || proposal.input === null) return notRun;
  const input = proposal.input as { objectId?: unknown; propertyKey?: unknown; value?: unknown };
  if (typeof input.objectId !== "string" || typeof input.propertyKey !== "string") return notRun;

  const isNumeric = typeof input.value === "number";
  const checkInput = isNumeric
    ? {
        kind: "numeric_comparison" as const,
        description: `${input.propertyKey} equals the requested value after execution`,
        objectId: input.objectId,
        property: input.propertyKey,
        operator: "eq" as const,
        expectedValue: input.value,
        expectedUnit: null,
        tolerance: 0.001
      }
    : {
        kind: "property_required" as const,
        description: `${input.propertyKey} is set after execution`,
        objectId: input.objectId,
        property: input.propertyKey,
        requireNonNull: true
      };

  const checkExec = await executeTool(runtime.registry, { toolName: "create_check", input: checkInput, source: "agent", target: null, authorize: authorizerFor(runtime) });
  if (checkExec.result.status !== "success") {
    runtime.logActivity("note", "Could not define a verification check", checkExec.result.error?.message ?? "unknown error");
    return notRun;
  }
  const check = (checkExec.result.output as { check: Check }).check;

  const verifyExec = await executeTool(runtime.registry, { toolName: "run_verification", input: { checkId: check.id }, source: "agent", target: null, authorize: authorizerFor(runtime) });
  if (verifyExec.result.status !== "success") {
    runtime.logActivity("note", "Verification could not run", verifyExec.result.error?.message ?? "unknown error");
    return notRun;
  }
  const result = (verifyExec.result.output as { result: VerificationResult }).result;
  const verificationStatus: VerificationStatus = result.status === "pass" ? "passed" : result.status === "fail" ? "failed" : "inconclusive";
  runtime.logActivity("verification", verificationStatus === "passed" ? "Verification passed" : "Verification result", result.message);

  const objectiveExec = await executeTool(runtime.registry, {
    toolName: "evaluate_objective_satisfaction",
    input: { conditions: [{ checkId: check.id, requirementId: null, constraintId: null, required: true, verificationResultId: result.id }] },
    source: "agent",
    target: null,
    authorize: authorizerFor(runtime)
  });
  if (objectiveExec.result.status !== "success") {
    return { verificationStatus, verificationResults: [result], verificationChecks: [check], objectiveStatus: "unknown", objectiveResult: null };
  }
  const objectiveResult = (objectiveExec.result.output as { result: ObjectiveSatisfactionResult }).result;
  const objectiveStatus: ObjectiveStatus = objectiveResult.status === "satisfied" ? "satisfied" : objectiveResult.status === "not_satisfied" ? "not_satisfied" : "unknown";
  runtime.logActivity("verification", "Objective evaluated", objectiveResult.reason);

  return { verificationStatus, verificationResults: [result], verificationChecks: [check], objectiveStatus, objectiveResult };
}

/** A standalone re-verification of an existing Check -- Part 10's
 * `POST /projects/:id/verify`, independent of the execute-embedded
 * verification above (e.g. "verify again after something else changed"). */
export async function verifyExistingCheck(runtime: ProjectRuntime, checkId: string): Promise<{ status: "success"; result: VerificationResult } | { status: "error"; error: WorkflowFailure }> {
  const executed = await executeTool(runtime.registry, { toolName: "run_verification", input: { checkId }, source: "agent", target: null, authorize: authorizerFor(runtime) });
  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Verification failed.";
    runtime.logActivity("note", "Verification failed", message);
    return { status: "error", error: { kind: "verification_failed", message } };
  }
  const result = (executed.result.output as { result: VerificationResult }).result;
  runtime.logActivity("verification", "Verified", result.message);
  return { status: "success", result };
}

// ---- PART 9: Rollback --------------------------------------------------------

export interface RollbackOutcome {
  status: "success" | "error";
  mismatchDetected?: boolean;
  warnings?: string[];
  error?: WorkflowFailure;
}

/**
 * The human clicking "Restore previous state" IS the authorization
 * decision for this one action -- the same single-gesture-as-approval
 * pattern this app already uses for Approve/Reject on a Proposal. A REAL
 * `Approval` record is still created (targeting `restore_checkpoint`, tied
 * to no proposal -- a legitimate, documented case per `Approval.
 * proposalId`'s own doc comment) and still independently re-verified by
 * `executeTool`'s `authorize` hook; this is not a bypass of P4.
 */
export async function rollbackToCheckpoint(runtime: ProjectRuntime, checkpointId: string, reason?: string): Promise<RollbackOutcome> {
  const checkpoint = runtime.checkpointStore.getById(checkpointId);
  if (!checkpoint) return { status: "error", error: { kind: "checkpoint_not_found", message: `No checkpoint with id "${checkpointId}" exists.` } };
  if (checkpoint.projectId !== runtime.projectId) {
    return { status: "error", error: { kind: "cross_project_forbidden", message: `Checkpoint "${checkpointId}" belongs to a different project.` } };
  }

  const approval = runtime.approvals.create({
    toolName: "restore_checkpoint",
    targetType: null,
    targetId: null,
    proposalId: null,
    reason: reason ?? `Rollback to checkpoint "${checkpointId}"`,
    requestedBy: "human",
    expiresAt: null,
    metadata: {}
  });
  runtime.approvals.approve(approval.id, "human", reason);

  if (checkpoint.environmentSnapshot) {
    try {
      await ensureEnvironmentSession(runtime);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.logActivity("note", "Rollback failed", message);
      return { status: "error", error: { kind: "environment_unavailable", message } };
    }
  }

  let approvalDecision: AuthorizationDecision | undefined;
  const executed = await executeTool(runtime.registry, {
    toolName: "restore_checkpoint",
    input: { checkpointId, reason: reason ?? null },
    source: "human",
    target: null,
    authorize: authorizerFor(runtime, (decision) => {
      approvalDecision = decision;
    })
  });

  if (executed.result.status === "error") {
    const message = executed.result.error?.message ?? "Rollback failed.";
    runtime.logActivity("note", "Rollback failed", message);
    return { status: "error", error: { kind: "rollback_failed", message } };
  }

  if (approvalDecision?.matchedApprovalId) {
    runtime.approvals.consume(approvalDecision.matchedApprovalId);
  }

  const output = executed.result.output as { mismatchDetected: boolean; warnings: string[] };
  runtime.logActivity("recommendation", "Rolled back", `Restored checkpoint "${checkpointId}".${output.mismatchDetected ? " A mismatch was detected during re-observation." : ""}`);
  return { status: "success", mismatchDetected: output.mismatchDetected, warnings: output.warnings };
}
