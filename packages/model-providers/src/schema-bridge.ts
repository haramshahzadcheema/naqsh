import type { ModelToolDeclaration, ToolValueSchema } from "@naqsh/schemas";
import type { FunctionDeclaration } from "@google/genai";

/**
 * The P7 brief's "JSON Schema / structured output" bridge (§4) — and the
 * reason it does almost nothing: `ToolValueSchema` (packages/schemas) is
 * ALREADY a valid JSON Schema subset (its `type`/`properties`/`required`/
 * `items`/`enum`/`additionalProperties` vocabulary matches JSON Schema
 * exactly), and `@google/genai`'s `FunctionDeclaration.parametersJsonSchema`
 * / `GenerateContentConfig.responseJsonSchema` both accept raw JSON Schema
 * directly. So there is nothing to convert — this function exists as an
 * explicit, typed, testable BOUNDARY marker (one place to change if
 * Gemini's JSON Schema dialect ever needs something `ToolValueSchema`
 * doesn't produce), not a reimplementation of the schema. This is what
 * keeps there being exactly ONE authored schema (TypeScript type +
 * runtime validator via `matchesToolValueSchema` + this pass-through) —
 * never a second, hand-maintained "Gemini schema" that could drift from
 * the tool's real `inputSchema`.
 */
export function toGeminiJsonSchema(schema: ToolValueSchema): Record<string, unknown> {
  return schema as unknown as Record<string, unknown>;
}

/** Maps ONE `ModelToolDeclaration` (P7, provider-independent) to the
 * Gemini SDK's own `FunctionDeclaration` shape — the one place a
 * provider-specific type is allowed to exist, confined to this package. */
export function toGeminiFunctionDeclaration(declaration: ModelToolDeclaration): FunctionDeclaration {
  return {
    name: declaration.name,
    description: declaration.description,
    parametersJsonSchema: toGeminiJsonSchema(declaration.inputSchema)
  };
}
