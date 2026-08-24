import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * LEVEL 2 real integration test for the environment-platform's actual HTTP
 * surface (discovery, FreeCAD-backed project creation, real connect) --
 * mirrors `packages/adapters/test/freecad-adapter.integration.test.ts`'s
 * own "skip, never fake-pass, when FreeCAD genuinely isn't available"
 * discipline exactly. This is the ONE place that proves the whole chain
 * (`environmentDiscovery.ts` -> `POST /projects` -> `POST .../connect`)
 * actually works end to end through real HTTP requests, not just that the
 * underlying adapter does (already covered by the adapters package's own
 * suite).
 */

const here = new URL(".", import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1");
const adaptersRoot = join(here, "..", "..", "..", "packages", "adapters");
const fixtureBuilderPath = join(adaptersRoot, "freecad", "fixtures", "build_fixture.py");
const runnerScriptPath = join(adaptersRoot, "freecad", "runner.py");

function resolveFreecadCmdPath(): string {
  return process.env.NAQSH_FREECAD_CMD ?? "freecadcmd";
}

/** Same sanctioned boundary every real FreeCAD call in this repository
 * goes through -- the fixed runner script, a fixed "health" operation --
 * used here only to decide whether this suite's tests should run at all,
 * never to execute anything freeform. */
function probeFreecadAvailable(freecadCmdPath: string): boolean {
  try {
    execFileSync(freecadCmdPath, [runnerScriptPath, Buffer.from(JSON.stringify({ operation: "health", params: {} })).toString("base64")], { timeout: 15_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const freecadCmdPath = resolveFreecadCmdPath();
const available = probeFreecadAvailable(freecadCmdPath);
const skip = available ? false : "FreeCAD is not available in this environment (freecadcmd could not be invoked)";

if (!available) {
  console.log(`[freecadEnvironment.integration.test.ts] SKIPPED: ${skip}`);
}

describe("environment platform: real FreeCAD discovery + connection, over real HTTP", { skip }, () => {
  let baseUrl: string;
  let server: Server;
  let dataDir: string;
  let fixtureDir: string;
  let fixturePath: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-freecad-http-test-"));
    delete process.env.GEMINI_API_KEY;
    process.env.NAQSH_FREECAD_CMD = freecadCmdPath;
    const app = createServer({ dataDir });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    fixtureDir = mkdtempSync(join(tmpdir(), "naqsh-freecad-http-fixture-"));
    fixturePath = join(fixtureDir, "fixture.FCStd");
    execFileSync(freecadCmdPath, [fixtureBuilderPath, fixturePath], { timeout: 30_000, windowsHide: true });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  it("GET /environments/discover reports FreeCAD as genuinely connectable, backed by a real health check", async () => {
    const { status, body } = await json("/environments/discover?refresh=true");
    assert.equal(status, 200);
    const freecad = body.environments.find((e: { kind: string }) => e.kind === "freecad");
    assert.ok(freecad, "expected a freecad entry in the discovery response");
    assert.equal(freecad.status, "connectable");
    assert.ok(freecad.resolvedCommandPath, "expected a real resolved command path");
    assert.ok(freecad.version, "expected a real FreeCAD version string");
  });

  it("POST /projects rejects a freecad project with no documentPath, and with a documentPath that doesn't exist", async () => {
    const noPath = await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No Path", environmentKind: "freecad" }) });
    assert.equal(noPath.status, 400);

    const badPath = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad Path", environmentKind: "freecad", documentPath: "C:\\definitely\\does\\not\\exist.FCStd" })
    });
    assert.equal(badPath.status, 400);
  });

  it("the full real chain: create a freecad project against a real fixture, connect, and observe the real object it actually contains", async () => {
    const created = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Real FreeCAD Project", environmentKind: "freecad", documentPath: fixturePath })
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.id;

    const connected = await json(`/projects/${projectId}/environment/connect`, { method: "POST" });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.status, "connected");
    assert.ok(connected.body.session.id);

    const status = await json(`/projects/${projectId}/environment`);
    assert.equal(status.status, 200);
    assert.equal(status.body.kind, "freecad");
    assert.equal(status.body.status, "connected");
    assert.deepEqual(status.body.capabilities.sort(), ["checkpoint", "modify", "save"]);
    // Real data from the actual connected FreeCAD document -- previously
    // computed server-side and then left out of this response entirely.
    assert.equal(status.body.documentName, connected.body.session.documentName);
    assert.ok(status.body.documentName, "expected a real document name from the connected FreeCAD session");

    // A second connect on the same project reuses the existing session,
    // never opening a duplicate one.
    const reconnected = await json(`/projects/${projectId}/environment/connect`, { method: "POST" });
    assert.equal(reconnected.status, 200);
    assert.equal(reconnected.body.session.id, connected.body.session.id);
  });
});
