import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildApiServerSpawnConfig,
  buildPackagedApiServerSpawnConfig,
  mapCaptureSources,
  resolveDisplayMediaRequest,
  resolvePackagedWebIndexPath,
  validateCaptureSourceSelection
} from "../src/bridgeLogic.ts";

test("mapCaptureSources: strips an empty thumbnail down to null", () => {
  const mapped = mapCaptureSources([
    { id: "window:1", name: "FreeCAD 1.1.3", thumbnail: { isEmpty: () => false, toDataURL: () => "data:image/png;base64,AAA" } },
    { id: "screen:0", name: "Entire screen", thumbnail: { isEmpty: () => true, toDataURL: () => "" } }
  ]);
  assert.deepEqual(mapped, [
    { id: "window:1", name: "FreeCAD 1.1.3", thumbnailDataUrl: "data:image/png;base64,AAA" },
    { id: "screen:0", name: "Entire screen", thumbnailDataUrl: null }
  ]);
});

test("mapCaptureSources: empty source list maps to an empty list", () => {
  assert.deepEqual(mapCaptureSources([]), []);
});

test("validateCaptureSourceSelection: accepts an id present in the available sources", () => {
  const result = validateCaptureSourceSelection("window:1", [{ id: "window:1" }, { id: "screen:0" }]);
  assert.deepEqual(result, { ok: true, sourceId: "window:1" });
});

test("validateCaptureSourceSelection: rejects a non-string id", () => {
  const result = validateCaptureSourceSelection(42, [{ id: "window:1" }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /non-empty string/);
});

test("validateCaptureSourceSelection: rejects an empty string id", () => {
  const result = validateCaptureSourceSelection("", [{ id: "window:1" }]);
  assert.equal(result.ok, false);
});

test("validateCaptureSourceSelection: rejects null/undefined", () => {
  assert.equal(validateCaptureSourceSelection(null, [{ id: "window:1" }]).ok, false);
  assert.equal(validateCaptureSourceSelection(undefined, [{ id: "window:1" }]).ok, false);
});

test("validateCaptureSourceSelection: rejects an id that closed / is no longer available", () => {
  const result = validateCaptureSourceSelection("window:999", [{ id: "window:1" }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /window:999/);
});

test("resolveDisplayMediaRequest: refuses when nothing was armed", () => {
  const resolution = resolveDisplayMediaRequest(null, [{ id: "window:1" }]);
  assert.deepEqual(resolution, { grant: false });
});

test("resolveDisplayMediaRequest: grants exactly the armed source when it still exists", () => {
  const resolution = resolveDisplayMediaRequest("window:1", [{ id: "window:1" }, { id: "screen:0" }]);
  assert.deepEqual(resolution, { grant: true, sourceId: "window:1" });
});

test("resolveDisplayMediaRequest: refuses (never falls back) when the armed source vanished", () => {
  const resolution = resolveDisplayMediaRequest("window:1", [{ id: "screen:0" }]);
  assert.deepEqual(resolution, { grant: false });
});

test("buildApiServerSpawnConfig: targets the real, unmodified apps/api entry via tsx's CLI script", () => {
  const repoRoot = join("C:", "fake-repo");
  const config = buildApiServerSpawnConfig(repoRoot, "C:\\fake\\electron.exe", {});
  assert.equal(config.command, "C:\\fake\\electron.exe");
  assert.equal(config.args[0], join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"));
  assert.equal(config.args[1], join(repoRoot, "apps", "api", "src", "start.ts"));
  assert.equal(config.cwd, join(repoRoot, "apps", "api"));
});

test("buildApiServerSpawnConfig: sets ELECTRON_RUN_AS_NODE so the Electron binary behaves as plain Node", () => {
  const config = buildApiServerSpawnConfig("C:\\fake-repo", "C:\\fake\\electron.exe", {});
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
});

test("buildApiServerSpawnConfig: defaults PORT to 3001 but preserves an explicit override", () => {
  const defaulted = buildApiServerSpawnConfig("C:\\fake-repo", "C:\\fake\\electron.exe", {});
  assert.equal(defaulted.env.PORT, "3001");

  const overridden = buildApiServerSpawnConfig("C:\\fake-repo", "C:\\fake\\electron.exe", { PORT: "4000" });
  assert.equal(overridden.env.PORT, "4000");
});

test("buildApiServerSpawnConfig: passes through the rest of the base environment unchanged", () => {
  const config = buildApiServerSpawnConfig("C:\\fake-repo", "C:\\fake\\electron.exe", { NAQSH_FREECAD_CMD: "C:\\freecad\\freecadcmd.exe" });
  assert.equal(config.env.NAQSH_FREECAD_CMD, "C:\\freecad\\freecadcmd.exe");
});

test("buildPackagedApiServerSpawnConfig: targets the esbuild-bundled apps/api copy under resourcesPath, not tsx", () => {
  const resourcesPath = join("C:", "fake-install", "resources");
  const config = buildPackagedApiServerSpawnConfig(resourcesPath, "C:\\fake\\electron.exe", {});
  assert.equal(config.command, "C:\\fake\\electron.exe");
  assert.deepEqual(config.args, [join(resourcesPath, "api", "dist", "bundle.mjs")]);
  assert.equal(config.cwd, join(resourcesPath, "api"));
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(config.env.PORT, "3001");
});

test("buildPackagedApiServerSpawnConfig: preserves an explicit PORT override", () => {
  const config = buildPackagedApiServerSpawnConfig("C:\\fake-install\\resources", "C:\\fake\\electron.exe", { PORT: "5050" });
  assert.equal(config.env.PORT, "5050");
});

test("resolvePackagedWebIndexPath: points at the copied apps/web/dist under resourcesPath", () => {
  const resourcesPath = join("C:", "fake-install", "resources");
  assert.equal(resolvePackagedWebIndexPath(resourcesPath), join(resourcesPath, "web", "index.html"));
});
