import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * The generic /projects/:projectId/approvals routes (server.ts), added
 * alongside prepareExploration (engineeringWorkflow.ts) -- the
 * proposal-specific /proposals/:proposalId/approve|reject routes stay
 * unchanged, this is a second surface for Approvals that were never born
 * from one specific Proposal (e.g. the mutate-tool approvals a background
 * job's candidate builds need, see prepareExploration).
 *
 * Getting a REAL pending Approval into a running server instance requires
 * a real ModelProvider (prepareExploration/generateProjectProposal both
 * need one to generate the plan/candidates an Approval is requested for --
 * see engineeringWorkflow.test.ts's own "no GEMINI_API_KEY in this test
 * env" precedent), which isn't available here. This suite therefore covers
 * exactly what IS honestly testable at the HTTP layer without one: the
 * not-found and ownership-isolation paths -- the actual approve/reject
 * STATE TRANSITION is already covered by approval-store.test.ts (@naqsh/core)
 * and exercised indirectly by engineeringWorkflow.test.ts's prepareExploration
 * tests, which call runtime.approvals directly.
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-approvals-test-"));
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

async function json(path: string, init?: RequestInit, userId?: string): Promise<{ status: number; body: any }> {
  const headers = { ...(init?.headers ?? {}), ...(userId ? { "x-naqsh-user": userId } : {}) };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function postJson(path: string, body: unknown, userId?: string): Promise<{ status: number; body: any }> {
  return json(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, userId);
}

describe("GET /projects/:id/approvals", () => {
  it("a fresh project has zero approvals -- real, honest, never fabricated", async () => {
    const project = (await postJson("/projects", { name: "Approvals Project" })).body;
    const listed = await json(`/projects/${project.id}/approvals`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, []);
  });

  it("404s for a project owned by someone else", async () => {
    const project = (await postJson("/projects", { name: "Owned Approvals Project" }, "owner-approvals")).body;
    const intruder = await json(`/projects/${project.id}/approvals`, undefined, "intruder");
    assert.equal(intruder.status, 404);
  });
});

describe("POST /projects/:id/approvals/:approvalId/approve", () => {
  it("404s for an approval id that doesn't exist", async () => {
    const project = (await postJson("/projects", { name: "Approve Missing Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/approvals/approval_does_not_exist/approve`, {});
    assert.equal(status, 404);
    assert.ok(body.error);
  });

  it("404s for a project owned by someone else, even with a made-up approvalId (ownership is checked before the approval lookup)", async () => {
    const project = (await postJson("/projects", { name: "Approve Isolation Project" }, "owner-approvals-2")).body;
    const intruder = await postJson(`/projects/${project.id}/approvals/approval_does_not_exist/approve`, {}, "intruder");
    assert.equal(intruder.status, 404);
  });
});

describe("POST /projects/:id/approvals/:approvalId/reject", () => {
  it("404s for an approval id that doesn't exist", async () => {
    const project = (await postJson("/projects", { name: "Reject Missing Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/approvals/approval_does_not_exist/reject`, {});
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});
