import { app, BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildApiServerSpawnConfig,
  buildPackagedApiServerSpawnConfig,
  mapCaptureSources,
  resolveDisplayMediaRequest,
  resolvePackagedWebIndexPath,
  validateCaptureSourceSelection
} from "./bridgeLogic.js";

/**
 * NAQSH Desktop: the real native bridge (Part 22 of the environment-
 * platform brief) -- the ONE thing a browser tab structurally cannot do
 * for itself: enumerate and capture another application's window. This
 * process owns exactly two responsibilities and nothing more:
 *   1. Run the existing, unmodified `@naqsh/api` server as a local child
 *      process (the SAME server every browser-based dev/test session in
 *      this repo already talks to over HTTP -- this file adds NO new
 *      backend logic of its own, just launches the real one).
 *   2. Expose a narrow, explicit, permission-gated window-capture bridge
 *      to the renderer via a locked-down preload script -- never raw
 *      Node/Electron access, never an unrestricted localhost API, never
 *      an arbitrary-command channel (Part 23's explicit requirement).
 *
 * The renderer loads the SAME `apps/web` UI a browser tab would (dev:
 * `http://localhost:5173`; packaged: the built `apps/web/dist`) -- this
 * app does not fork the UI, it gives the existing one a real desktop
 * home plus the one extra capability a desktop process can offer.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const isDev = process.env.NAQSH_DESKTOP_DEV === "true";

let apiProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
/** Set by `desktop:select-capture-source` immediately before the renderer
 * calls `getDisplayMedia()`, consumed exactly once by
 * `setDisplayMediaRequestHandler` below -- there is no "ambient" capture
 * permission a page can silently use; a source must be explicitly chosen
 * through the real IPC round trip every single time. */
let pendingCaptureSourceId: string | null = null;

function startApiServer(): void {
  // Runs the REAL, existing apps/api entry point exactly as `npm run dev`
  // does -- no bespoke desktop-only backend. `NAQSH_FREECAD_CMD`/
  // `NAQSH_DATA_DIR`/etc. all pass through from this process's own
  // environment unchanged, so a user who already has FreeCAD configured
  // for the browser-based workflow gets identical behavior here.
  // Invoked as `node <tsx-cli.mjs> <entry>` (the CLI script's own real JS
  // entry point), never through the `.cmd`/`.ps1` shell shims npm
  // generates on Windows -- `spawn()` with an argv array can't invoke
  // those without `shell: true`, and this repository never spawns a
  // shell for anything (matches `freecad-runtime.ts`'s identical
  // "argv array, never a shell string" discipline). Config construction is
  // in `bridgeLogic.ts` so it's covered by a real, Electron-free test.
  // Packaged installs have no `tsx`/monorepo `node_modules` -- they run
  // the esbuild-bundled `apps/api` copy `build-resources.mjs` placed under
  // Electron's own `resourcesPath` instead.
  const spawnConfig = app.isPackaged
    ? buildPackagedApiServerSpawnConfig(process.resourcesPath, process.execPath, process.env)
    : buildApiServerSpawnConfig(repoRoot, process.execPath, process.env);
  apiProcess = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: spawnConfig.cwd,
    env: spawnConfig.env,
    stdio: "inherit",
    windowsHide: true
  });
  apiProcess.on("exit", (code) => {
    console.log(`[naqsh-desktop] api server exited with code ${code}`);
    apiProcess = null;
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "NAQSH",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.NAQSH_WEB_URL ?? "http://localhost:5173";
  if (isDev) {
    void mainWindow.loadURL(devUrl);
  } else if (app.isPackaged) {
    void mainWindow.loadFile(resolvePackagedWebIndexPath(process.resourcesPath));
  } else {
    const indexPath = join(repoRoot, "apps", "web", "dist", "index.html");
    void mainWindow.loadFile(indexPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** The real, bounded capture-source listing -- window titles/thumbnails
 * ONLY, never full-desktop enumeration unless the user's own OS window
 * happens to be a "screen" entry Electron itself reports. Thumbnails are
 * capped so this never becomes a bandwidth/memory concern. */
ipcMain.handle("desktop:list-capture-sources", async () => {
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 240, height: 160 }, fetchWindowIcons: false });
  return mapCaptureSources(sources);
});

/** The explicit, one-shot "arm" step -- see `pendingCaptureSourceId`'s own
 * doc comment. Rejects an unknown id outright rather than silently
 * falling through to some default source. */
ipcMain.handle("desktop:select-capture-source", async (_event, sourceId: unknown) => {
  const sources = await desktopCapturer.getSources({ types: ["window", "screen"] });
  const result = validateCaptureSourceSelection(sourceId, sources);
  if (!result.ok) {
    throw new Error(result.error);
  }
  pendingCaptureSourceId = result.sourceId;
  return { armed: true };
});

ipcMain.handle("desktop:cancel-capture-selection", () => {
  pendingCaptureSourceId = null;
  return { cancelled: true };
});

app.whenReady().then(() => {
  // The modern (Electron 30+) capture-permission API: the renderer's own
  // `navigator.mediaDevices.getDisplayMedia()` call resolves ONLY through
  // this handler, which this app controls entirely -- there is no path
  // for a loaded page to obtain a capture stream on its own, and no path
  // for it to capture anything OTHER than the one source the user just
  // explicitly picked via the IPC round trip above. A request arriving
  // with nothing armed is refused outright (Part 10 & 11's "explicit
  // user permission", never an ambient grant).
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const armedId = pendingCaptureSourceId;
    pendingCaptureSourceId = null;
    desktopCapturer.getSources({ types: ["window", "screen"] }).then((sources) => {
      const resolution = resolveDisplayMediaRequest(armedId, sources);
      if (!resolution.grant) {
        callback({});
        return;
      }
      const match = sources.find((s) => s.id === resolution.sourceId);
      callback({ video: match, audio: undefined });
    });
  });

  startApiServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (apiProcess && !apiProcess.killed) {
    apiProcess.kill();
  }
});
