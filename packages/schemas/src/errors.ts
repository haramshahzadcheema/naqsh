import type { ToolErrorKind } from "./types.js";

/** Thrown by every assert* function in validators.ts. A dedicated class
 * lets callers (e.g. a future P16 verification layer, or a P7 gate on
 * agent-authored state) distinguish "this violates the World Model
 * contract" from any other kind of failure without string-matching a
 * message. */
export class WorldModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorldModelValidationError";
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
