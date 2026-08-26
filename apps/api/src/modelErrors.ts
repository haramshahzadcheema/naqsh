
/**
 * Turns a raw model-provider failure into a sentence a person can act on.
 *
 * AUDIT FIX, found by running the app end to end against real Gemini:
 * when the upstream API returned 503 the workspace showed the user
 *
 *   I couldn't generate a reply ({"error":{"message":"{\n  \"error\": {\n
 *   \"code\": 503,\n    \"message\": \"This model is currently
 *   experiencing high demand...
 *
 * -- a JSON document nested inside another JSON document, pasted into a
 * chat transcript. It was honest, which matters more than being pretty,
 * but it told the reader nothing about what to DO, and it read like the
 * app had broken rather than the upstream service being busy.
 *
 * Two rules this deliberately follows:
 *
 *   1. Never invent a cause. Every sentence below is a plain-language
 *      rendering of a status the provider actually reported -- if the
 *      shape isn't recognised, the ORIGINAL message is returned
 *      unchanged rather than replaced by a vague "something went wrong",
 *      because a raw message a user can search for beats a friendly one
 *      that hides the only real evidence.
 *   2. Never claim it's temporary unless the provider said so. A 429 and
 *      a 503 are worth retrying; a 401 never is, and telling someone to
 *      "try again shortly" on a bad API key wastes their time.
 */

/** Digs the innermost `{ error: { code, message } }` out of a payload
 * that may be a JSON string nested one or more levels deep -- which is
 * exactly how Google's API surfaces upstream failures through the SDK. */
function extractUpstream(raw: string): { code: number | null; message: string } | null {
  let current: unknown = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed.startsWith("{")) return null;
      try {
        current = JSON.parse(trimmed) as unknown;
      } catch {
        return null;
      }
      continue;
    }
    if (typeof current !== "object" || current === null) return null;
    const error = (current as { error?: unknown }).error;
    if (error === undefined) return null;
    if (typeof error === "string") {
      current = error;
      continue;
    }
    if (typeof error === "object" && error !== null) {
      const inner = error as { code?: unknown; message?: unknown };
      // A nested JSON string in `message` is the real payload.
      if (typeof inner.message === "string" && inner.message.trim().startsWith("{")) {
        current = inner.message;
        continue;
      }
      return {
        code: typeof inner.code === "number" ? inner.code : null,
        message: typeof inner.message === "string" ? inner.message : ""
      };
    }
    return null;
  }
  return null;
}

/** Plain-language sentence for a status the provider genuinely reported. */
function sentenceForCode(code: number | null, kind: string | undefined): string | null {
  if (code === 503) return "The model is temporarily overloaded upstream. This usually clears on its own -- try again in a moment, or switch model.";
  if (code === 429) return "The model provider is rate-limiting this key right now. Wait a moment before retrying, or switch model.";
  if (code === 401 || code === 403) return "The model provider rejected the API key. Check that GEMINI_API_KEY is set correctly on the server -- retrying will not help until it is.";
  if (code === 404) return "The model provider does not recognise the requested model. Pick a different reasoning model in Settings.";
  if (code !== null && code >= 500) return "The model provider reported a server-side error. This is upstream, not in your project -- try again shortly.";
  if (code === 400) return "The model provider rejected the request as malformed.";

  // No usable HTTP code -- fall back to the kind the provider classified.
  if (kind === "timeout") return "The model took too long to respond. Try again, or switch to a faster model.";
  if (kind === "rate_limit") return "The model provider is rate-limiting this key right now. Wait a moment before retrying.";
  if (kind === "authentication_failure") return "The model provider rejected the API key. Check that GEMINI_API_KEY is set correctly on the server.";
  if (kind === "api_unavailable") return "The model provider is unreachable right now. Check the server's network connection, then try again.";
  return null;
}

/**
 * The user-facing sentence for a failed model call. Returns the original
 * message untouched when nothing better can be said honestly.
 */
/** Structural, not nominal: the several error types across this codebase
 * (ModelError, RequirementInterpretationError, ...) all carry the same
 * `{ kind, message }` shape, and this only ever reads those two fields.
 * Accepting the shape rather than one named type lets every caller that
 * leaks a raw provider message use it, which is the entire point. */
export interface DescribableError {
  kind?: string;
  message?: string;
}

export function describeModelError(error: DescribableError | undefined): string {
  const raw = error?.message?.trim();
  if (!raw) return "The model call failed without reporting a reason.";

  const upstream = extractUpstream(raw);
  const sentence = sentenceForCode(upstream?.code ?? null, error?.kind);
  if (sentence) return sentence;

  // Recognised the envelope but not the status: surface the provider's
  // OWN human-readable message rather than the JSON wrapper around it.
  if (upstream && upstream.message) return upstream.message;
  return raw;
}
