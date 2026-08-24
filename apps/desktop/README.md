# @naqsh/desktop

The real native bridge for NAQSH's environment platform (Part 22 of the
environment-platform brief) -- the one capability a browser tab
structurally cannot provide for itself: **enumerating and live-capturing
another application's window**.

This is not a rewrite of NAQSH. It is a thin Electron shell around the
exact same `apps/web` UI and `apps/api` server every browser-based session
already uses, plus one additional, narrow, permission-gated capability.

## What this genuinely does

- Runs the real, unmodified `apps/api` server as a local child process
  (same code path as `npm run dev --workspace=@naqsh/api`).
- Loads the real, unmodified `apps/web` UI.
- Exposes a real live window-capture bridge via Chromium's own
  `desktopCapturer` + `setDisplayMediaRequestHandler` APIs -- verified
  end-to-end against a real, running FreeCAD 1.1.3 window during
  development: real source enumeration, a real `live` `MediaStreamTrack`,
  real captured resolution.

## What it does NOT do

- No COM automation, no native scripting API integration for SolidWorks,
  CATIA, Siemens NX, or any other vendor -- those need vendor-specific,
  officially-supported automation interfaces this repository does not
  implement.
- No continuous background capture, no full-desktop recording by default,
  no capture that starts without the user explicitly picking a window
  through the real UI first.
- No transmission of captured frames anywhere -- today, a captured stream
  is only ever rendered locally in the NAQSH window (`LiveViewPanel`,
  `apps/web/src/components/environment/LiveViewPanel.tsx`). Sending frames
  to a model for vision-based analysis is a real, separate feature this
  pass does not add.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on
  the renderer -- the loaded page (the same `apps/web` UI a browser tab
  runs) has **zero** direct Node/Electron access.
- The preload script (`src/preload.cts`, deliberately compiled as
  CommonJS -- see its own comment for why) exposes exactly three IPC-backed
  functions on `window.naqshDesktop`: `listCaptureSources`,
  `selectCaptureSource`, `cancelCaptureSelection`. Nothing else.
- A capture can only ever start for a window the renderer explicitly
  selected via `selectCaptureSource(id)` immediately beforehand --
  `setDisplayMediaRequestHandler` in `main.ts` refuses any request with
  nothing armed. There is no ambient/standing capture permission.
- The child `apps/api` process is spawned via an argv array
  (`spawn(process.execPath, [tsxCliScript, apiEntry], ...)`), never a
  shell string -- matching `freecad-runtime.ts`'s identical discipline.

## Running it

```bash
# Terminal 1: the web dev server (same as any browser-based session)
npm run dev --workspace=@naqsh/web

# Terminal 2: build once, then launch the desktop shell
npm run build --workspace=@naqsh/desktop
NAQSH_DESKTOP_DEV=true npx electron apps/desktop
```

The desktop app spawns its own `apps/api` child process on startup (using
`NAQSH_FREECAD_CMD`/`NAQSH_DATA_DIR`/etc. from its own environment,
unchanged) -- do not also run `apps/api`'s dev server separately, or both
will try to bind port 3001.

`NAQSH_WEB_URL` overrides the dev URL loaded (defaults to
`http://localhost:5173`). Without `NAQSH_DESKTOP_DEV=true`, the app loads
the built `apps/web/dist/index.html` instead (run `npm run build
--workspace=@naqsh/web` first).

## Packaging a standalone build

```bash
npm run build --workspace=@naqsh/web   # apps/web/dist
npm run package --workspace=@naqsh/desktop
```

Produces `apps/desktop/release/NAQSH <version>.exe` -- a portable Windows
executable via `electron-builder`. It is genuinely standalone: it does
**not** depend on this repo's `node_modules`/`tsx` being present on the
target machine.

`npm run package` runs three real steps:
1. `tsc` compiles `apps/desktop/src` (`main.ts`, `preload.cts`).
2. `scripts/build-resources.mjs` esbuild-bundles the entire `apps/api`
   server (all its real dependencies included, ~15MB) into a single
   `resources/api/dist/bundle.mjs`, copies
   `packages/adapters/freecad/runner.py` alongside it (so the FreeCAD
   adapter's `import.meta.url`-relative path resolution still finds it at
   the same relative location it uses from `packages/adapters/dist/`),
   and copies the built `apps/web/dist` into `resources/web/`.
3. `electron-builder` packages `dist/` + `resources/` into the portable
   exe, pinned to the exact installed Electron version (electron-builder
   requires a fixed version, not the `^43.0.0` range in `package.json`).

**Genuinely verified**, not just "it compiled": the packaged exe was
launched standalone (CDP-attached, no dev tooling involved), and its
spawned bundled API returned real `200`s from `/health` and
`/environments/discover` (including a real FreeCAD 1.1.3 detection), while
its loaded UI rendered real content (`document.body.innerText` populated
with the actual sidebar/nav, not blank) and exposed a working
`window.naqshDesktop` bridge.

Two real bugs surfaced (and were fixed) by that verification, not by
inspection:
- esbuild's ESM-output CJS-interop shim threw `Dynamic require of "path"
  is not supported` for a transitive dependency (`depd`, via
  `express`/`body-parser`) -- fixed with a `banner` injecting Node's real
  `createRequire(import.meta.url)` so the shim resolves through an actual
  `require` instead of a throwing stub.
- Vite's default absolute asset paths (`/assets/...`) resolve against the
  filesystem root, not the HTML file's own directory, when loaded via
  `file://` (exactly how this app opens the packaged UI) -- the page
  loaded with a blank body and `net::ERR_FILE_NOT_FOUND` for every asset.
  Fixed with `base: "./"` in `apps/web/vite.config.ts` (harmless for the
  normal browser/HTTP-served deployment).

**Not done**: no code signing (no certificate available -- the exe is
genuinely unsigned; Windows SmartScreen will warn on first run), no
installer (NSIS/MSI) beyond the portable exe target, no auto-update, no
macOS/Linux packaging (Windows-only `win: { target: "portable" }` so
far), no app icon (electron-builder's default Electron icon is used).
