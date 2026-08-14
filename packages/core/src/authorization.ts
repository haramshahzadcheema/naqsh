import {
  AUTONOMY_LEVELS,
  createAuthorizationDecision,
  type AuthorizationDecision,
  type AuthorizationDenialReason,
  type AutonomyLevel,
  type ChangeTarget,
  type EntitySource,
  type Tool,
  type ToolMutationKind
} from "@naqsh/schemas";
import type { ApprovalStore } from "./approval-store.js";
import type { AutonomyGrantStore } from "./autonomy-grant-store.js";
import type { ToolAuthorizationContext, ToolAuthorizationOutcome } from "./execute-tool.js";

/**
 * The minimum AutonomyLevel required to invoke a tool of this mutation
 * classification. `observe`/`suggest`/`verify` tools never mutate World
 * Model state, so none of them require anything beyond the matching
 * baseline level; only `mutate` requires the elevated levels where
 * Approval/AutonomyGrant checking applies. This is a deliberate, documented
 * design choice, not the only possible one -- see the P4 report for why
 * `verify` is grouped with `suggest` rather than `observe`.
 */
const MINIMUM_LEVEL_FOR_MUTATION: Record<ToolMutationKind, AutonomyLevel> = {
  observe: "observe",
  suggest: "suggest",
  verify: "suggest",
  mutate: "approved_modify"
};

function levelRank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

function isAutonomyLevel(value: string): value is AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

interface TargetScope {
  targetType: string | null;
  targetId: string | null;
}

/** Shared target-matching rule for both Approval and AutonomyGrant: `null`
 * targetType covers any target; a set targetType with `null` targetId
 * covers any target of that type; both set requires an exact match. */
function coversTarget(scope: TargetScope, target: ChangeTarget | null): boolean {
  if (scope.targetType === null) return true;
  if (target === null) return false;
  if (scope.targetType !== target.entityType) return false;
  if (scope.targetId === null) return true;
  return scope.targetId === target.entityId;
}

/** 0 = covers any target, 1 = scoped to a target type, 2 = scoped to one
 * exact target. Used to pick the MOST SPECIFIC covering approval/grant
 * when more than one matches, not merely the first one found -- otherwise
 * a broad approved scope could authorize a call even when a narrower,
 * explicitly REJECTED approval exists for that exact target, which is
 * backwards for a permission system (specific denials/approvals should
 * always be able to override a broader default, never be shadowed by it). */
function specificity(scope: TargetScope): number {
  if (scope.targetType === null) return 0;
  if (scope.targetId === null) return 1;
  return 2;
}

/** Stable sort: Array.prototype.sort has been spec-guaranteed stable since
 * ES2019, so candidates tied on specificity keep their original (creation)
 * order -- the earliest-created one among equally-specific matches wins,
 * a simple and deterministic tie-break. */
function pickMostSpecific<T extends TargetScope>(candidates: T[]): T {
  return candidates.sort((a, b) => specificity(b) - specificity(a))[0] as T;
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

interface Denial {
  allowed: false;
  denialReason: AuthorizationDenialReason;
  message: string;
}

interface Allowed {
  allowed: true;
  matchedApprovalId: string | null;
  matchedAutonomyGrantId: string | null;
  message: string;
}

function deny(denialReason: AuthorizationDenialReason, message: string): Denial {
  return { allowed: false, denialReason, message };
}

function allow(message: string, matched: { approvalId?: string; grantId?: string } = {}): Allowed {
  return {
    allowed: true,
    matchedApprovalId: matched.approvalId ?? null,
    matchedAutonomyGrantId: matched.grantId ?? null,
    message
  };
}

function evaluateApproval(tool: Tool, target: ChangeTarget | null, approvals: ApprovalStore): Denial | Allowed {
  const forTool = approvals.listForTool(tool.name);
  if (forTool.length === 0) {
    return deny("approval_not_found", `No approval exists for tool "${tool.name}"`);
  }
  const forTarget = forTool.filter((approval) => coversTarget(approval, target));
  if (forTarget.length === 0) {
    return deny(
      "approval_target_mismatch",
      `An approval exists for tool "${tool.name}" but none cover the requested target`
    );
  }
  const approval = pickMostSpecific(forTarget);
  if (approval.status === "pending") {
    return deny("approval_required", `Approval "${approval.id}" for "${tool.name}" is still pending`);
  }
  if (approval.status === "rejected") {
    return deny("approval_rejected", `Approval "${approval.id}" for "${tool.name}" was rejected`);
  }
  if (approval.status === "revoked") {
    return deny("approval_revoked", `Approval "${approval.id}" for "${tool.name}" was revoked`);
  }
  if (approval.consumedAt !== null) {
    return deny("approval_already_consumed", `Approval "${approval.id}" was already used`);
  }
  if (isExpired(approval.expiresAt, new Date())) {
    return deny("approval_expired", `Approval "${approval.id}" for "${tool.name}" has expired`);
  }
  return allow(`Approval "${approval.id}" authorizes this call`, { approvalId: approval.id });
}

function evaluateAutonomyGrant(
  tool: Tool,
  target: ChangeTarget | null,
  autonomyGrants: AutonomyGrantStore
): Denial | Allowed {
  const forTool = autonomyGrants.list().filter((grant) => grant.toolNames.includes(tool.name));
  if (forTool.length === 0) {
    return deny("autonomy_grant_not_found", `No autonomy grant covers tool "${tool.name}"`);
  }
  const forTarget = forTool.filter((grant) => coversTarget(grant, target));
  if (forTarget.length === 0) {
    return deny(
      "autonomy_grant_target_mismatch",
      `An autonomy grant covers tool "${tool.name}" but none cover the requested target`
    );
  }
  const grant = pickMostSpecific(forTarget);
  if (grant.status === "revoked") {
    return deny("autonomy_grant_revoked", `Autonomy grant "${grant.id}" for "${tool.name}" was revoked`);
  }
  if (isExpired(grant.expiresAt, new Date())) {
    return deny("autonomy_grant_expired", `Autonomy grant "${grant.id}" for "${tool.name}" has expired`);
  }
  if (grant.maxUses !== null && grant.useCount >= grant.maxUses) {
    return deny("autonomy_grant_exhausted", `Autonomy grant "${grant.id}" has reached its maximum uses`);
  }
  return allow(`Autonomy grant "${grant.id}" authorizes this call`, { grantId: grant.id });
}

export interface EvaluateToolAuthorizationInput {
  tool: Tool;
  target: ChangeTarget | null;
  source: EntitySource;
  requestId: string;
  autonomyLevel: string;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
}

/**
 * THE deterministic authorization decision function: given a tool, its
 * classification, the current autonomy level, and the current state of
 * the approval/grant stores, decides allow/deny and WHY. Pure with respect
 * to its inputs (same tool + target + level + store contents always
 * produces the same decision) — it reads store state but never writes it;
 * consuming an Approval or recording an AutonomyGrant use is a separate,
 * explicit step the caller takes after a successful execution (see
 * ApprovalStore.consume / AutonomyGrantStore.recordUse). This is what
 * keeps "authorization decisions deterministic" and "execution separate
 * from authorization" both literally true, not just aspirational.
 *
 * Never consults an LLM. The LLM may have generated the ToolRequest this
 * evaluates; it has no say in whether it's permitted.
 */
export function evaluateToolAuthorization(input: EvaluateToolAuthorizationInput): AuthorizationDecision {
  const { tool, target, source, requestId, autonomyLevel, approvals, autonomyGrants } = input;

  const outcome: Denial | Allowed = !isAutonomyLevel(autonomyLevel)
    ? deny("unknown_autonomy_level", `"${autonomyLevel}" is not a recognized autonomy level`)
    : levelRank(autonomyLevel) < levelRank(MINIMUM_LEVEL_FOR_MUTATION[tool.mutation])
      ? deny(
          "insufficient_autonomy_level",
          `Tool "${tool.name}" (${tool.mutation}) requires at least autonomy level "${MINIMUM_LEVEL_FOR_MUTATION[tool.mutation]}", current level is "${autonomyLevel}"`
        )
      : tool.mutation !== "mutate"
        ? allow(`Tool "${tool.name}" (${tool.mutation}) requires no approval at autonomy level "${autonomyLevel}"`)
        : autonomyLevel === "autonomous"
          ? evaluateAutonomyGrant(tool, target, autonomyGrants)
          : evaluateApproval(tool, target, approvals);

  return createAuthorizationDecision({
    toolName: tool.name,
    target,
    autonomyLevel,
    source,
    requestId,
    allowed: outcome.allowed,
    denialReason: outcome.allowed ? null : outcome.denialReason,
    message: outcome.message,
    matchedApprovalId: outcome.allowed ? outcome.matchedApprovalId : null,
    matchedAutonomyGrantId: outcome.allowed ? outcome.matchedAutonomyGrantId : null
  });
}

export interface CreateExecuteToolAuthorizerConfig {
  autonomyLevel: AutonomyLevel;
  approvals: ApprovalStore;
  autonomyGrants: AutonomyGrantStore;
  /** Optional audit hook: called with every decision, allowed or denied,
   * before it's translated into the boolean/reason executeTool needs. This
   * is the "Audit/change event" step of the P4 flow diagram -- P4 does not
   * persist decisions itself (no logging system), but nothing stops a
   * caller from appending them to their own store via this hook. */
  onDecision?: (decision: AuthorizationDecision) => void;
}

/**
 * Adapts `evaluateToolAuthorization` into the shape `executeTool`'s
 * `authorize` hook expects. This is the ONE integration point between P4
 * and P3 -- executeTool itself is completely unmodified in behavior
 * beyond the `target` field threading added alongside this phase; it still
 * has no idea AutonomyLevel/Approval/AutonomyGrant exist.
 */
export function createExecuteToolAuthorizer(
  config: CreateExecuteToolAuthorizerConfig
): (context: ToolAuthorizationContext) => ToolAuthorizationOutcome {
  return (context) => {
    const decision = evaluateToolAuthorization({
      tool: context.tool,
      target: context.target,
      source: context.source,
      requestId: context.requestId,
      autonomyLevel: config.autonomyLevel,
      approvals: config.approvals,
      autonomyGrants: config.autonomyGrants
    });
    config.onDecision?.(decision);
    return { allowed: decision.allowed, reason: decision.message };
  };
}
