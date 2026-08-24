import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Bundles the real, unmodified apps/api server into one flat JS file for
 * the Docker image -- the SAME real problem and the SAME fix already
 * proven working for apps/desktop's packaging
 * (apps/desktop/scripts/build-resources.mjs): every workspace package's
 * package.json deliberately sets `"main": "./src/index.ts"` so the fast
 * `tsx watch` dev loop always sees live source, never a stale `dist/`
 * build -- but that same field means plain `node` (no tsx loader hook)
 * cannot resolve `@naqsh/core` et al. at all when running compiled
 * output, confirmed by actually running `node apps/api/dist/start.js`
 * and hitting `ERR_UNKNOWN_FILE_EXTENSION` for a `.ts` file. esbuild
 * sidesteps this entirely by inlining the real TypeScript source of
 * every workspace dependency directly into one bundle at build time,
 * rather than resolving `@naqsh/core` as a runtime import.
 *
 * ESM output (not CJS) for the same reason as the desktop bundle:
 * `import.meta.url` is genuinely used (config path resolution,
 * @naqsh/adapters' FreeCAD runner-script path). The `banner` injects a
 * real `createRequire` so esbuild's CJS-interop shim (needed for
 * `express`/`body-parser`/its `depd` dependency) resolves through an
 * actual `require` instead of a throwing stub -- the identical fix
 * verified working in apps/desktop/scripts/build-resources.mjs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, "..");
const outfile = join(apiRoot, "dist", "bundle.mjs");

mkdirSync(join(apiRoot, "dist"), { recursive: true });

await build({
  entryPoints: [join(apiRoot, "src", "start.ts")],
  banner: { js: "import { createRequire as __naqshCreateRequire } from 'node:module';\nconst require = __naqshCreateRequire(import.meta.url);" },
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  logLevel: "info"
});

console.log("[build-container-bundle] wrote:", outfile);
