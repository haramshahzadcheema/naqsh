import { AuthorizationError, WorldModelValidationError, createApproval, type Approval, type ApprovalInput, type EntitySource } from "@naqsh/schemas";

export type CreateApprovalInput = Pick<
  ApprovalInput,
  "toolName" | "targetType" | "targetId" | "proposalId" | "reason" | "requestedBy" | "expiresAt" | "metadata"
>;

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
  /** Throws AuthorizationError("not_found") for a missing id, or
   * AuthorizationError("invalid_state_transition") for a decided/consumed
   * one — not ToolError, since no tool execution is involved. */
  approve(id: string, decidedBy: EntitySource, reason?: string): Approval;
  reject(id: string, decidedBy: EntitySource, reason?: string): Approval;
  revoke(id: string, decidedBy: EntitySource, reason?: string): Approval;
  /** Marks an approved, unconsumed, unexpired approval as consumed.
   * evaluateToolAuthorization calls this (via the caller, after a
   * successful execution) — see authorization.ts. */
  consume(id: string): Approval;
  serialize(): string;
}

function requireApproval(approvals: Map<string, Approval>, id: string): Approval {
  const approval = approvals.get(id);
  if (!approval) {
    throw new AuthorizationError("not_found", `No approval with id "${id}" exists`);
  }
  return approval;
}

/** Builds an `ApprovalStore` around an already-populated `Map` -- the one
 * implementation both `createApprovalStore` (starts empty) and
 * `deserializeApprovalStore` (starts pre-populated from validated JSON)
 * share, matching `background-job-store.ts`'s identical `buildStore`
 * precedent. */
function buildStore(approvals: Map<string, Approval>): ApprovalStore {
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
        throw new AuthorizationError("invalid_state_transition", `Approval "${id}" is already ${current.status}, cannot approve`);
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
        throw new AuthorizationError("invalid_state_transition", `Approval "${id}" is already ${current.status}, cannot reject`);
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
        throw new AuthorizationError("invalid_state_transition", `Approval "${id}" is not approved, cannot revoke`);
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
        throw new AuthorizationError("invalid_state_transition", `Approval "${id}" is not approved, cannot consume`);
      }
      if (current.consumedAt !== null) {
        throw new AuthorizationError("invalid_state_transition", `Approval "${id}" was already consumed`);
      }
      const updated = createApproval({ ...current, consumedAt: new Date().toISOString() });
      approvals.set(id, updated);
      return updated;
    },
    serialize: () => JSON.stringify(Array.from(approvals.values()))
  };
}

export function createApprovalStore(): ApprovalStore {
  return buildStore(new Map());
}

/** Rebuilds an `ApprovalStore` from `serialize()`'s output, matching
 * `deserializeBackgroundJobStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent -- each entry is re-validated
 * through `createApproval` before being trusted. */
export function deserializeApprovalStore(serialized: string): ApprovalStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized approval store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized approval store must be an array");
  }
  const approvals = new Map<string, Approval>();
  for (const entry of parsed as Approval[]) {
    const validated = createApproval(entry);
    approvals.set(validated.id, validated);
  }
  return buildStore(approvals);
}
