import { createModelToolDeclaration, type ModelToolDeclaration, type Tool } from "@naqsh/schemas";

/**
 * Projects registered `Tool`s (P3) into what a model is allowed to know
 * about them (P7 brief §5). A straight field mapping, not a redesign:
 * `inputSchema` is `tool.inputSchema` UNCHANGED — the same `ToolValueSchema`
 * `executeTool` already validates a call against, never a re-authored
 * Gemini-specific copy. `Tool.id`/`version`/`source`/`outputSchema` are
 * deliberately dropped: a model never needs an internal id to ask for a
 * tool by name, and it must never see anything shaped like a handler
 * (`Tool` itself already guarantees that; this function does not
 * reintroduce the risk by adding a field that could hold one).
 */
export function toModelToolDeclarations(tools: readonly Tool[]): ModelToolDeclaration[] {
  return tools.map((tool) =>
    createModelToolDeclaration({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      mutation: tool.mutation,
      target: tool.target
    })
  );
}
