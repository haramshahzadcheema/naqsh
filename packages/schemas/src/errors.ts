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
