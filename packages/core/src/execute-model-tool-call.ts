import {
  createToolRequest,
  createToolResult,
  toIsoTimestamp,
  type ChangeTarget,
  type EntitySource,
  type ModelRequest,
  type ModelToolCallIntent
} from "@naqsh/schemas";
import { executeTool, type ExecuteToolInput, type ExecuteToolResult } from "./execute-tool.js";
import type { ToolRegistry } from "./tool-registry.js";

/**
 * The ONLY sanctioned path from a model's tool-call INTENT to an actual
 * tool invocation (P7 brief §5/§8). Deliberately thin: it does not
 * reimplement "does this tool exist" / "does the input match its schema" —
 * `executeTool` (P3) already performs exactly those checks (unknown_tool,
 * invalid_input), and duplicating them here would just be a second,
 * driftable copy of the same validation. This function's entire job is to
 * unpack a `ModelToolCallIntent` into the `{toolName, input}` shape
 * `executeTool` expects and hand it to that EXISTING boundary — meaning a
 * tool call that originated from a `ModelResponse` goes through identically
 * the same input validation, `authorize` policy hook, and handler
 * invocation as a tool call from anywhere else in this repo. Gemini itself
 * never holds a `ToolRegistry` reference and never calls this function —
 * an agent-loop caller (P11) does, after deciding a tool-call intent is
 * worth acting on.
 *
 * ONE thing it does add on top of `executeTool`: `request` (the exact
 * `ModelRequest` the intent is a response to) is REQUIRED, and
 * `intent.toolName` is checked against `request.tools` before `executeTool`
 * is ever called. `executeTool` alone resolves a tool name against the
 * FULL registry — which can legitimately contain tools that were never
 * declared to the model for THIS turn. Without this check, a hallucinated
 * or injected tool name that happens to collide with some OTHER registered
 * (but undeclared) tool would reach `authorize`/the handler instead of
 * being rejected outright — the model could act on a capability it was
 * never told it had. This is caught here, before authorization, because
 * "was this even offered" is a request-validation question, not a
 * permission decision.
 */
export interface ExecuteModelToolCallOptions {
  source?: EntitySource;
  target?: ChangeTarget | null;
  authorize?: ExecuteToolInput["authorize"];
  metadata?: Record<string, unknown>;
}

export async function executeModelToolCall(
  registry: ToolRegistry,
  request: ModelRequest,
  intent: ModelToolCallIntent,
  options: ExecuteModelToolCallOptions = {}
): Promise<ExecuteToolResult> {
  const wasDeclared = request.tools.some((tool) => tool.name === intent.toolName);
  if (!wasDeclared) {
    const startedAt = toIsoTimestamp();
    const toolRequest = createToolRequest({
      toolName: intent.toolName,
      input: intent.arguments,
      source: options.source,
      metadata: options.metadata
    });
    return {
      request: toolRequest,
      result: createToolResult({
        requestId: toolRequest.id,
        toolName: intent.toolName,
        status: "error",
        error: {
          kind: "unknown_tool",
          message: `"${intent.toolName}" was not among the tools declared to the model in request "${request.id}"`
        },
        startedAt
      })
    };
  }

  return executeTool(registry, {
    toolName: intent.toolName,
    input: intent.arguments,
    source: options.source,
    target: options.target,
    authorize: options.authorize,
    metadata: options.metadata
  });
}
