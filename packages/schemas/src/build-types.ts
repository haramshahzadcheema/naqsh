import type { EntitySource } from "./types.js";

/**
 * Phase 20's BUILD half: a `DesignSpecification` becomes a bounded sequence
 * of typed tool calls (`BuildOperation`s), executed through the EXISTING
 * P3/P4 boundary (`executeTool` + real authorization) -- never a new
 * execution mechanism. `BuildResult` is the audit record of what actually
 * happened, deliberately kept separate from `VerificationResult` (P16):
 *
 *   build_success      -- "the requested operation(s) executed successfully"
 *   verification_passed -- "a deterministic check confirms an engineering
 *                           condition holds" (P16, untouched)
 *   objective_satisfied -- "taken together, the objective is met" (P17,
 *                           untouched)
 *
 * These three are NEVER collapsed (P20 brief Step 14): `BuildResult` only
 * ever claims the first. A failed build must never report a false
 * success -- `status`/`buildSuccess` are both explicit, and a build that
 * fails partway leaves every already-executed operation's own record
 * intact (never silently discarded) while marking the rest `"skipped"`.
 */

/** One `BuildOperation`'s own lifecycle. `"pending"` is the state a freshly
 * planned (not-yet-attempted) operation starts in; `"skipped"` is distinct
 * from `"failed"` -- an operation never even attempted because an EARLIER
 * one in the same build failed is honestly "skipped," not "failed" (it
 * never ran, so it cannot have failed). */
export type BuildOperationStatus = "pending" | "succeeded" | "failed" | "skipped";

export const BUILD_OPERATION_STATUSES: readonly BuildOperationStatus[] = ["pending", "succeeded", "failed", "skipped"];

/**
 * One concrete, typed tool call realizing one `ExpectedBuildOutput` (P20's
 * design-specification-types.ts). `toolName`/`input` mirror `Proposal`'s
 * identical `{toolName, input}` shape (P10) -- a build operation IS a
 * proposed/executed call to a registered `Tool` (P3), not a bespoke
 * "build step" vocabulary reinvented from scratch.
 */
export interface BuildOperation {
  id: string;
  /** The `ExpectedBuildOutput.id` (from the originating `DesignSpecification`)
   * this operation realizes -- traceability back to design intent. */
  expectedOutputId: string;
  toolName: string;
  input: unknown;
  status: BuildOperationStatus;
  /** The tool's JSON-safe output on success, `null` otherwise. */
  output: unknown | null;
  error: { kind: string; message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BuildOperationInput {
  id?: string;
  expectedOutputId: string;
  toolName: string;
  input?: unknown;
  status?: BuildOperationStatus;
  output?: unknown | null;
  error?: { kind: string; message: string } | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

/** The build's own aggregate lifecycle -- distinct from any one
 * operation's. `"completed"` means every operation that was attempted
 * succeeded (an EMPTY `operations` list, e.g. a design with zero expected
 * outputs, is never `"completed"` -- see `build-executor.ts`'s
 * `EMPTY_BUILD_REASON`, mirroring P17's identical "empty is never silently
 * success" safety default). `"failed"` means at least one operation
 * failed; whatever ran successfully before the failure is still recorded,
 * never discarded. */
export type BuildStatus = "pending" | "in_progress" | "completed" | "failed";

export const BUILD_STATUSES: readonly BuildStatus[] = ["pending", "in_progress", "completed", "failed"];

export interface BuildResult {
  id: string;
  projectId: string;
  projectVersion: number;
  designSpecificationId: string;
  status: BuildStatus;
  /** Redundant with `status` by design (Step 14's own explicit "do not
   * collapse build_success with anything else" instruction) -- a bare
   * boolean a caller can check without needing to know `BuildStatus`'s
   * exact semantics. `true` if and only if `status === "completed"`. */
  buildSuccess: boolean;
  operations: BuildOperation[];
  startedAt: string;
  completedAt: string | null;
  source: EntitySource;
  metadata: Record<string, unknown>;
}

export interface BuildResultInput {
  id?: string;
  projectId: string;
  projectVersion: number;
  designSpecificationId: string;
  status?: BuildStatus;
  buildSuccess?: boolean;
  operations?: BuildOperationInput[];
  startedAt?: string;
  completedAt?: string | null;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
}
