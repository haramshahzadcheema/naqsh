import type { EntitySource } from "./types.js";

/**
 * Checkpoints / Snapshots / Rollback / Action History (P15).
 *
 * A `Checkpoint` is METADATA ONLY -- a pointer to a recoverable snapshot,
 * never the snapshot content itself. This mirrors the split every earlier
 * phase already established between a small, queryable record and the real
 * evidence it references: `Change.transition` embeds the real transition
 * (not a pointer) because transitions are cheap, but a full serialized
 * `WorldModelState` is NOT cheap to duplicate into every checkpoint record
 * -- so it lives in a separate, content-addressed artifact store
 * (`@naqsh/core`'s `ArtifactStore`), and `Checkpoint.worldModelSnapshot`
 * only carries enough to locate and VERIFY it (`artifactId`/`contentHash`/
 * `byteSize`/`schemaVersion`), never the bytes.
 *
 * The environment side follows the identical split one layer down: a real
 * environment snapshot (a FreeCAD document copy, a mock's in-memory object
 * map) lives entirely inside the adapter that produced it -- core only ever
 * holds the OPAQUE `environmentCheckpointId` string `EnvironmentAdapter.
 * checkpoint()` returned, exactly the same "core never knows FreeCAD file
 * formats" boundary P12 already established for every other environment
 * operation.
 *
 * `Checkpoint` is immutable once created (no `updateCheckpoint`/`assertX`
 * pair exists for partial mutation, and `CheckpointStore` in @naqsh/core
 * exposes no update method) -- if a checkpoint's own metadata must evolve,
 * that is a future, separate event mechanism layered ON TOP, never a write
 * to this record.
 */

/**
 * Deliberately a single value today. `Checkpoint`/`CheckpointStore` never
 * construct a checkpoint that isn't fully formed (see `createCheckpoint*`
 * tool in @naqsh/core: metadata is only ever persisted after BOTH the
 * World Model artifact and, when applicable, the environment snapshot have
 * already succeeded) -- there is no "pending"/"partial" state to represent
 * because a half-created checkpoint is never allowed to become addressable
 * in the first place. A real field, not an inlined literal type, so a
 * later phase (e.g. an "archived" or "expired" checkpoint concept) can
 * extend this the same additive way `EntitySource`/`ToolTarget` already
 * grow.
 */
export type CheckpointStatus = "complete";

export const CHECKPOINT_STATUSES: readonly CheckpointStatus[] = ["complete"];

/**
 * A pointer to the serialized `WorldModelState` blob this checkpoint
 * captured, held in a separate `ArtifactStore` -- never inlined here.
 * `contentHash` (SHA-256 hex digest of the exact UTF-8 bytes) and
 * `byteSize` are the integrity signal Phase 15 requires: a caller can
 * detect a corrupted/modified/truncated artifact WITHOUT first attempting
 * to parse it as JSON (`deserializeWorldModelState` already rejects
 * malformed JSON/schema violations on its own, but a byte-for-byte
 * substitution that still happens to parse as SOME valid WorldModelState
 * would not be caught by schema validation alone -- the hash is what
 * proves it is the SAME bytes that were originally written).
 */
export interface CheckpointArtifactRef {
  artifactId: string;
  contentHash: string;
  byteSize: number;
  /** A version tag for the ARTIFACT'S OWN shape (independent of
   * `Project.version`) -- lets a future phase detect "this was written by
   * an older/incompatible serializer" before even attempting to parse it.
   * Always `"1"` today; bumped only if `serializeWorldModelState`'s output
   * shape ever changes in a way that breaks old artifacts. */
  schemaVersion: string;
}

export interface CheckpointArtifactRefInput {
  artifactId: string;
  contentHash: string;
  byteSize: number;
  schemaVersion?: string;
}

/**
 * A pointer to the environment-side snapshot, when this checkpoint
 * includes one. `null` on `Checkpoint.environmentSnapshot` means this
 * checkpoint is genuinely World-Model-only (no environment was connected
 * when it was created) -- NOT "the environment snapshot failed and was
 * silently skipped" (that case fails checkpoint CREATION entirely; see
 * `create_checkpoint`'s own doc comment).
 *
 * `environmentKind`/`documentName` are denormalized identity fields (NOT
 * derived from the opaque `environmentCheckpointId`) -- the "checkpoint
 * versioning"/"incompatible checkpoint" guard Phase 15 requires compares
 * THESE against whatever environment session is currently connected at
 * restore time, without ever having to ask an adapter "whose checkpoint is
 * this" first. `EnvironmentSession.id` is deliberately NOT used for this
 * comparison -- a session's own id is fresh on every `connect()` call (see
 * `packages/adapters/freecad/README.md`'s "Object identity, stated
 * honestly" discussion), so comparing session ids would reject a
 * perfectly valid restore against the SAME document reopened in a new
 * session.
 */
export interface CheckpointEnvironmentSnapshot {
  environmentKind: string;
  environmentCheckpointId: string;
  documentName: string | null;
  /** Sorted object ids at capture time -- a cheap EXISTENCE check (did an
   * object appear/disappear), not a content check. */
  objectIds: string[];
  /** A cheap, deterministic content fingerprint (SHA-256 of each object's
   * sorted id/type/properties, canonically ordered) -- NOT a full
   * re-implementation of P16 verification, but genuinely necessary
   * alongside `objectIds`: an environment that reports the SAME objects
   * but with STALE property values (the most realistic "restore failed
   * silently" case) would be invisible to an ids-only comparison. Used
   * only for POST-RESTORE mismatch detection: after `EnvironmentAdapter.
   * restore()` reports success, re-observing and comparing this hash is
   * what lets Phase 15 distinguish "the adapter claims success" from "the
   * environment's content actually looks like it did at capture time,"
   * without scoring engineering correctness. */
  contentHash: string;
}

export interface CheckpointEnvironmentSnapshotInput {
  environmentKind: string;
  environmentCheckpointId: string;
  documentName?: string | null;
  objectIds?: string[];
  contentHash: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  /** The `SessionState.id` active when this checkpoint was created --
   * provenance only (SessionState is transient/rebuildable, unlike
   * Project -- see `types.ts`'s own `SessionState` doc comment), never
   * used to gate whether a restore is allowed. */
  sessionId: string | null;
  status: CheckpointStatus;
  /** Why this checkpoint was taken, e.g. "before removing the mounting
   * bracket". Freeform, matching `Approval.reason`'s role. */
  reason: string;
  /** Who/what asked for this checkpoint (typically "agent" or "human"). */
  source: EntitySource;
  createdAt: string;
  /** The `Change.id` at the HEAD of `ChangeHistory` at the moment this
   * checkpoint was captured, or `null` if no Change had been recorded yet.
   * This is the pointer a future history UI walks to answer "which
   * checkpoint existed right after Action 17" -- NOT a replay instruction
   * (the checkpoint already carries a full snapshot; nothing needs to be
   * replayed from this id). */
  lastChangeId: string | null;
  /** `project.version` at capture time -- the cheap compatibility signal
   * `restore_checkpoint` reports back to a caller alongside the current
   * version, so a human/UI can see how far the project has moved on. */
  projectVersion: number;
  worldModelSnapshot: CheckpointArtifactRef;
  /** `null` for a checkpoint taken with no environment connected. */
  environmentSnapshot: CheckpointEnvironmentSnapshot | null;
  metadata: Record<string, unknown>;
}

export interface CheckpointInput {
  id?: string;
  projectId: string;
  sessionId?: string | null;
  status?: CheckpointStatus;
  reason?: string;
  source?: EntitySource;
  createdAt?: string;
  lastChangeId?: string | null;
  projectVersion: number;
  worldModelSnapshot: CheckpointArtifactRefInput;
  environmentSnapshot?: CheckpointEnvironmentSnapshotInput | null;
  metadata?: Record<string, unknown>;
}

/**
 * Every distinct way `restore_checkpoint` can refuse or fail BEFORE/DURING
 * a restore attempt -- named specifically so a caller can branch on WHY
 * without string-matching `ToolResult.error.message`, matching every other
 * phase's "be specific, not generic" error-kind discipline. `ToolError`'s
 * own kind vocabulary is deliberately coarse (`invalid_input`/
 * `execution_failure` -- see P14's identical precedent), so each of these
 * reasons is surfaced as a distinguishable, greppable prefix in `ToolError.
 * message` text rather than a second structured error-kind system.
 */
export type RestoreCheckpointFailureReason =
  | "checkpoint_not_found"
  | "cross_project_forbidden"
  | "incompatible_environment"
  | "incompatible_snapshot_version"
  | "corrupted_snapshot"
  | "missing_artifact"
  | "environment_restore_failed"
  | "world_model_restore_failed";

export const RESTORE_CHECKPOINT_FAILURE_REASONS: readonly RestoreCheckpointFailureReason[] = [
  "checkpoint_not_found",
  "cross_project_forbidden",
  "incompatible_environment",
  "incompatible_snapshot_version",
  "corrupted_snapshot",
  "missing_artifact",
  "environment_restore_failed",
  "world_model_restore_failed"
];
