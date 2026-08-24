/**
 * A small, dependency-free structured logger -- one JSON line per event to
 * stdout (info/warn) or stderr (error), never a framework this repo would
 * need a new npm dependency for. "Production-grade" does not mean
 * "pulls in winston/pino for a single-process local-JSON-store API" (see
 * this repo's own "prefer boring infrastructure" discipline) -- it means a
 * failure is diagnosable from the process's own output without attaching
 * a debugger, which a consistent `{timestamp, level, message, ...meta}`
 * shape already provides.
 *
 * NEVER log secrets or raw user/model content: `meta` fields are always
 * ids, counts, durations, statuses -- structural facts about a request,
 * never the text of a chat message, a file's content, an API key, or a
 * model response. Every call site in this codebase follows that
 * discipline; this module doesn't enforce it mechanically (there is no
 * generic way to know "this string might be a secret"), but every caller
 * is expected to.
 */

export type LogMeta = Record<string, string | number | boolean | null | undefined>;

function write(stream: NodeJS.WriteStream, level: "info" | "warn" | "error", message: string, meta?: LogMeta): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...meta });
  stream.write(line + "\n");
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    write(process.stdout, "info", message, meta);
  },
  warn(message: string, meta?: LogMeta): void {
    write(process.stderr, "warn", message, meta);
  },
  error(message: string, meta?: LogMeta): void {
    write(process.stderr, "error", message, meta);
  }
};

/** Reduces any thrown value to the two fields worth logging -- never the
 * full stack in a structured meta line (stacks are multi-line and would
 * break the one-line-per-event contract; a caller that genuinely needs a
 * stack trace for local debugging still has it via the error object
 * itself, e.g. in `asyncHandler`'s own dev-mode path). */
export function errorMeta(error: unknown): { errorKind: string; errorMessage: string } {
  return {
    errorKind: error instanceof Error ? error.constructor.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error)
  };
}
