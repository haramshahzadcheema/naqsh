import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * Phase B (real project/data architecture): the small "list everything
 * for this project" routes `HttpDataSource` (apps/web) composes a real
 * `ProjectSnapshot` from -- plans/checks/verification-results/environment
 * status previously had no route at all.
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-snapshot-test-"));
  delete process.env.GEMINI_API_KEY;
  const app = createServer({ dataDir });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("GET /projects/:id/plans, /checks, /verification-results, /environment", () => {
  it("a fresh project has empty plans/checks/verification-results, and a real (mock) environment status", async () => {
    const project = (await postJson("/projects", { name: "Snapshot Project" })).body;

    const plans = await json(`/projects/${project.id}/plans`);
    assert.equal(plans.status, 200);
    assert.deepEqual(plans.body, []);

    const checks = await json(`/projects/${project.id}/checks`);
    assert.equal(checks.status, 200);
    assert.deepEqual(checks.body, []);

    const results = await json(`/projects/${project.id}/verification-results`);
    assert.equal(results.status, 200);
    assert.deepEqual(results.body, []);

    const env = await json(`/projects/${project.id}/environment`);
    assert.equal(env.status, 200);
    assert.equal(env.body.kind, "mock_cad");
    assert.equal(env.body.status, "disconnected");
    assert.ok(Array.isArray(env.body.capabilities));
  });

  it("GET /projects now reports a real project.version, not just requirementCount", async () => {
    const created = await postJson("/projects", { name: "Versioned Project" });
    assert.equal(typeof created.body.version, "number");
    const listed = await json("/projects");
    const found = listed.body.find((p: { id: string }) => p.id === created.body.id);
    assert.ok(found);
    assert.equal(typeof found.version, "number");
  });

  it("these routes respect project ownership -- a different identity gets 404, never another project's real data", async () => {
    const created = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naqsh-user": "owner-a" },
      body: JSON.stringify({ name: "Owned Snapshot Project" })
    });
    const project = (await created.json()) as { id: string };
    const intruder = await fetch(`${baseUrl}/projects/${project.id}/plans`, { headers: { "x-naqsh-user": "intruder" } });
    assert.equal(intruder.status, 404);
  });
});
