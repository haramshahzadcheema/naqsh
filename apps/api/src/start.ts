import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { errorMeta, logger } from "./logger.js";
import { resolveEnvironment } from "./config.js";

// A genuinely unhandled exception/rejection means the process is in an
// unknown state -- Node's default behavior (crash) is still correct, but
// its default OUTPUT is a raw, unstructured stack trace easy to miss in a
// log aggregator that only indexes JSON lines. Log it in the same
// structured shape as everything else, THEN let the process exit (never
// swallow and keep running in a state nothing here can reason about).
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", errorMeta(error));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", errorMeta(reason));
  process.exit(1);
});

const port = Number(process.env.PORT ?? 3001);
const dataDir = process.env.NAQSH_DATA_DIR ?? join(fileURLToPath(new URL("..", import.meta.url)), "data");
const maxCachedRuntimes = (() => {
  const raw = process.env.NAQSH_MAX_CACHED_RUNTIMES;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`NAQSH_MAX_CACHED_RUNTIMES must be a positive number if set -- got "${raw}".`);
  }
  return parsed;
})();

// `createServer` itself throws synchronously (config.ts's `resolveCorsConfig`)
// if this is a production start with no CORS allowlist configured -- a
// startup failure here is exactly the "fail clearly when required
// configuration is missing" behavior this application's principles ask
// for, not a bug to catch and paper over.
const app = createServer({ dataDir, maxCachedRuntimes });

const server = app.listen(port, () => {
  logger.info("server_started", { port, dataDir, environment: resolveEnvironment(process.env.NODE_ENV) });
});

/**
 * Real graceful shutdown, not just "the process happens to die eventually."
 * `server.close()` stops accepting NEW connections and waits for
 * in-flight requests to finish on their own (each request's own handler
 * already persists what it needs to before responding -- see
 * `server.ts`'s `res.on("finish")` runtime-state hook -- so a request
 * that completes normally during this drain period is fully durable).
 * The force-exit timer exists because a genuinely stuck connection
 * (a client that never closes its socket) would otherwise leave the
 * process hanging forever on a signal that's supposed to stop it.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server_shutting_down", { signal });
  const forceExit = setTimeout(() => {
    logger.warn("server_shutdown_forced", { signal, reason: "in-flight connections did not drain within the grace period" });
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close((error) => {
    if (error) {
      logger.error("server_shutdown_error", { signal, errorMessage: error.message });
      process.exit(1);
      return;
    }
    logger.info("server_shutdown_complete", { signal });
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
