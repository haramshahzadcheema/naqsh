import { createClarification, WorldModelValidationError, type Clarification } from "@naqsh/schemas";

/**
 * Deterministic, in-memory store for `Clarification` records (P19) --
 * mirrors `ApprovalStore`'s (P4) exact shape: a plain `Map` behind a typed
 * interface, MUTABLE-IN-PLACE (unlike `CheckStore`/`ObjectiveSatisfactionStore`,
 * which are immutable-once-created), because a `Clarification`'s status
 * genuinely transitions over its lifecycle (`pending` -> `answered` /
 * `dismissed` / `superseded`), exactly like an `Approval`'s does. Every
 * transition replaces the stored record with a new frozen snapshot (via
 * `createClarification`); this store never hands out a mutable reference.
 *
 * NOT part of `WorldModelState` -- a `Clarification` is a process/audit
 * record about a `RequirementCandidate` that is ITSELF not part of
 * `WorldModelState` (P18 never persists a candidate; a `Clarification`
 * embeds the full candidate in `candidateSnapshot` for exactly this
 * reason). The one canonical project state remains `WorldModelState`;
 * this store no more competes with it than `ApprovalStore`/`CheckStore`/
 * `VerificationResultStore` do.
 *
 * No persistence here by design, matching every prior store's identical
 * P2/P3 precedent: this is the seam, not the infrastructure.
 */
export interface ClarificationStore {
  /** Always starts "pending" -- rejects an input that already claims a
   * different status (use `answer`/`dismiss`/`supersede` for those
   * transitions instead of constructing a pre-resolved record). */
  save(clarification: Clarification): void;
  getById(id: string): Clarification | undefined;
  listForCandidate(requirementCandidateId: string): readonly Clarification[];
  list(): readonly Clarification[];
  /** Throws `WorldModelValidationError` for a missing id or a clarification
   * that isn't currently `"pending"` -- an answer/dismissal/supersession
   * can only ever apply once, exactly like `Approval.approve` can only
   * apply to a still-pending approval. */
  answer(id: string, answerText: string): Clarification;
  dismiss(id: string, reason?: string): Clarification;
  supersede(id: string, supersededById: string): Clarification;
  serialize(): string;
}

function requireClarification(clarifications: Map<string, Clarification>, id: string): Clarification {
  const clarification = clarifications.get(id);
  if (!clarification) {
    throw new WorldModelValidationError("invalid_shape", `No clarification with id "${id}" exists`);
  }
  return clarification;
}

function requirePending(clarification: Clarification): void {
  if (clarification.status !== "pending") {
    throw new WorldModelValidationError(
      "invalid_shape",
      `Clarification "${clarification.id}" is already "${clarification.status}", cannot transition it again`
    );
  }
}

/** Builds a `ClarificationStore` around an already-populated `Map` -- the
 * one implementation both `createClarificationStore` (starts empty) and
 * `deserializeClarificationStore` (starts pre-populated from validated
 * JSON) share, so the lifecycle-transition logic exists in exactly one
 * place. */
function buildStore(clarifications: Map<string, Clarification>): ClarificationStore {
  return {
    save(clarification) {
      if (clarification.status !== "pending") {
        throw new WorldModelValidationError("invalid_shape", `A new clarification must be saved as "pending", got "${clarification.status}"`);
      }
      if (clarifications.has(clarification.id)) {
        throw new WorldModelValidationError("invalid_shape", `Clarification "${clarification.id}" already exists`);
      }
      clarifications.set(clarification.id, clarification);
    },
    getById: (id) => clarifications.get(id),
    listForCandidate: (requirementCandidateId) =>
      Array.from(clarifications.values()).filter((clarification) => clarification.requirementCandidateId === requirementCandidateId),
    list: () => Array.from(clarifications.values()),
    answer(id, answerText) {
      const current = requireClarification(clarifications, id);
      requirePending(current);
      const updated = createClarification({ ...current, status: "answered", answerText, answeredAt: new Date().toISOString() });
      clarifications.set(id, updated);
      return updated;
    },
    dismiss(id, reason) {
      const current = requireClarification(clarifications, id);
      requirePending(current);
      // `reason` on the RECORD documents WHY the clarification was asked
      // in the first place -- it must never be overwritten by why it was
      // later dismissed (that would destroy the original provenance the
      // brief's own Step 16 explicitly protects). A dismissal rationale,
      // when given, is recorded separately in `metadata.dismissalReason`.
      const updated = createClarification({
        ...current,
        status: "dismissed",
        metadata: reason ? { ...current.metadata, dismissalReason: reason } : current.metadata
      });
      clarifications.set(id, updated);
      return updated;
    },
    supersede(id, supersededById) {
      const current = requireClarification(clarifications, id);
      requirePending(current);
      const updated = createClarification({ ...current, status: "superseded", supersededBy: supersededById });
      clarifications.set(id, updated);
      return updated;
    },
    serialize: () => JSON.stringify(Array.from(clarifications.values()))
  };
}

export function createClarificationStore(): ClarificationStore {
  return buildStore(new Map());
}

/** Rebuilds a `ClarificationStore` from `serialize()`'s output, matching
 * `deserializeCheckStore`'s identical "never silently trust a hand-edited/
 * corrupted log" precedent. Populates the map directly (not via `.save()`,
 * which rejects non-"pending" records) since a serialized store may
 * legitimately contain answered/dismissed/superseded entries. */
export function deserializeClarificationStore(serialized: string): ClarificationStore {
  if (typeof serialized !== "string" || serialized.trim().length === 0) {
    throw new WorldModelValidationError("invalid_shape", "serialized clarification store is required");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) {
    throw new WorldModelValidationError("invalid_shape", "serialized clarification store must be an array");
  }
  const clarifications = new Map<string, Clarification>();
  for (const entry of parsed as Clarification[]) {
    const validated = createClarification(entry);
    clarifications.set(validated.id, validated);
  }
  return buildStore(clarifications);
}
