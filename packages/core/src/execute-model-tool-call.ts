import type { ChangeTarget, EntitySource, ModelToolCallIntent } from "@naqsh/schemas";
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
 */
export interface ExecuteModelToolCallOptions {
  source?: EntitySource;
  target?: ChangeTarget | null;
  authorize?: ExecuteToolInput["authorize"];
  metadata?: Record<string, unknown>;
}

export async function executeModelToolCall(
  registry: ToolRegistry,
  intent: ModelToolCallIntent,
  options: ExecuteModelToolCallOptions = {}
): Promise<ExecuteToolResult> {
  return executeTool(registry, {
    toolName: intent.toolName,
    input: intent.arguments,
    source: options.source,
    target: options.target,
    authorize: options.authorize,
    metadata: options.metadata
  });
}
