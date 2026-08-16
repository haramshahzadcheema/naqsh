import { execFile } from "node:child_process";
import type { EnvironmentErrorKind } from "@naqsh/schemas";

/**
 * The ENTIRE Node.js <-> FreeCAD process boundary (Phase 12 Step 4). This
 * is the one file in the whole repository allowed to spawn a child
 * process for FreeCAD -- `freecad-adapter.ts` never touches
 * `node:child_process` directly, and nothing in `packages/core` or
 * `packages/schemas` may import this file at all (enforced in
 * `packages/core/test/repo-boundaries.test.ts`'s P12 guard block, mirroring
 * every other environment/model-provider boundary this repo already has).
 *
 * Runtime strategy: FreeCAD's Python API has no Node.js binding, so each
 * operation is executed by spawning `freecadcmd` (FreeCAD's own headless
 * CLI) against `packages/adapters/freecad/runner.py` -- a ONE-SHOT
 * subprocess per call, not a persistent server. This keeps the design
 * simple and crash-safe (a wedged/crashed FreeCAD process can never corrupt
 * adapter state across calls, because there is no cross-call state to
 * corrupt) at the cost of FreeCAD's own startup latency per call -- an
 * explicit, documented tradeoff for Phase 12's narrow inspection/save
 * scope, not an oversight. See packages/adapters/freecad/README.md for the
 * full protocol.
 *
 * Security boundary (Phase 12 Step 14): `runFreecadOperation` only ever
 * sends `{operation, params}` where `operation` must be one of
 * runner.py's fixed, named operations -- there is no "execute this Python"
 * parameter anywhere in this function's signature, and nothing here
 * concatenates caller data into a shell command (execFile is invoked with
 * an argv array, never a shell string).
 */

const RESULT_PREFIX = "@@NAQSH_RESULT@@";

export interface FreeCadRuntimeConfig {
  freecadCmdPath: string;
  runnerScriptPath: string;
  timeoutMs: number;
}

export type FreeCadRuntimeResult =
  | { status: "success"; data: unknown }
  | { status: "error"; kind: EnvironmentErrorKind; message: string };

const KNOWN_ERROR_KINDS: readonly EnvironmentErrorKind[] = [
  "not_connected",
  "object_not_found",
  "unsupported_capability",
  "invalid_operation",
  "environment_failure",
  "conflict"
];

function toEnvironmentErrorKind(value: unknown): EnvironmentErrorKind {
  return typeof value === "string" && (KNOWN_ERROR_KINDS as readonly string[]).includes(value)
    ? (value as EnvironmentErrorKind)
    : "environment_failure";
}

function findResultLine(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(RESULT_PREFIX)) return line.slice(RESULT_PREFIX.length);
  }
  return null;
}

function parseResultLine(line: string): FreeCadRuntimeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      status: "error",
      kind: "environment_failure",
      message: `FreeCAD runner produced an unparsable result line: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) {
    return { status: "error", kind: "environment_failure", message: "FreeCAD runner result line was not a valid envelope" };
  }
  const record = parsed as { status: unknown; data?: unknown; kind?: unknown; message?: unknown };
  if (record.status === "success") {
    return { status: "success", data: record.data };
  }
  return {
    status: "error",
    kind: toEnvironmentErrorKind(record.kind),
    message: typeof record.message === "string" ? record.message : "FreeCAD runner reported an unspecified error"
  };
}

/**
 * Runs exactly one named FreeCAD operation and returns a structured
 * result -- never throws, never rejects for an expected failure mode
 * (FreeCAD not installed, timeout, a genuine FreeCAD-side error), matching
 * the same "adapter/runtime boundary never makes a caller wrap it in
 * try/catch" discipline `EnvironmentAdapter` (P5), `executeTool` (P3), and
 * `ModelProvider.generate` (P7) already established.
 */
export async function runFreecadOperation(
  config: FreeCadRuntimeConfig,
  operation: string,
  params: Record<string, unknown>
): Promise<FreeCadRuntimeResult> {
  const encoded = Buffer.from(JSON.stringify({ operation, params }), "utf8").toString("base64");

  let stdout: string;
  try {
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        config.freecadCmdPath,
        [config.runnerScriptPath, encoded],
        { timeout: config.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdoutResult) => {
          if (error) reject(Object.assign(error, { stdout: stdoutResult }));
          else resolve({ stdout: stdoutResult });
        }
      );
    });
    stdout = result.stdout;
  } catch (error) {
    const errnoError = error as NodeJS.ErrnoException & { stdout?: string; killed?: boolean; signal?: string | null };
    // A non-zero exit / spawn failure is unexpected (runner.py always
    // exits 0 and reports failure via the @@NAQSH_RESULT@@ envelope
    // itself) -- but still try to recover a result line from whatever
    // stdout WAS captured before falling back to a generic message, so a
    // genuine runner-side crash still surfaces its own structured error
    // rather than being masked by execFile's generic failure.
    const partialStdout = errnoError.stdout ?? "";
    const resultLine = findResultLine(partialStdout);
    if (resultLine) return parseResultLine(resultLine);

    if (errnoError.code === "ENOENT") {
      return {
        status: "error",
        kind: "environment_failure",
        message: `FreeCAD command not found at "${config.freecadCmdPath}" -- FreeCAD is not available in this environment`
      };
    }
    if (errnoError.killed || errnoError.signal) {
      return { status: "error", kind: "environment_failure", message: `FreeCAD operation "${operation}" timed out after ${config.timeoutMs}ms` };
    }
    return { status: "error", kind: "environment_failure", message: errnoError.message ?? String(error) };
  }

  const resultLine = findResultLine(stdout);
  if (!resultLine) {
    return { status: "error", kind: "environment_failure", message: "FreeCAD runner produced no result line" };
  }
  return parseResultLine(resultLine);
}
