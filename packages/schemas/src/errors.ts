import type { ToolErrorKind } from "./types.js";
import type { EnvironmentErrorKind } from "./environment-types.js";
import type { ModelErrorKind } from "./model-types.js";
import type { ObservationErrorKind } from "./observation-types.js";

/** Every distinct way `WorldModelValidationError` fires, so a caller can
 * branch on `.kind` instead of string-matching `.message` -- the same
 * discipline `ToolError`/`AuthorizationError`/`EnvironmentError`/
 * `ModelError`/`ObservationError` already follow, closing the one
 * inconsistency the P0-P8 audit found (this was the sole error class in the
 * repo without a `.kind` discriminator):
 *   "invalid_shape"           -- an entity, Project, SessionState,
 *                                 WorldModelState, or ToolValueSchema
 *                                 doesn't match its structural contract
 *                                 (every assert* in validators.ts, plus
 *                                 tool-schema.ts's assertValidToolValueSchema
 *                                 -- itself the same kind of schemas-layer
 *                                 assert function, just kept in a separate
 *                                 file to avoid an import cycle).
 *   "invalid_transition"      -- updateWorldModel was given an unrecognized
 *                                 transition.kind, or a transition's own
 *                                 internal invariant was violated (e.g. an
 *                                 "add" transition that didn't actually add
 *                                 anything).
 *   "invalid_change_sequence" -- a Change (or a whole serialized
 *                                 ChangeHistory) violates append-only chain
 *                                 integrity: out-of-order sequence, wrong
 *                                 parentChangeId, a duplicate id, or a
 *                                 malformed serialized log.
 */
export type WorldModelValidationErrorKind = "invalid_shape" | "invalid_transition" | "invalid_change_sequence";

export class WorldModelValidationError extends Error {
  readonly kind: WorldModelValidationErrorKind;

  constructor(kind: WorldModelValidationErrorKind, message: string) {
    super(message);
    this.name = "WorldModelValidationError";
    this.kind = kind;
  }
}

/**
 * Thrown by the tool execution boundary (@naqsh/core's `executeTool`) and
 * by tool registration. Distinct from `WorldModelValidationError` because
 * it carries a `kind` a caller can branch on (invalid_input vs
 * unknown_tool vs execution_failure, etc.) instead of string-matching a
 * message — exactly what the P3 brief asks for instead of
 * `Error("failed")`.
 *
 * Lives in this leaf module (not validators.ts) specifically so
 * tool-schema.ts can throw it without creating a validators.ts <->
 * tool-schema.ts import cycle.
 */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;

  constructor(kind: ToolErrorKind, message: string) {
    super(message);
    this.name = "ToolError";
    this.kind = kind;
  }
}

/**
 * Thrown by ApprovalStore/AutonomyGrantStore for THEIR OWN invariant
 * violations — a missing id, or an invalid state transition (approving an
 * already-decided approval, consuming one that isn't approved, recording
 * use of a revoked/expired/exhausted grant). Deliberately NOT a ToolError:
 * these aren't tool-execution outcomes (no tool ran), they're "state
 * transition failure" in the sense the P0-P4 audit calls out as its own
 * category, distinct from execution_failure. A caller catching ToolError
 * should be able to assume a tool handler was actually invoked; conflating
 * store-lifecycle misuse into that same type would break that assumption.
 */
export type AuthorizationErrorKind = "not_found" | "invalid_state_transition";

export class AuthorizationError extends Error {
  readonly kind: AuthorizationErrorKind;

  constructor(kind: AuthorizationErrorKind, message: string) {
    super(message);
    this.name = "AuthorizationError";
    this.kind = kind;
  }
}

/**
 * Available for an EnvironmentAdapter IMPLEMENTATION to throw on a
 * genuinely unexpected failure (a real bug, a malformed internal state) —
 * never for an EXPECTED failure mode. Expected failures (object not
 * found, capability unsupported, not connected, ...) must be returned as
 * an `EnvironmentOperationResult` with `status: "error"`, exactly like
 * `ToolError`/`executeTool`: the adapter boundary never throws for
 * something a well-behaved caller should be able to anticipate and
 * handle without a try/catch.
 */
export class EnvironmentError extends Error {
  readonly kind: EnvironmentErrorKind;

  constructor(kind: EnvironmentErrorKind, message: string) {
    super(message);
    this.name = "EnvironmentError";
    this.kind = kind;
  }
}

/**
 * Available for a ModelProvider IMPLEMENTATION to throw internally while
 * building a result (e.g. inside a try/catch it uses to convert its own
 * failure into a structured `ModelInvocationResult`) — never surfaced to a
 * caller of `generate()`, which must always resolve to a
 * `ModelInvocationResult` and never reject for an expected failure mode
 * (API unavailable, auth failure, timeout, rate limit, malformed response),
 * exactly the same discipline as `EnvironmentError`/`ToolError`.
 */
export class ModelError extends Error {
  readonly kind: ModelErrorKind;

  constructor(kind: ModelErrorKind, message: string) {
    super(message);
    this.name = "ModelError";
    this.kind = kind;
  }
}

/**
 * Thrown by `@naqsh/core`'s `observeProject` (P8) for an invalid
 * OBSERVATION REQUEST — unlike `EnvironmentError`/`ModelError` (internal,
 * caught by their own boundary before a caller ever sees them),
 * `ObservationError` DOES surface directly to a caller of `observeProject`,
 * the same way a malformed `createX` call surfaces
 * `WorldModelValidationError`: asking to observe a specific, named object
 * that doesn't exist (`entity_not_found`) or an invalid scope/focus
 * request is a programmer/caller error at the call site, not a recoverable
 * runtime condition every caller must branch on. The one place this DOES
 * get caught and converted into a structured result is the agent-facing
 * observation tool (`executeTool`'s boundary), exactly like any other
 * handler exception.
 */
export class ObservationError extends Error {
  readonly kind: ObservationErrorKind;

  constructor(kind: ObservationErrorKind, message: string) {
    super(message);
    this.name = "ObservationError";
    this.kind = kind;
  }
}
