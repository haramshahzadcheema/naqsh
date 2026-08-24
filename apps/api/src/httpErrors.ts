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

  const message = err instanceof Error ? err.message : String(err);
  // Only the genuinely unrecognized/unexpected path is logged at error
  // level -- a recognized domain error above (422) is normal, expected
  // control flow (a rejected proposal, a stale approval, an invalid
  // request), not a failure worth an operator's attention. A bare 500 is.
  logger.error("unhandled_request_error", { requestId: (res.locals as { requestId?: string } | undefined)?.requestId, ...errorMeta(err) });
  res.status(500).json({ error: { kind: "internal_error", message } });
}
