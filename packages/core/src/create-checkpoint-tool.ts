import {
  createCheckpoint,
  createId,
  serializeWorldModelState,
  ToolError,
  createTool,
  type EnvironmentSession,
  type Tool,
  type ToolValueSchema,
  type WorldModelState
} from "@naqsh/schemas";
import type { ArtifactStore } from "./artifact-store.js";
import { byteSizeOf, computeContentHash, CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION, fingerprintEnvironmentObjects } from "./artifact-store.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { ChangeHistory } from "./change-history.js";
import type { EnvironmentAdapter } from "./environment-adapter.js";
import type { ToolHandler } from "./tool-registry.js";

/**
 * Phase 15's CAPTURE half of "checkpoints -> snapshots -> rollback -> action
 * history": a thin, generic wrapper that (1) serializes the CURRENT
 * `WorldModelState` via P1/P2's own `serializeWorldModelState` -- never a
 * second, competing World Model serializer -- (2) asks the connected
 * `EnvironmentAdapter`, if any, for its own opaque recoverable snapshot via
 * the "checkpoint" capability P5 already defined, and (3) persists ONLY
 * metadata (`Checkpoint`) plus the artifact bytes (`ArtifactStore`) once
 * BOTH halves are confirmed to have actually succeeded.
 *
 * Deliberately classified `mutation: "suggest"` (Phase 15's own "Checkpoint
 * creation may be allowed for lower autonomy levels" requirement): creating
 * a checkpoint reads current state and writes a NEW, independent record --
 * it never touches `WorldModelState`/`Project` or the environment's own
 * live content, exactly like `create_proposal` (P10) is also "suggest"
 * despite producing a brand-new persisted record.
 *
 * ATOMICITY (Phase 15 Requirement 4): the environment snapshot is captured
 * BEFORE anything is written to `artifactStore`/`checkpointStore` -- if a
 * session is connected but the adapter cannot produce a snapshot (missing
 * "checkpoint" capability or a genuine failure), or if the post-snapshot
 * re-observation needed for later mismatch detection fails, this handler
 * throws and persists NOTHING. There is no code path that saves `Checkpoint`
 * metadata pointing at a `worldModelSnapshot`/`environmentSnapshot` that was
 * never actually written -- "do not fake environment snapshots" applies
 * literally: a session being connected is a commitment to a REAL
 * environment snapshot, never a best-effort one silently downgraded to
 * `environmentSnapshot: null` on failure.
 *
 * A `null` `getSession()` (no environment connected at all) is a
 * DIFFERENT, entirely legitimate case: a World-Model-only checkpoint,
 * exactly as valid and complete as one with an environment snapshot --
 * see `checkpoint-types.ts`'s own doc comment on `environmentSnapshot`.
 */

const inputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    reason: { type: "string", description: "Why this checkpoint is being taken, e.g. \"before removing the mounting bracket\"." }
  },
  required: ["reason"]
};

const outputSchema: ToolValueSchema = {
  type: "object",
  properties: {
    checkpoint: {
      type: "object",
      properties: {
        id: { type: "string" },
        projectId: { type: "string" },
        status: { type: "string" },
        reason: { type: "string" },
        createdAt: { type: "string" },
        lastChangeId: { type: "string", nullable: true },
        projectVersion: { type: "number" },
        worldModelSnapshot: { type: "object", properties: {}, additionalProperties: true },
        environmentSnapshot: { type: "object", properties: {}, additionalProperties: true, nullable: true }
      },
      additionalProperties: true,
      required: ["id", "projectId", "status", "reason", "createdAt", "projectVersion", "worldModelSnapshot", "environmentSnapshot"]
    }
  },
  required: ["checkpoint"]
};

interface CreateCheckpointInput {
  reason: string;
}

function toCreateCheckpointInput(input: unknown): CreateCheckpointInput {
  const record = input as { reason?: unknown };
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    throw new ToolError("invalid_input", "reason is required and must be a non-empty string");
  }
  return { reason: record.reason };
}

export function createCreateCheckpointTool(
  getState: () => WorldModelState,
  history: ChangeHistory,
  getSession: () => EnvironmentSession | null,
  adapter: EnvironmentAdapter,
  checkpointStore: CheckpointStore,
  artifactStore: ArtifactStore
): { tool: Tool; handler: ToolHandler } {
  const tool = createTool({
    name: "create_checkpoint",
    description:
      "Captures a recoverable snapshot of the current World Model state and, if an environment session is connected, the environment's own state -- producing a new, immutable, addressable Checkpoint that restore_checkpoint can later roll back to.",
    target: "checkpoint",
    mutation: "suggest",
    inputSchema,
    outputSchema
  });

  const handler: ToolHandler = async (rawInput) => {
    const input = toCreateCheckpointInput(rawInput);
    const state = getState();
    const session = getSession();

    let environmentSnapshot: {
      environmentKind: string;
      environmentCheckpointId: string;
      documentName: string | null;
      objectIds: string[];
      contentHash: string;
    } | null = null;

    if (session) {
      const checkpointResult = await adapter.checkpoint(session);
      if (checkpointResult.status === "error") {
        throw new ToolError(
          "execution_failure",
          `environment_restore_unavailable: could not create an environment snapshot -- ${checkpointResult.error?.message ?? "unknown error"}`
        );
      }
      const data = checkpointResult.data as { checkpointId?: unknown };
      if (typeof data.checkpointId !== "string" || data.checkpointId.length === 0) {
        throw new ToolError("execution_failure", "environment_restore_unavailable: adapter.checkpoint() reported success but returned no checkpointId");
      }

      // Best-effort fingerprint for later mismatch detection (Phase 15's
      // own narrow, deterministic integrity check -- NOT P16 verification).
      // A failure here means this checkpoint cannot honestly promise
      // post-restore mismatch detection, so the WHOLE checkpoint fails
      // rather than silently degrading -- see this file's own doc comment.
      // Uses `listObjects` (not the cheaper `inspectDocument`) because the
      // fingerprint must cover PROPERTY VALUES, not just which objects
      // exist -- an environment that restores the right objects with
      // STALE properties would be invisible to an ids-only comparison.
      const listed = await adapter.listObjects(session);
      if (listed.status === "error") {
        throw new ToolError(
          "execution_failure",
          `environment_restore_unavailable: environment snapshot was created but could not be fingerprinted -- ${listed.error?.message ?? "unknown error"}`
        );
      }
      const rawObjects = Array.isArray(listed.data) ? (listed.data as Parameters<typeof fingerprintEnvironmentObjects>[0]) : [];
      const { objectIds, contentHash } = fingerprintEnvironmentObjects(rawObjects);

      environmentSnapshot = {
        environmentKind: adapter.describe().kind,
        environmentCheckpointId: data.checkpointId,
        documentName: session.documentName,
        objectIds,
        contentHash
      };
    }

    const serialized = serializeWorldModelState(state);
    const artifactId = createId("artifact");

    const checkpoint = createCheckpoint({
      projectId: state.project.id,
      sessionId: state.session.id,
      reason: input.reason,
      lastChangeId: history.headId(),
      projectVersion: state.project.version,
      worldModelSnapshot: {
        artifactId,
        contentHash: computeContentHash(serialized),
        byteSize: byteSizeOf(serialized),
        schemaVersion: CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION
      },
      environmentSnapshot
    });

    // Both writes only happen once every fallible step above has already
    // succeeded -- this is the atomic "commit" point (Phase 15 Requirement
    // 4: "Do not create metadata pointing to a snapshot that does not
    // exist").
    artifactStore.put(artifactId, serialized);
    checkpointStore.save(checkpoint);

    return { checkpoint };
  };

  return { tool, handler };
}
