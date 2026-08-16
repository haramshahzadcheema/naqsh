import {
  createTool,
  deserializeWorldModelState,
  ToolError,
  WorldModelValidationError,
  type Change,
  type EnvironmentSession,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import { byteSizeOf, computeContentHash, CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION, fingerprintEnvironmentObjects, type ArtifactStore } from "./artifact-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ChangeHistory } from "./change-history.js";
import { recordTransition } from "./record-transition.js";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 15's ROLLBACK half. Rollback is a MUTATION -- this tool is
 * classified `mutation: "mutate"`, so it goes through the exact same
 * P3/P4 `executeTool` -> approval-required boundary every other mutating
 * tool already goes through (proven end to end in
 * `restore-checkpoint-tool.test.ts`, mirroring Phase 14's identical proof
 * for `modify_environment_object`). There is no separate "rollback
 * approval" system -- reusing P4 literally is the whole point.
 *
 * THE RESTORE FLOW (Phase 15 Requirement 5, followed in this exact order):
 *   1. Locate checkpoint                  -> checkpointStore.getById
 *   2. Validate scope                     -> cross-project check
 *   3. Validate environment compatibility -> environmentKind/documentName
 *   4. Validate snapshot VERSION          -> worldModelSnapshot.schemaVersion
 *                                             against what this system writes
 *   5. Verify snapshot integrity          -> retrieve artifact, recompute
 *                                             hash+size, deserialize
 *   6. Restore environment (if any)       -> adapter.restore()
 *   7. Restore World Model                -> recordTransition(restore_project)
 *   8. Reconcile                          -> setState(nextState)
 *   9. Re-observe + report mismatch       -> adapter.listObjects(),
 *                                             compare content fingerprint
 *
 * Steps 6 and 7 are ordered environment-first, world-model-second
 * deliberately: the World Model artifact was ALREADY fully validated in
 * step 5 (hash-verified, deserialized, schema-checked), so by the time
 * step 7 runs it is applying data already known to be well-formed --
 * about as close to guaranteed-to-succeed as this architecture can make
 * it, which minimizes the (still theoretically possible) window where the
 * environment has reverted but the World Model has not. If step 7 somehow
 * still fails after step 6 already succeeded, the resulting `ToolError`
 * message says so explicitly (Phase 15's "if a failure mode can leave the
 * environment in an uncertain state, represent that explicitly") rather
 * than reporting a generic failure that hides which half actually
 * happened.
 *
 * MISMATCH DETECTION (step 9) is deliberately NON-FATAL: a difference
 * between the environment's post-restore object ids and the ones recorded
 * at checkpoint-creation time is reported as `mismatchDetected: true`
 * plus a `warnings` entry on an otherwise SUCCESSFUL result, never a
 * thrown error -- by this point the World Model has already been reverted
 * and recorded as a real, durable Change; discarding that success because
 * a best-effort post-hoc comparison came back inconclusive would be worse
 * than reporting it plainly (the exact same "discrepancy is informational,
 * not fatal" precedent `LoopDiscrepancy`/`AgentLoopRun`'s "executed" vs
 * "completed" status split already established in P11). This is
 * deliberately NOT the full P16 verification framework -- a narrow,
 * deterministic identity comparison, nothing more.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    checkpointId: { type: "string", description: "The Checkpoint to restore." },
    reason: { type: "string", nullable: true, description: "Why this rollback is being performed." }
  },
  required: ["checkpointId"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    checkpoint: { type: "object", properties: {}, additionalProperties: true },
    change: { type: "object", properties: {}, additionalProperties: true },
    mismatchDetected: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["checkpoint", "change", "mismatchDetected", "warnings"]
};

interface RestoreCheckpointInput {
  checkpointId: string;
  reason: string | null;
}

function toRestoreCheckpointInput(input: unknown): RestoreCheckpointInput {
  const record = input as { checkpointId?: unknown; reason?: unknown };
  if (typeof record.checkpointId !== "string" || record.checkpointId.trim().length === 0) {
    throw new ToolError("invalid_input", "checkpointId is required and must be a non-empty string");
  }
  return { checkpointId: record.checkpointId, reason: typeof record.reason === "string" ? record.reason : null };
}

export function createRestoreCheckpointTool(
  getState: () => WorldModelState,
  setState: (state: WorldModelState) => void,
  history: ChangeHistory,
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter,
  checkpointStore: CheckpointStore,
  artifactStore: ArtifactStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "restore_checkpoint",
    description:
      "Rolls the project back to a previously created Checkpoint: restores the environment (if the checkpoint includes one) and the World Model, and records the rollback as a real, auditable Change -- never a silent state replacement. A mutation, gated by the same approval boundary as every other mutating tool.",
    target: "checkpoint",
    mutation: "mutate",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toRestoreCheckpointInput(rawInput);

    // 1. Locate.
    const checkpoint = checkpointStore.getById(input.checkpointId);
    if (!checkpoint) {
      throw new ToolError("invalid_input", `checkpoint_not_found: No checkpoint with id "${input.checkpointId}" exists`);
    }

    const state = getState();

    // 2. Validate scope -- a checkpoint can only ever restore the SAME
    // project it was captured from. Cross-project/cross-tenant restore is
    // an explicit, structural rejection, never left to opaque-id luck.
    if (checkpoint.projectId !== state.project.id) {
      throw new ToolError(
        "invalid_input",
        `cross_project_forbidden: Checkpoint "${checkpoint.id}" belongs to project "${checkpoint.projectId}", not the current project "${state.project.id}"`
      );
    }

    // 3. Validate environment compatibility (before touching anything).
    const session = getSession();
    if (checkpoint.environmentSnapshot) {
      if (!session) {
        throw new ToolError(
          "invalid_input",
          `incompatible_environment: Checkpoint "${checkpoint.id}" includes an environment snapshot, but no environment session is currently connected`
        );
      }
      if (session.environmentKind !== checkpoint.environmentSnapshot.environmentKind || session.documentName !== checkpoint.environmentSnapshot.documentName) {
        throw new ToolError(
          "invalid_input",
          `incompatible_environment: Checkpoint "${checkpoint.id}" was captured from ${checkpoint.environmentSnapshot.environmentKind}/"${checkpoint.environmentSnapshot.documentName}", but the connected session is ${session.environmentKind}/"${session.documentName}"`
        );
      }
    }

    // 4. Verify World Model snapshot VERSION compatibility -- Phase 15's
    // own "Checkpoint Versioning" requirement, audit finding: this field
    // existed on the schema and was written by create_checkpoint, but
    // nothing ever compared it against anything, so a checkpoint written
    // by a hypothetical future, incompatible serializer would have been
    // silently accepted rather than rejected. Checked BEFORE integrity
    // verification: an incompatible version is a reason to refuse the
    // checkpoint outright, not a reason to bother hashing/parsing it.
    if (checkpoint.worldModelSnapshot.schemaVersion !== CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION) {
      throw new ToolError(
        "invalid_input",
        `incompatible_snapshot_version: Checkpoint "${checkpoint.id}"'s World Model snapshot was written with schema version "${checkpoint.worldModelSnapshot.schemaVersion}", but this system only supports "${CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION}"`
      );
    }

    // 5. Verify World Model snapshot integrity BEFORE mutating anything.
    const artifactContent = artifactStore.get(checkpoint.worldModelSnapshot.artifactId);
    if (artifactContent === undefined) {
      throw new ToolError("execution_failure", `missing_artifact: Checkpoint "${checkpoint.id}"'s World Model snapshot artifact is not available`);
    }
    if (byteSizeOf(artifactContent) !== checkpoint.worldModelSnapshot.byteSize || computeContentHash(artifactContent) !== checkpoint.worldModelSnapshot.contentHash) {
      throw new ToolError("execution_failure", `corrupted_snapshot: Checkpoint "${checkpoint.id}"'s World Model snapshot failed integrity verification (hash/size mismatch)`);
    }
    let restoredState: WorldModelState;
    try {
      restoredState = deserializeWorldModelState(artifactContent);
    } catch (error) {
      throw new ToolError(
        "execution_failure",
        `corrupted_snapshot: Checkpoint "${checkpoint.id}"'s World Model snapshot could not be parsed/validated -- ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // 6. Restore the environment (only if this checkpoint has one).
    let environmentRestored = false;
    if (checkpoint.environmentSnapshot && session) {
      const restoreResult = await adapter.restore(session, checkpoint.environmentSnapshot.environmentCheckpointId);
      if (restoreResult.status === "error") {
        throw new ToolError(
          "execution_failure",
          `environment_restore_failed: ${restoreResult.error?.message ?? "unknown error"} -- the environment was NOT changed and neither was the World Model`
        );
      }
      environmentRestored = true;
    }

    // 7. Restore the World Model -- pin identity fields to the CURRENT
    // project (a rollback can never change which project this is or
    // fabricate a new genesis time), reusing the exact same audited write
    // path (`recordTransition`/`ChangeHistory`) every other mutation goes
    // through.
    let nextState: WorldModelState;
    let change: Change;
    try {
      const result = recordTransition(
        history,
        state,
        {
          kind: "restore_project",
          project: { ...restoredState.project, id: state.project.id, createdAt: state.project.createdAt }
        },
        {
          source: "agent",
          cause: {
            kind: "system",
            description: input.reason ? `Rollback to checkpoint "${checkpoint.id}": ${input.reason}` : `Rollback to checkpoint "${checkpoint.id}"`
          },
          metadata: { checkpointId: checkpoint.id, rollback: true }
        }
      );
      nextState = result.state;
      change = result.change;
    } catch (error) {
      const environmentNote = environmentRestored
        ? " -- the environment was ALREADY restored and is now AHEAD of the (unrestored) World Model; this project is in an inconsistent state until resolved"
        : "";
      throw new ToolError(
        "execution_failure",
        `world_model_restore_failed: ${error instanceof WorldModelValidationError ? error.message : error instanceof Error ? error.message : String(error)}${environmentNote}`
      );
    }

    // 8. Reconcile.
    setState(nextState);

    // 9. Re-observe + report mismatch (non-fatal -- see this file's own
    // doc comment for why).
    let mismatchDetected = false;
    const warnings: string[] = [];
    if (checkpoint.environmentSnapshot && session) {
      const listed = await adapter.listObjects(session);
      if (listed.status === "error") {
        mismatchDetected = true;
        warnings.push(`post_restore_observation_failed: could not re-observe the environment after restore -- ${listed.error?.message ?? "unknown error"}`);
      } else {
        const rawObjects = Array.isArray(listed.data) ? (listed.data as Parameters<typeof fingerprintEnvironmentObjects>[0]) : [];
        const actual = fingerprintEnvironmentObjects(rawObjects);
        if (actual.contentHash !== checkpoint.environmentSnapshot.contentHash) {
          mismatchDetected = true;
          warnings.push(
            `post_restore_mismatch: environment reported success, but its content after restore does not match what was captured at checkpoint time (object ids now: ${JSON.stringify(actual.objectIds)}, expected: ${JSON.stringify(checkpoint.environmentSnapshot.objectIds)})`
          );
        }
      }
    }

    return {
      checkpoint,
      change,
      mismatchDetected,
      warnings
    };
  };

  return { tool, handler };
}
