/**
 * The reasoning-model choices offered in Settings. Grounded in the one
 * real model integration this repository has (`@naqsh/model-providers`'s
 * Gemini provider, configured via `GEMINI_MODEL` / `GEMINI_API_KEY` --
 * see `packages/model-providers/src/config.ts` and
 * `gemini-model-provider.ts`) plus its deterministic mock/testing
 * provider (`mock-model-provider.ts`). No invented model names.
 *
 * Selecting one here persists a PREFERENCE the UI can display and would
 * hand to a real backend once `apps/api` exposes an HTTP endpoint for it
 * -- there is still no live model connection reachable from the browser,
 * so this does not change what Naqsh's replies actually are today. That
 * boundary is stated once, in the Settings panel itself, rather than
 * repeated on every message.
 */
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  note: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "Gemini", note: "Default — fast, frontier-level reasoning." },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "Gemini", note: "Fastest, lightest weight." },
  { id: "deterministic", label: "Deterministic (testing)", provider: "Mock", note: "Fixed, scripted responses — used in tests and offline demos." }
];

export const DEFAULT_MODEL_ID = "gemini-3.5-flash";
