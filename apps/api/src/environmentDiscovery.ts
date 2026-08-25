import { existsSync, readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createFreeCadAdapter } from "@naqsh/adapters";

/**
 * Real, bounded discovery for locally-installed engineering environments --
 * today, exactly one: FreeCAD. This module never scans the filesystem
 * (Part 12 Step 4 of the environment-platform brief): it checks a SMALL,
 * fixed set of well-known locations (an env var, one non-recursive listing
 * of the platform's standard install root, one well-known macOS/Linux
 * path) and, for each candidate, never trusts the filename alone -- it
 * runs the adapter's own real `health()` operation (the SAME sanctioned
 * `freecad-runtime.ts` subprocess boundary every other FreeCAD call
 * already goes through: a fixed runner script, a fixed "health"
 * operation, argv-array `execFile`, never a shell string) before ever
 * calling a candidate path "connectable". A file merely existing at a
 * plausible path is never enough on its own.
 *
 * `apps/api` is allowed to do this: it imports `createFreeCadAdapter` from
 * `@naqsh/adapters`'s package root (not a path containing "freecad", and
 * never `node:child_process` directly) -- the exact same import shape
 * `projectRuntime.ts` already uses for `createMockCadEnvironment`. The
 * real subprocess spawn stays entirely inside `freecad-runtime.ts`
 * (`packages/adapters/src/freecad-runtime.ts`), the one sanctioned
 * boundary in the whole repository, enforced by
 * `packages/core/test/repo-boundaries.test.ts`.
 */

export interface EnvironmentAvailability {
  kind: "freecad";
  name: string;
  /** "unavailable": no candidate location produced a real, healthy
   * response. "connectable": a real FreeCAD install answered a genuine
   * health check -- honestly distinct from "connected" (which additionally
   * requires an active project session; see `EnvironmentSessionStatus`
   * in @naqsh/schemas, unchanged by this module). */
  status: "unavailable" | "connectable";
  reason: string | null;
  resolvedCommandPath: string | null;
  version: string | null;
  checkedAt: string;
  /** The adapter's OWN declared capabilities (`describe().capabilities`)
   * -- real regardless of whether FreeCAD is actually reachable right now
   * (constructing the adapter is synchronous and never spawns a process,
   * see `createFreeCadAdapter`'s own doc comment), so the UI never has to
   * hardcode a guess that could drift from what the adapter really
   * supports. */
  capabilities: string[];
}

const FREECAD_CAPABILITIES = createFreeCadAdapter().describe().capabilities;

const DISCOVERY_CACHE_TTL_MS = 60_000;
let cached: { result: EnvironmentAvailability; expiresAt: number } | null = null;

/** Every location this module will ever look at -- bounded and fixed, not
 * a filesystem walk. The Windows branch does exactly ONE non-recursive
 * `readdirSync` of the standard install root to find a version-suffixed
 * "FreeCAD <version>" directory (the real install layout on this
 * platform), never anything deeper.
 *
 * Exported (not just used internally by `discoverFreecadUncached` below):
 * `projectRuntime.ts`'s `createEnvironmentAdapterFor` reuses this SAME
 * synchronous resolution when constructing the real adapter a connect
 * action actually uses -- AUDIT FIX for a real, reproduced-live gap where
 * this module's own discovery correctly found and reported a real
 * `resolvedCommandPath`, while the actual connect attempt separately
 * defaulted to the bare "freecadcmd" (PATH-only) fallback and failed with
 * "command not found", even though a real, working install existed one
 * scan away. Deliberately does NOT reuse the async health-probing half of
 * discovery here -- that would require a much larger refactor of
 * `createEnvironmentAdapterFor`'s (and its one caller's) synchronous
 * signature; picking the first candidate that exists on disk is enough to
 * fix the actual bug, and the adapter's own real `connect()`/health call
 * still fails honestly if that candidate isn't genuinely FreeCAD. */
export function candidateCommandPaths(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.NAQSH_FREECAD_CMD;
  if (fromEnv) candidates.push(fromEnv);

  if (platform() === "win32") {
    for (const root of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^freecad\b/i.test(entry)) continue;
        candidates.push(join(root, entry, "bin", "freecadcmd.exe"));
      }
    }
  } else if (platform() === "darwin") {
    candidates.push("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd");
  } else {
    candidates.push("/usr/bin/freecadcmd", "/usr/local/bin/freecadcmd", "/snap/bin/freecad.freecadcmd");
  }

  // PATH fallback, resolved by execFile itself -- never a path this module
  // constructed or trusted on the strength of its own filename.
  candidates.push("freecadcmd");
  return candidates;
}

/** Runs the real health-check subprocess boundary against one candidate --
 * never executes anything beyond the fixed "health" operation. Returns
 * `null` (not an error) for a candidate that simply isn't FreeCAD at all,
 * so the caller can move on to the next one without treating "this
 * particular path was wrong" as a hard failure. */
async function probe(commandPath: string): Promise<{ version: string | null } | null> {
  const adapter = createFreeCadAdapter({ freecadCmdPath: commandPath, timeoutMs: 15_000 });
  const result = await adapter.health();
  if (result.status !== "success") return null;
  const data = result.data as { status?: unknown; message?: unknown } | null;
  if (!data || data.status !== "healthy") return null;
  const message = typeof data.message === "string" ? data.message : "";
  const versionMatch = /FreeCAD\s+([^\s]+)\s+reachable/i.exec(message);
  return { version: versionMatch ? versionMatch[1]! : null };
}

async function discoverFreecadUncached(): Promise<EnvironmentAvailability> {
  const checkedAt = new Date().toISOString();
  const candidates = candidateCommandPaths();
  const attempted: string[] = [];

  for (const candidate of candidates) {
    // A bare "freecadcmd" PATH fallback has no file to existence-check
    // (execFile resolves it against PATH itself); an absolute candidate
    // this module built IS checked first so a probe is never attempted
    // against a path that plainly doesn't exist.
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (!existsSync(candidate)) continue;
    }
    attempted.push(candidate);
    const probed = await probe(candidate);
    if (probed) {
      return { kind: "freecad", name: "FreeCAD", status: "connectable", reason: null, resolvedCommandPath: candidate, version: probed.version, checkedAt, capabilities: FREECAD_CAPABILITIES };
    }
  }

  return {
    kind: "freecad",
    name: "FreeCAD",
    status: "unavailable",
    reason: attempted.length > 0 ? `Checked ${attempted.length} candidate location(s); none responded to a real health check.` : "No FreeCAD installation was found in any known location.",
    resolvedCommandPath: null,
    version: null,
    checkedAt,
    capabilities: FREECAD_CAPABILITIES
  };
}

/** Cached for `DISCOVERY_CACHE_TTL_MS` -- a real health check spawns a
 * genuine FreeCAD process (multi-second cold start), so re-running it on
 * every request would make an unrelated page load pay FreeCAD's own
 * startup cost. `forceRefresh` bypasses the cache for an explicit
 * "recheck" action (the Environment Center's own Reconnect/Refresh
 * control), never for ordinary reads. */
export async function discoverFreecad(forceRefresh = false): Promise<EnvironmentAvailability> {
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.result;
  const result = await discoverFreecadUncached();
  cached = { result, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS };
  return result;
}
