import type { Response } from "express";
import multer from "multer";
import { AuthorizationError, EnvironmentError, ModelError, ObservationError, ToolError, WorldModelValidationError } from "@naqsh/schemas";
import { errorMeta, logger } from "./logger.js";

/**
 * Part 35's typed-error requirement, applied at the ONE seam that used to
 * flatten everything into a bare 500 (`server.ts`'s catch-all Express
 * error handler): `@naqsh/schemas`'s own error classes already carry a
 * `.kind` discriminator (`errors.ts`) -- this function is the single
 * place that maps a caught exception to an HTTP status/kind, so a real
 * `ToolError("invalid_input", ...)` reaches the client as a 422 with
 * `kind: "invalid_input"`, never a generic `internal_error`/500 that
 * discards what the throw already knew.
 *
 * Anything NOT one of these recognized domain errors (a genuine bug, an
 * unexpected exception) still falls through to 500/"internal_error" --
 * this never invents a status for an error shape it doesn't recognize.
 */
export function writeErrorResponse(err: unknown, res: Response): void {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FILE_COUNT" ? 413 : 400;
    res.status(status).json({ error: { kind: `upload_${err.code.toLowerCase()}`, message: err.message } });
    return;
  }

  if (
    err instanceof WorldModelValidationError ||
    err instanceof ToolError ||
    err instanceof AuthorizationError ||
    err instanceof EnvironmentError ||
    err instanceof ModelError ||
    err instanceof ObservationError
  ) {
    res.status(422).json({ error: { kind: err.kind, message: err.message } });
    return;
  }

  // A malformed JSON body is the CLIENT's mistake, not the server's.
  // express.json() throws a SyntaxError carrying `status: 400` and the
  // raw body; without this branch it fell through to the generic 500
  // below and told the caller "An unexpected error occurred", which is
  // both the wrong status and actively unhelpful -- observed while
  // hand-testing an endpoint with a mis-escaped path in the payload.
  //
  // The parser's own message ("Unexpected token ... in JSON at position
  // 65") is safe to return: it describes what the caller sent, not
  // anything about the server. `err.body` is deliberately NOT echoed.
  if (err instanceof SyntaxError && "body" in err && (err as unknown as { status?: unknown }).status === 400) {
    res.status(400).json({ error: { kind: "malformed_json", message: `Request body is not valid JSON: ${err.message}` } });
    return;
  }

  // Only the genuinely unrecognized/unexpected path is logged at error
  // level -- a recognized domain error above (422) is normal, expected
  // control flow (a rejected proposal, a stale approval, an invalid
  // request), not a failure worth an operator's attention. A bare 500 is.
  const requestId = (res.locals as { requestId?: string } | undefined)?.requestId;
  logger.error("unhandled_request_error", { requestId, ...errorMeta(err) });
  // AUDIT FIX: the CLIENT response never includes `err.message` for an
  // unrecognized exception -- only the SERVER-SIDE log line above does.
  // An unexpected error is, by definition, one this code did not
  // anticipate, so its message could be anything: a filesystem path, a
  // database connection string, a stack frame -- exactly the class of
  // information-disclosure a real production deployment must not hand to
  // an arbitrary caller. A caller who needs to report the failure has
  // `requestId` (also echoed on the `x-request-id` response header) to
  // give an operator, who CAN see the real message in the structured log.
  res.status(500).json({ error: { kind: "internal_error", message: "An unexpected error occurred.", requestId: requestId ?? null } });
}
