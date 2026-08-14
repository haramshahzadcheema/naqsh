import { createApproval, ToolError, type Approval, type ApprovalInput, type EntitySource } from "@naqsh/schemas";

export type CreateApprovalInput = Pick<ApprovalInput, "toolName" | "targetType" | "targetId" | "reason" | "requestedBy" | "expiresAt" | "metadata">;

/**
 * Deterministic, in-memory store for Approval records — the APPROVED_MODIFY
 * autonomy level's authorization source. Every transition (approve/reject/
 * revoke/consume) replaces the stored record with a new frozen snapshot
 * (via createApproval); this store never hands out a mutable reference.
 *
 * No persistence here by design, matching ChangeHistory/ToolRegistry's own
 * P2/P3 precedent: this is the seam, not the infrastructure.
 */
export interface ApprovalStore {
  /** Always starts "pending". */
  create(input: CreateApprovalInput): Approval;
  getById(id: string): Approval | undefined;
  listForTool(toolName: string): readonly Approval[];
  list(): readonly Approval[];
  /** Throws ToolError("unknown_tool")-shaped errors are NOT used here —
   * these throw a plain ToolError with kind "execution_failure" for a
   * missing/already-decided id, since acting on a nonexistent or
   * already-resolved approval is a caller/programmer error, not a
   * tool-execution outcome. */
  approve(id: string, decidedBy: EntitySource, reason?: string): Approval;
  reject(id: string, decidedBy: EntitySource, reason?: string): Approval;
  revoke(id: string, decidedBy: EntitySource, reason?: string): Approval;
  /** Marks an approved, unconsumed, unexpired approval as consumed.
   * evaluateToolAuthorization calls this (via the caller, after a
   * successful execution) — see authorization.ts. */
  consume(id: string): Approval;
}

function requireApproval(approvals: Map<string, Approval>, id: string): Approval {
  const approval = approvals.get(id);
  if (!approval) {
    throw new ToolError("execution_failure", `No approval with id "${id}" exists`);
  }
  return approval;
}

export function createApprovalStore(): ApprovalStore {
  const approvals = new Map<string, Approval>();

  return {
    create(input) {
      const approval = createApproval({ ...input, status: "pending" });
      approvals.set(approval.id, approval);
      return approval;
    },
    getById: (id) => approvals.get(id),
    listForTool: (toolName) => Array.from(approvals.values()).filter((approval) => approval.toolName === toolName),
    list: () => Array.from(approvals.values()),
    approve(id, decidedBy, reason) {
      const current = requireApproval(approvals, id);
      if (current.status !== "pending") {
        throw new ToolError("execution_failure", `Approval "${id}" is already ${current.status}, cannot approve`);
      }
      const updated = createApproval({
        ...current,
        status: "approved",
        decidedBy,
        reason: reason ?? current.reason,
        respondedAt: new Date().toISOString()
      });
      approvals.set(id, updated);
      return updated;
    },
    reject(id, decidedBy, reason) {
      const current = requireApproval(approvals, id);
      if (current.status !== "pending") {
        throw new ToolError("execution_failure", `Approval "${id}" is already ${current.status}, cannot reject`);
      }
      const updated = createApproval({
        ...current,
        status: "rejected",
        decidedBy,
        reason: reason ?? current.reason,
        respondedAt: new Date().toISOString()
      });
      approvals.set(id, updated);
      return updated;
    },
    revoke(id, decidedBy, reason) {
      const current = requireApproval(approvals, id);
      if (current.status !== "approved") {
        throw new ToolError("execution_failure", `Approval "${id}" is not approved, cannot revoke`);
      }
      const updated = createApproval({
        ...current,
        status: "revoked",
        decidedBy,
        reason: reason ?? current.reason,
        respondedAt: current.respondedAt ?? new Date().toISOString()
      });
      approvals.set(id, updated);
      return updated;
    },
    consume(id) {
      const current = requireApproval(approvals, id);
      if (current.status !== "approved") {
        throw new ToolError("execution_failure", `Approval "${id}" is not approved, cannot consume`);
      }
      if (current.consumedAt !== null) {
        throw new ToolError("execution_failure", `Approval "${id}" was already consumed`);
      }
      const updated = createApproval({ ...current, consumedAt: new Date().toISOString() });
      approvals.set(id, updated);
      return updated;
    }
  };
}
