import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Produces everything `electron-builder` packages alongside the compiled
 * desktop shell (`apps/desktop/dist`) so the installed app is genuinely
 * standalone -- it does NOT depend on the monorepo's `node_modules`/`tsx`
 * being present on the end user's machine the way dev mode does.
 *
 *   resources/api/dist/bundle.mjs  -- apps/api, esbuild-bundled to one file
 *   resources/api/freecad/runner.py -- copied so `import.meta.url`-relative
 *                                       resolution in the bundled adapter
 *                                       code (packages/adapters/freecad-
 *                                       adapter.ts's defaultRunnerScriptPath)
 *                                       still finds it at the same relative
 *                                       "../freecad/runner.py" path it uses
 *                                       from packages/adapters/dist/.
 *   resources/web/                  -- the built apps/web UI (apps/web/dist)
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const resources = join(desktopRoot, "resources");

// Deliberately does NOT `rm -rf` the resources directory before writing:
// under this repo's Desktop-folder location, Windows periodically holds a
// just-written directory's own handle busy (indexer/Defender's Controlled
// Folder Access on Desktop/Documents/etc.) long enough that a recursive
// `rmSync` reliably fails with EBUSY on the very next run, even after
// retries with backoff. `esbuild`'s `outfile` and `cpSync(..., {force:
// true})` both overwrite in place without needing the parent directory
// removed first, so every artifact below is just overwritten instead.
mkdirSync(resources, { recursive: true });

await build({
  entryPoints: [join(repoRoot, "apps", "api", "src", "start.ts")],
  // ESM output (`.mjs`) so `import.meta.url` -- genuinely used by both
  // `start.ts`'s NAQSH_DATA_DIR default AND
  // packages/adapters/freecad-adapter.ts's runner.py path resolution --
  // keeps working (it's simply empty under esbuild's "cjs" format, no
  // workaround exists for that). The tradeoff: esbuild's own CJS-interop
  // helper for bundled CommonJS deps (express -> body-parser -> depd)
  // throws "Dynamic require of ... is not supported" by default, because
  // its stub `__require` has no real `require` to fall back to in an ESM
  // module. The documented fix is this `banner` -- inject Node's real
  // `createRequire(import.meta.url)` so esbuild's shim resolves through
  // an actual `require` instead of the throwing stub. Verified by
  // actually running the bundle standalone and hitting its real `/health`
  // route (see this script's own usage notes / the desktop README).
  banner: { js: "import { createRequire as __naqshCreateRequire } from 'node:module';\nconst require = __naqshCreateRequire(import.meta.url);" },
  outfile: join(resources, "api", "dist", "bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  logLevel: "info"
});

mkdirSync(join(resources, "api", "freecad"), { recursive: true });
cpSync(
  join(repoRoot, "packages", "adapters", "freecad", "runner.py"),
  join(resources, "api", "freecad", "runner.py"),
  { force: true }
);

const webDist = join(repoRoot, "apps", "web", "dist");
if (!existsSync(webDist)) {
  throw new Error(`apps/web/dist not found at ${webDist} -- run "npm run build --workspace=@naqsh/web" first`);
}
cpSync(webDist, join(resources, "web"), { recursive: true, force: true });

console.log("[build-resources] wrote:", resources);
