import type { EntitySource, Proposal } from "@naqsh/schemas";
import type { ApprovalStore, CreateApprovalInput } from "./approval-store.js";

/**
 * The Phase 11 seam between a `Proposal` (P10) and P4's existing
 * `ApprovalStore`: requests an approval EXPLICITLY tied to one proposal via
 * `Approval.proposalId`. This is deliberately a thin wrapper, not a new
 * approval mechanism -- `ApprovalStore.create`/`approve`/`reject`/`revoke`/
 * `consume` are unmodified and used exactly as P4 built them; the only
 * thing this function adds is populating `proposalId` and deriving
 * `toolName`/`targetType`/`targetId`/`reason` from the proposal itself
 * rather than requiring a caller to repeat them by hand (and risk a typo
 * that silently decouples the approval from what it was actually meant to
 * authorize).
 */
export interface RequestProposalApprovalOptions {
  requestedBy?: EntitySource;
  expiresAt?: string | null;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export function requestProposalApproval(
  approvals: ApprovalStore,
  proposal: Proposal,
  options: RequestProposalApprovalOptions = {}
) {
  const input: CreateApprovalInput = {
    toolName: proposal.toolName,
    targetType: proposal.target?.entityType ?? null,
    targetId: proposal.target?.entityId ?? null,
    proposalId: proposal.id,
    reason: options.reason ?? proposal.rationale,
    requestedBy: options.requestedBy ?? "agent",
    expiresAt: options.expiresAt ?? null,
    metadata: options.metadata ?? {}
  };
  return approvals.create(input);
}
