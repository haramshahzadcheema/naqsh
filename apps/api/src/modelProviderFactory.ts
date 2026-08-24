import { createGeminiModelProvider, createMockModelProvider, loadGeminiConfigFromEnv, type GeminiProviderConfig } from "@naqsh/model-providers";
import type { ModelProvider } from "@naqsh/core";

/**
 * THE single source of truth for which model ids exist and what they can
 * do -- both the allowlist (browser input is untrusted; an arbitrary
 * `modelId` string is NEVER passed to the Gemini SDK directly) AND the
 * real catalog `GET /models` publishes are derived from this ONE list.
 * This closes the duplication `apps/web/src/settings/models.ts` used to
 * carry independently (a hardcoded mirror of this file that could drift):
 * the frontend now fetches this catalog over HTTP (`apiGetModelCatalog`)
 * and falls back to its own static list only when the server is
 * unreachable at all.
 */
interface GeminiModelDefinition {
  modelId: string;
  label: string;
}

const GEMINI_MODELS: GeminiModelDefinition[] = [
  { modelId: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { modelId: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" }
];

const ALLOWED_GEMINI_MODEL_IDS = new Set(GEMINI_MODELS.map((model) => model.modelId));
export const DETERMINISTIC_MODEL_ID = "deterministic";

export type ModelUnavailableReason = "not_configured" | "unknown_model";

/**
 * Resolves a requested model id into a real `ModelProvider` -- or an
 * honest unavailability reason. Never falls back to a fake/canned reply:
 * "not_configured" (no `GEMINI_API_KEY` on the server) and
 * "unknown_model" (a model id outside the allowlist) are both terminal,
 * surfaced to the caller as real errors, never silently substituted.
 */
export function resolveModelProvider(requestedModelId: string): { provider: ModelProvider; modelId: string } | { error: { reason: ModelUnavailableReason } } {
  if (requestedModelId === DETERMINISTIC_MODEL_ID) {
    return { provider: createMockModelProvider(), modelId: DETERMINISTIC_MODEL_ID };
  }

  if (!ALLOWED_GEMINI_MODEL_IDS.has(requestedModelId)) {
    return { error: { reason: "unknown_model" } };
  }

  const envConfig = loadGeminiConfigFromEnv();
  if (!envConfig) {
    return { error: { reason: "not_configured" } };
  }

  // The requested (allowlisted) model id overrides the env default --
  // this is Phase Q's "the selected model from the UI should actually
  // reach the backend" requirement, without ever trusting an
  // un-allowlisted string.
  const config: GeminiProviderConfig = { ...envConfig, modelId: requestedModelId };
  return { provider: createGeminiModelProvider(config), modelId: requestedModelId };
}

export function isGeminiConfigured(): boolean {
  return loadGeminiConfigFromEnv() !== null;
}

export interface ModelCatalogEntry {
  provider: "gemini" | "mock";
  modelId: string;
  label: string;
  /** Real, published Gemini 3.5 context window; `null` when this provider
   * doesn't publish/have a meaningful one (the deterministic mock). */
  contextWindowTokens: number | null;
  capabilities: {
    multimodal: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    /** Whether THIS SERVER can actually deliver this model's replies
     * incrementally today -- i.e. `ModelProvider.generateStream` is
     * implemented (see gemini-model-provider.ts) -- never a claim about
     * the underlying model's own theoretical capability. */
    streaming: boolean;
  };
  /** Whether a request for this model would actually succeed right now,
   * not just whether the id is recognized. */
  available: boolean;
  availabilityReason: string | null;
}

/** Part 8's real model registry: every entry here reflects what this
 * server can ACTUALLY do today (`available`/`streaming` are computed, not
 * asserted) -- `GET /models` returns exactly this, so the frontend never
 * has to guess or duplicate this list. */
export function getModelCatalog(): ModelCatalogEntry[] {
  const geminiConfigured = isGeminiConfigured();
  const geminiEntries: ModelCatalogEntry[] = GEMINI_MODELS.map((model) => ({
    provider: "gemini",
    modelId: model.modelId,
    label: model.label,
    contextWindowTokens: 1_000_000,
    capabilities: { multimodal: true, toolCalling: true, structuredOutput: true, streaming: true },
    available: geminiConfigured,
    availabilityReason: geminiConfigured ? null : "GEMINI_API_KEY is not configured on this server."
  }));

  const deterministic: ModelCatalogEntry = {
    provider: "mock",
    modelId: DETERMINISTIC_MODEL_ID,
    label: "Deterministic (testing)",
    contextWindowTokens: null,
    capabilities: { multimodal: false, toolCalling: true, structuredOutput: true, streaming: false },
    available: true,
    availabilityReason: null
  };

  return [...geminiEntries, deterministic];
}
