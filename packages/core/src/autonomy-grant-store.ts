import {
  AuthorizationError,
  createAutonomyGrant,
  WorldModelValidationError,
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
  /** `revokedBy` is required, not optional -- mirrors ApprovalStore's
   * approve/reject/revoke, which all require `decidedBy`. A revocation
   * with no recorded actor would be an unauditable state transition. */
  revoke(id: string, revokedBy: EntitySource, reason?: string): AutonomyGrant;
  /** Increments useCount by one. Throws AuthorizationError
   * ("invalid_state_transition") if the grant is revoked, expired, or
   * already at maxUses -- callers should only call this after
   * evaluateToolAuthorization has already confirmed the grant covers the
   * call, but this guards against a stale reference being reused anyway. */
  recordUse(id: string): AutonomyGrant;
  serialize(): string;
}

function requireGrant(grants: Map<string, AutonomyGrant>, id: string): AutonomyGrant {
  const grant = grants.get(id);
  if (!grant) {
    throw new AuthorizationError("not_found", `No autonomy grant with id "${id}" exists`);
  }
  return grant;
}

function isExpired(grant: AutonomyGrant, now: Date): boolean {
  return grant.expiresAt !== null && new Date(grant.expiresAt).getTime() <= now.getTime();
}

/** Builds an `AutonomyGrantStore` around an already-populated `Map` -- the
 * one implementation both `createAutonomyGrantStore` (starts empty) and
 * `deserializeAutonomyGrantStore` (starts pre-populated from validated
 * JSON) share, matching `background-job-store.ts`'s identical
 * `buildStore` precedent. */
function buildStore(grants: Map<string, AutonomyGrant>): AutonomyGrantStore {
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
    revoke(id, revokedBy, reason) {
      const current = requireGrant(grants, id);
      const updated = createAutonomyGrant({
        ...current,
        status: "revoked",
        reason: reason ?? current.reason,
        revokedAt: new Date().toISOString(),
        revokedBy
      });
      grants.set(id, updated);
      return updated;
    },
    recordUse(id) {
      const current = requireGrant(grants, id);
      if (current.status !== "active") {
        throw new AuthorizationError("invalid_state_transition", `Autonomy grant "${id}" is not active`);
      }
      if (isExpired(current, new Date())) {
        throw new AuthorizationError("invalid_state_transition", `Autonomy grant "${id}" has expired`);
      }
      if (current.maxUses !== null && current.useCount >= current.maxUses) {
        throw new AuthorizationError("invalid_state_transition", `Autonomy grant "${id}" has reached its maximum uses`);
      }
      const updated = createAutonomyGrant({ ...current, useCount: current.useCount + 1 });
      grants.set(id, updated);
      return updated;
    },
    serialize: () => JSON.stringify(Array.from(grants.values()))
  };
}

export function createAutonomyGrantStore(): AutonomyGrantStore {
  return buildStore(new Map());
}

/** Rebuilds an `AutonomyGrantStore` from `serialize()`'s output, matching
 * `deserializeBackgroundJobStore`'s identical "never silently trust a
 * hand-edited/corrupted log" precedent -- each entry is re-validated
 * through `createAutonomyGrant` before being trusted. */
export function deserializeAutonomyGrantStore(serialized: string): AutonomyGrantStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized autonomy grant store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized autonomy grant store must be an array");
  }
  const grants = new Map<string, AutonomyGrant>();
  for (const entry of parsed as AutonomyGrant[]) {
    const validated = createAutonomyGrant(entry);
    grants.set(validated.id, validated);
  }
  return buildStore(grants);
}
