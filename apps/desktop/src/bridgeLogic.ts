import { join } from "node:path";

/**
 * The pure decision logic behind `main.ts`'s Electron wiring, deliberately
 * pulled out of that file and kept free of any `electron` import. Electron's
 * own modules (`app`, `BrowserWindow`, `desktopCapturer`, ...) only exist
 * inside a running Electron process, which makes `main.ts` itself
 * untestable under a plain Node test runner. Every function here is the
 * actual behavior worth verifying -- argv/env construction, source mapping,
 * selection validation, capture-request resolution -- with no Electron
 * dependency, so it can run under the same `node --test` + `tsx` setup
 * every other package in this repo already uses.
 */

export interface CaptureSourceLike {
  id: string;
  name: string;
  thumbnail: { isEmpty(): boolean; toDataURL(): string };
}

export interface MappedCaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
}

/** Mirrors the `desktop:list-capture-sources` IPC handler's mapping step. */
export function mapCaptureSources(sources: CaptureSourceLike[]): MappedCaptureSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL()
  }));
}

export type SelectCaptureSourceResult =
  | { ok: true; sourceId: string }
  | { ok: false; error: string };

/** Mirrors the `desktop:select-capture-source` IPC handler's validation:
 * reject a malformed id outright, then reject an id that doesn't match any
 * currently-available source rather than silently arming nothing. */
export function validateCaptureSourceSelection(
  sourceId: unknown,
  availableSources: Array<{ id: string }>
): SelectCaptureSourceResult {
  if (typeof sourceId !== "string" || sourceId.length === 0) {
    return { ok: false, error: "sourceId must be a non-empty string" };
  }
  if (!availableSources.some((s) => s.id === sourceId)) {
    return { ok: false, error: `No capture source with id "${sourceId}" is currently available -- it may have closed.` };
  }
  return { ok: true, sourceId };
}

export type DisplayMediaResolution =
  | { grant: false }
  | { grant: true; sourceId: string };

/** Mirrors `setDisplayMediaRequestHandler`'s callback decision: refuse
 * outright when nothing was armed via the IPC round trip, and refuse (never
 * fall back to some default) when the armed id no longer matches a real
 * source -- there is no path to a capture grant the renderer didn't just
 * explicitly request through `selectCaptureSource`. */
export function resolveDisplayMediaRequest(
  pendingSourceId: string | null,
  availableSources: Array<{ id: string }>
): DisplayMediaResolution {
  if (!pendingSourceId) return { grant: false };
  const match = availableSources.find((s) => s.id === pendingSourceId);
  if (!match) return { grant: false };
  return { grant: true, sourceId: pendingSourceId };
}

export interface ApiServerSpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Mirrors `startApiServer()`'s DEV spawn construction: the real,
 * unmodified `apps/api` entry point, invoked as `node <tsx-cli.mjs>
 * <entry>` -- never through a `.cmd`/`.ps1` shell shim, so `spawn()` never
 * needs `shell: true` (this repo spawns argv arrays only, never a shell
 * string). Only valid inside the monorepo checkout (dev mode) -- a
 * packaged install has no `tsx`/`node_modules` on the end user's machine,
 * see `buildPackagedApiServerSpawnConfig` below for that case. */
export function buildApiServerSpawnConfig(
  repoRoot: string,
  execPath: string,
  baseEnv: NodeJS.ProcessEnv
): ApiServerSpawnConfig {
  const apiEntry = join(repoRoot, "apps", "api", "src", "start.ts");
  const tsxCliScript = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return {
    command: execPath,
    args: [tsxCliScript, apiEntry],
    cwd: join(repoRoot, "apps", "api"),
    env: { ...baseEnv, PORT: baseEnv.PORT ?? "3001", ELECTRON_RUN_AS_NODE: "1" }
  };
}

/** The PACKAGED counterpart: no `tsx`, no monorepo `node_modules` --
 * `scripts/build-resources.mjs` esbuild-bundles `apps/api` into one plain
 * JS file at `<resourcesPath>/api/dist/bundle.mjs` ahead of time, so this
 * just runs it directly with the Electron binary acting as plain Node
 * (`ELECTRON_RUN_AS_NODE`). `cwd` is the bundle's own `api/` resource
 * directory so its `NAQSH_DATA_DIR`-relative defaults land somewhere
 * sane rather than inside the installed app's read-only Program Files
 * tree. */
export function buildPackagedApiServerSpawnConfig(
  resourcesPath: string,
  execPath: string,
  baseEnv: NodeJS.ProcessEnv
): ApiServerSpawnConfig {
  return {
    command: execPath,
    args: [join(resourcesPath, "api", "dist", "bundle.mjs")],
    cwd: join(resourcesPath, "api"),
    env: { ...baseEnv, PORT: baseEnv.PORT ?? "3001", ELECTRON_RUN_AS_NODE: "1" }
  };
}

/** Where the packaged app's built UI lives, relative to Electron's own
 * `resourcesPath` -- mirrors `scripts/build-resources.mjs`'s
 * `resources/web/` output (a copy of `apps/web/dist`). */
export function resolvePackagedWebIndexPath(resourcesPath: string): string {
  return join(resourcesPath, "web", "index.html");
}
