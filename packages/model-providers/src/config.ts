/**
 * The ONE place `process.env` is read for Gemini configuration (P7 brief
 * §11). Centralizing it here means the rest of this package — and all of
 * @naqsh/core — never touches `process.env` directly, and a future config
 * source (a secrets manager, a config service) only requires changing this
 * one function's implementation, not every call site.
 *
 * Returns `null`, never throws, when `GEMINI_API_KEY` is absent — the
 * caller (whoever wires up a real provider, e.g. apps/api in a later
 * phase) decides what "no credentials" means for it; this function's job
 * is only to read and validate, not to fail the process or fall back to a
 * fake success.
 */
export interface GeminiProviderConfig {
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  maxRetries: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadGeminiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GeminiProviderConfig | null {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return null;
  }
  return {
    apiKey,
    modelId: env.GEMINI_MODEL && env.GEMINI_MODEL.length > 0 ? env.GEMINI_MODEL : "gemini-3.5-flash",
    timeoutMs: parsePositiveInt(env.GEMINI_TIMEOUT_MS, 30000),
    maxRetries: parsePositiveInt(env.GEMINI_MAX_RETRIES, 2)
  };
}
