import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * Part L: real HTTP coverage for background jobs (P25), now that a real
 * async execution kickoff exists (the audit found `runBackgroundJob` had
 * zero callers anywhere in apps/api). These tests submit zero-candidate
 * jobs ("a legitimate 'build-only'/no-op job", per submit-background-job-
 * tool.ts's own input schema doc) -- this proves the ENTIRE real chain
 * (submit -> the real async runner -> a genuine terminal state transition
 * -> readable back via GET) without depending on a design-specification-
 * generation pipeline this phase doesn't add (see the final report).
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-jobs-test-"));
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

const NOOP_JOB_BODY = {
  objective: "A no-op smoke-test job with no candidates.",
  candidateIds: [],
  autonomyLevel: "approved_modify",
  allowedTools: ["create_checkpoint"],
  budget: { maxIterations: 5, maxDurationMs: 30_000, maxToolCalls: 20, maxModelCalls: 1, maxCandidates: 5 }
};

async function waitForTerminal(projectId: string, jobId: string, maxAttempts = 20): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { body } = await json(`/projects/${projectId}/jobs/${jobId}`);
    if (body.job.status === "completed" || body.job.status === "failed" || body.job.status === "cancelled") return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job "${jobId}" did not reach a terminal state within ${maxAttempts} polls`);
}

describe("POST /projects/:id/jobs: real submission through submit_background_job", () => {
  it("submits a real, queued job -- 202, and it's independently GET-able", async () => {
    const project = (await postJson("/projects", { name: "Jobs Project" })).body;
    const submitted = await postJson(`/projects/${project.id}/jobs`, NOOP_JOB_BODY);
    assert.equal(submitted.status, 202);
    assert.equal(submitted.body.status, "queued");
    assert.equal(submitted.body.candidateIds.length, 0);

    const fetched = await json(`/projects/${project.id}/jobs/${submitted.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.job.id, submitted.body.id);
  });

  it("rejects an autonomyLevel above this app's own ceiling ('autonomous') -- a job can never carry more authority than its creator", async () => {
    const project = (await postJson("/projects", { name: "Overreaching Job Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/jobs`, { ...NOOP_JOB_BODY, autonomyLevel: "autonomous" });
    assert.equal(status, 422);
    assert.match(body.error.message, /autonomy_ceiling_exceeded/);
  });

  it("rejects a missing/empty allowedTools with 400", async () => {
    const project = (await postJson("/projects", { name: "No Allowed Tools Project" })).body;
    const { status } = await postJson(`/projects/${project.id}/jobs`, { ...NOOP_JOB_BODY, allowedTools: [] });
    assert.equal(status, 400);
  });

  it("the REAL async runner picks up a submitted job and drives it to a genuine terminal state -- not a fabricated 'running' flag with nothing behind it", async () => {
    const project = (await postJson("/projects", { name: "Real Runner Project" })).body;
    const submitted = await postJson(`/projects/${project.id}/jobs`, NOOP_JOB_BODY);
    assert.equal(submitted.status, 202);

    const finalState = await waitForTerminal(project.id, submitted.body.id);
    assert.equal(finalState.job.status, "completed");
    assert.ok(finalState.job.result, "a terminal job must carry a real JobResult");
    assert.equal(finalState.job.result.candidateResults.length, 0);
    assert.ok(Array.isArray(finalState.events));
    assert.ok(finalState.events.length > 0, "the real runner must have recorded real JobEvents along the way");
  });
});

describe("GET /projects/:id/jobs", () => {
  it("lists every job submitted for the project", async () => {
    const project = (await postJson("/projects", { name: "List Jobs Project" })).body;
    await postJson(`/projects/${project.id}/jobs`, NOOP_JOB_BODY);
    await postJson(`/projects/${project.id}/jobs`, { ...NOOP_JOB_BODY, objective: "A second job." });
    const listed = await json(`/projects/${project.id}/jobs`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);
  });

  it("a fresh project has zero jobs", async () => {
    const project = (await postJson("/projects", { name: "Empty Jobs Project" })).body;
    const listed = await json(`/projects/${project.id}/jobs`);
    assert.equal(listed.body.length, 0);
  });
});

describe("POST /projects/:id/jobs/:jobId/cancel", () => {
  it("cancelling either succeeds (job still queued) or is correctly rejected once the job has already finished -- a genuine race for a zero-candidate job that completes almost instantly, never silently ignored either way", async () => {
    const project = (await postJson("/projects", { name: "Cancel Job Project" })).body;
    const submitted = await postJson(`/projects/${project.id}/jobs`, NOOP_JOB_BODY);
    const cancelled = await postJson(`/projects/${project.id}/jobs/${submitted.body.id}/cancel`, { reason: "test cancellation" });
    if (cancelled.status === 200) {
      assert.equal(cancelled.body.status, "cancelled");
    } else {
      assert.equal(cancelled.status, 422);
      const current = await json(`/projects/${project.id}/jobs/${submitted.body.id}`);
      assert.ok(["completed", "failed", "cancelled"].includes(current.body.job.status), "cancel must only ever fail because the job already reached a real terminal state");
    }
  });

  it("rejects cancelling a job that doesn't exist", async () => {
    const project = (await postJson("/projects", { name: "Cancel Missing Job Project" })).body;
    const { status } = await postJson(`/projects/${project.id}/jobs/job_does_not_exist/cancel`, {});
    assert.equal(status, 422);
  });
});

describe("project isolation for jobs", () => {
  it("a job submitted under one identity is unreachable by another", async () => {
    const project = (await postJson("/projects", { name: "Isolated Jobs Project" }, "owner-3")).body;
    const submitted = await postJson(`/projects/${project.id}/jobs`, NOOP_JOB_BODY, "owner-3");
    assert.equal(submitted.status, 202);

    const intruderList = await json(`/projects/${project.id}/jobs`, undefined, "intruder");
    assert.equal(intruderList.status, 404);

    const intruderGet = await json(`/projects/${project.id}/jobs/${submitted.body.id}`, undefined, "intruder");
    assert.equal(intruderGet.status, 404);
  });
});
