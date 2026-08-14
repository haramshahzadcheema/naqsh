import {
  createToolRequest,
  createToolResult,
  matchesToolValueSchema,
  toIsoTimestamp,
  ToolError,
  type ChangeTarget,
  type EntitySource,
  type Tool,
  type ToolRequest,
  type ToolResult,
  type ToolErrorKind
} from "@naqsh/schemas";
import { invokeRegisteredTool, type ToolRegistry } from "./tool-registry.js";

/** Everything an `authorize` hook needs to make a deterministic decision,
 * gathered in one place rather than threaded as positional args -- P4
 * needs `source`/`requestId` (who's asking, which request this is) and
 * `target` (what entity this call would act on, for Approval/AutonomyGrant
 * matching) in addition to `tool`/`input`. A single context object stays
 * extensible if a later phase needs to add another field without another
 * signature change. */
export interface ToolAuthorizationContext {
  tool: Tool;
  input: unknown;
  source: EntitySource;
  requestId: string;
  /** What this call would act on, reusing ChangeTarget's shape for
   * consistency with the Change Model. `null` when the call has no
   * meaningful single target (e.g. most "observe" tools). The CALLER of
   * `executeTool` supplies this via `ExecuteToolInput.target` -- it can't
   * be derived automatically from `input`, since which input field (if
   * any) names "the target" is specific to each tool. */
  target: ChangeTarget | null;
}

/** A bare `boolean` is still accepted for simple/test use; returning the
 * object form lets `authorize` explain a denial instead of `executeTool`
 * falling back to a generic message. */
export type ToolAuthorizationOutcome = boolean | { allowed: boolean; reason?: string };

export interface ExecuteToolInput {
  toolName: string;
  input: unknown;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
  /** What this call would act on, if anything -- see
   * ToolAuthorizationContext.target. Defaults to `null`. */
  target?: ChangeTarget | null;
  /**
   * P4's future seam, not P4 itself: called after input validation and
   * before the handler runs. Returning (or resolving) a falsy outcome
   * rejects the call with a "policy_rejected" result. Defaults to
   * always-allow — this function has no concept of autonomy levels,
   * approval, or who's asking; it only provides the HOOK a real policy
   * engine will plug into later, exactly like `mutates` on a transition
   * registry entry is a classification, not an enforcement mechanism.
   */
  authorize?: (context: ToolAuthorizationContext) => ToolAuthorizationOutcome | Promise<ToolAuthorizationOutcome>;
}

export interface ExecuteToolResult {
  request: ToolRequest;
  result: ToolResult;
}

function errorResult(requestId: string, toolName: string, startedAt: string, kind: ToolErrorKind, message: string): ToolResult {
  return createToolResult({
    requestId,
    toolName,
    status: "error",
    error: { kind, message },
    startedAt
  });
}

/**
 * THE controlled boundary: ToolRequest -> validate input -> policy seam ->
 * handler -> validate output -> ToolResult. This is the only sanctioned
 * way to run a tool — nothing here does `eval`, spawns a process, imports
 * from a runtime-computed specifier, or otherwise executes anything beyond
 * calling the one function a `register()` call already attached to a
 * known, declared tool name. An unregistered name simply cannot execute
 * anything, by construction (see `invokeRegisteredTool`) — and this
 * function is the only place that primitive is ever called from.
 *
 * Never throws for expected failure modes (unknown tool, invalid input,
 * policy rejection, handler exception, invalid output) — it always
 * resolves to a ToolResult with `status` and a classified `error`, so a
 * future agent loop (P11) can branch on `result.status`/`result.error.kind`
 * without wrapping every call in try/catch. It CAN reject for a genuine
 * programmer error (e.g. `registry` itself is not a ToolRegistry).
 */
export async function executeTool(registry: ToolRegistry, input: ExecuteToolInput): Promise<ExecuteToolResult> {
  const startedAt = toIsoTimestamp();
  const request = createToolRequest({
    toolName: input.toolName,
    input: input.input,
    source: input.source,
    metadata: input.metadata
  });

  const tool = registry.getByName(input.toolName);
  if (!tool) {
    return {
      request,
      result: errorResult(request.id, input.toolName, startedAt, "unknown_tool", `No tool named "${input.toolName}" is registered`)
    };
  }

  const inputErrors = matchesToolValueSchema(tool.inputSchema, input.input, "input");
  if (inputErrors.length > 0) {
    return { request, result: errorResult(request.id, tool.name, startedAt, "invalid_input", inputErrors.join("; ")) };
  }

  const authorize = input.authorize ?? (() => true);
  let outcome: ToolAuthorizationOutcome;
  try {
    outcome = await authorize({
      tool,
      input: input.input,
      source: request.source,
      requestId: request.id,
      target: input.target ?? null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { request, result: errorResult(request.id, tool.name, startedAt, "policy_rejected", message) };
  }
  const allowed = typeof outcome === "boolean" ? outcome : outcome.allowed;
  if (!allowed) {
    const reason =
      typeof outcome === "object" && outcome.reason
        ? outcome.reason
        : `Execution of "${tool.name}" was not authorized`;
    return { request, result: errorResult(request.id, tool.name, startedAt, "policy_rejected", reason) };
  }

  let output: unknown;
  try {
    output = await invokeRegisteredTool(registry, tool.name, input.input);
  } catch (error) {
    if (error instanceof ToolError) {
      return { request, result: errorResult(request.id, tool.name, startedAt, error.kind, error.message) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { request, result: errorResult(request.id, tool.name, startedAt, "execution_failure", message) };
  }

  const outputErrors = matchesToolValueSchema(tool.outputSchema, output, "output");
  if (outputErrors.length > 0) {
    return { request, result: errorResult(request.id, tool.name, startedAt, "invalid_output", outputErrors.join("; ")) };
  }

  return {
    request,
    result: createToolResult({ requestId: request.id, toolName: tool.name, status: "success", output, startedAt })
  };
}
