import {
  createToolRequest,
  createToolResult,
  matchesToolValueSchema,
  toIsoTimestamp,
  ToolError,
  type EntitySource,
  type Tool,
  type ToolRequest,
  type ToolResult,
  type ToolErrorKind
} from "@naqsh/schemas";
import type { ToolRegistry } from "./tool-registry.js";

export interface ExecuteToolInput {
  toolName: string;
  input: unknown;
  source?: EntitySource;
  metadata?: Record<string, unknown>;
  /**
   * P4's future seam, not P4 itself: called after input validation and
   * before the handler runs. Returning (or resolving) false rejects the
   * call with a "policy_rejected" result. Defaults to always-allow — this
   * function has no concept of autonomy levels, approval, or who's asking;
   * it only provides the HOOK a real policy engine will plug into later,
   * exactly like `mutates` on a transition registry entry is a
   * classification, not an enforcement mechanism.
   */
  authorize?: (tool: Tool, input: unknown) => boolean | Promise<boolean>;
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
 * anything, by construction (see ToolRegistry.invoke).
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
  let authorized: boolean;
  try {
    authorized = await authorize(tool, input.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { request, result: errorResult(request.id, tool.name, startedAt, "policy_rejected", message) };
  }
  if (!authorized) {
    return {
      request,
      result: errorResult(request.id, tool.name, startedAt, "policy_rejected", `Execution of "${tool.name}" was not authorized`)
    };
  }

  let output: unknown;
  try {
    output = await registry.invoke(tool.name, input.input);
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
