import { createHash } from "node:crypto";
import { WorldModelValidationError, type EnvironmentObject } from "@naqsh/schemas";

/**
 * Content-addressed-ish storage for the LARGE blobs a `Checkpoint` (P15)
 * points to but never inlines -- today, a serialized `WorldModelState`
 * string (see `checkpoint-types.ts`'s own doc comment for why metadata and
 * artifact bytes are kept apart: "Do not put large FreeCAD files directly
 * into Firestore-style documents if the existing architecture provides
 * object storage").
 *
 * Deliberately the same "seam, not infrastructure" shape as
 * `ApprovalStore`/`ChangeHistory` (P2/P4): a plain in-memory `Map` behind a
 * typed interface. A real deployment swaps this for S3/GCS/a blob column
 * without `CheckpointStore` or any tool handler needing to change --
 * `ArtifactStore` is the ONE place that decision is made.
 *
 * `put` REFUSES to overwrite an existing id (append-only, matching
 * `Checkpoint`'s own immutability: once a checkpoint is addressable, the
 * bytes it points to can never silently change underneath it).
 */
export interface ArtifactStore {
  put(artifactId: string, content: string): void;
  get(artifactId: string): string | undefined;
  has(artifactId: string): boolean;
}

export function createArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, string>();

  return {
    put(artifactId, content) {
      if (typeof artifactId !== "string" || artifactId.length === 0) {
        throw new WorldModelValidationError("invalid_shape", "artifactId is required");
      }
      if (artifacts.has(artifactId)) {
        throw new WorldModelValidationError("invalid_shape", `Artifact "${artifactId}" already exists -- artifacts are immutable once written`);
      }
      artifacts.set(artifactId, content);
    },
    get: (artifactId) => artifacts.get(artifactId),
    has: (artifactId) => artifacts.has(artifactId)
  };
}

/**
 * SHA-256 hex digest of `content`'s exact UTF-8 bytes -- the integrity
 * signal `CheckpointArtifactRef.contentHash` carries and `restore_
 * checkpoint` recomputes and compares before ever trusting a retrieved
 * artifact (Phase 15's "a corrupted or modified artifact must be
 * detectable" requirement). A straightforward hash, not a distributed
 * content-addressed storage system -- exactly the brief's own explicit
 * scope boundary.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function byteSizeOf(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/**
 * The ONE place that decides what `CheckpointArtifactRef.schemaVersion`
 * NAQSH currently writes, and what `restore_checkpoint` requires a
 * checkpoint to carry before it will trust the artifact enough to even
 * attempt deserializing it (Phase 15 audit finding: this constant existed
 * only as a schema field and a factory default -- nothing ever compared
 * it against anything, so a checkpoint written by a hypothetical future,
 * incompatible serializer would have been silently accepted rather than
 * rejected as Phase 15's own "Checkpoint Versioning" requirement demands).
 * Bump this ONLY when `serializeWorldModelState`'s own output shape
 * changes in a way that would make an OLDER artifact unsafe to deserialize
 * as the CURRENT `WorldModelState` shape.
 */
export const CURRENT_WORLD_MODEL_SNAPSHOT_SCHEMA_VERSION = "1";

/**
 * The environment-side counterpart to `computeContentHash`: a cheap,
 * deterministic CONTENT fingerprint of a `listObjects()` result -- id,
 * type, and properties, canonically sorted by id -- not just which
 * objects exist. Deliberately narrow (Phase 15's own "not P16
 * verification" boundary): this proves "the environment's content looks
 * like it did at capture time," nothing about engineering correctness.
 * Used identically by `create_checkpoint` (captures the baseline) and
 * `restore_checkpoint` (re-observes and compares after a restore) so the
 * two can never silently drift apart in what "matches" means.
 */
export function fingerprintEnvironmentObjects(objects: readonly EnvironmentObject[]): { objectIds: string[]; contentHash: string } {
  const sorted = [...objects].sort((a, b) => a.id.localeCompare(b.id));
  const objectIds = sorted.map((object) => object.id);
  const canonical = JSON.stringify(sorted.map((object) => ({ id: object.id, type: object.type, properties: object.properties })));
  return { objectIds, contentHash: computeContentHash(canonical) };
}
