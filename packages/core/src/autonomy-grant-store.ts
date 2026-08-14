import {
  createAutonomyGrant,
  ToolError,
  type AutonomyGrant,
  type AutonomyGrantInput,
  type EntitySource
} from "@naqsh/schemas";

export type CreateAutonomyGrantInput = Pick<
  AutonomyGrantInput,
  "toolNames" | "targetType" | "targetId" | "reason" | "grantedBy" | "expiresAt" | "maxUses" | "metadata"
>;

/**
 * Deterministic, in-memory store for AutonomyGrant records — the
 * AUTONOMOUS autonomy level's authorization source. A grant is
 * fundamentally different from an Approval: it authorizes MULTIPLE future
 * calls (bounded by expiresAt/maxUses), not one. `recordUse` is a
 * separate, explicit step from evaluation — evaluateToolAuthorization
 * (authorization.ts) never mutates a grant itself, matching "authorization
 * decisions [stay] deterministic" and "execution separate from
 * authorization": deciding whether a grant covers a call and consuming
 * one use of it are two different operations.
 */
export interface AutonomyGrantStore {
  /** Always starts "active". */
  create(input: CreateAutonomyGrantInput): AutonomyGrant;
  getById(id: string): AutonomyGrant | undefined;
  listActive(): readonly AutonomyGrant[];
  list(): readonly AutonomyGrant[];
  revoke(id: string, reason?: string): AutonomyGrant;
  /** Increments useCount by one. Throws if the grant is revoked, expired,
   * or already at maxUses -- callers should only call this after
   * evaluateToolAuthorization has already confirmed the grant covers the
   * call, but this guards against a stale reference being reused anyway. */
  recordUse(id: string): AutonomyGrant;
}

function requireGrant(grants: Map<string, AutonomyGrant>, id: string): AutonomyGrant {
  const grant = grants.get(id);
  if (!grant) {
    throw new ToolError("execution_failure", `No autonomy grant with id "${id}" exists`);
  }
  return grant;
}

function isExpired(grant: AutonomyGrant, now: Date): boolean {
  return grant.expiresAt !== null && new Date(grant.expiresAt).getTime() <= now.getTime();
}

export function createAutonomyGrantStore(): AutonomyGrantStore {
  const grants = new Map<string, AutonomyGrant>();

  return {
    create(input) {
      const grant = createAutonomyGrant({ ...input, status: "active" });
      grants.set(grant.id, grant);
      return grant;
    },
    getById: (id) => grants.get(id),
    listActive: () => {
      const now = new Date();
      return Array.from(grants.values()).filter((grant) => grant.status === "active" && !isExpired(grant, now));
    },
    list: () => Array.from(grants.values()),
    revoke(id, reason) {
      const current = requireGrant(grants, id);
      const updated = createAutonomyGrant({
        ...current,
        status: "revoked",
        reason: reason ?? current.reason,
        revokedAt: new Date().toISOString()
      });
      grants.set(id, updated);
      return updated;
    },
    recordUse(id) {
      const current = requireGrant(grants, id);
      if (current.status !== "active") {
        throw new ToolError("execution_failure", `Autonomy grant "${id}" is not active`);
      }
      if (isExpired(current, new Date())) {
        throw new ToolError("execution_failure", `Autonomy grant "${id}" has expired`);
      }
      if (current.maxUses !== null && current.useCount >= current.maxUses) {
        throw new ToolError("execution_failure", `Autonomy grant "${id}" has reached its maximum uses`);
      }
      const updated = createAutonomyGrant({ ...current, useCount: current.useCount + 1 });
      grants.set(id, updated);
      return updated;
    }
  };
}
