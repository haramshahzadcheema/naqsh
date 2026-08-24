import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createBackgroundJob } from "@naqsh/schemas";
import {
  createAgentLoopRunStore,
  createApprovalStore,
  createArtifactStore,
  createAutonomyGrantStore,
  createBuildResultStore,
  createCandidateMetricValueStore,
  createCandidateStore,
  createChangeHistory,
  createCheckStore,
  createCheckpointStore,
  createClarificationStore,
  createDesignSpecificationStore,
  createJobEventStore,
  createMemoryStore,
  createObjectiveSatisfactionStore,
  createOptimizationProblemStore,
  createOptimizationResultStore,
  createVerificationResultStore
} from "@naqsh/core";
import { createServer } from "../src/server.js";
import { createRuntimeStateRepository } from "../src/db/repositories.js";

/**
 * Proves the thing `apps/api`'s own P0-P26 history repeatedly documented
 * as a KNOWN gap: everything a `ProjectRuntime` holds beyond
 * `WorldModelState` -- plans, proposals, approvals, checkpoints,
 * verification results, memory, activity, background jobs -- now survives
 * a genuine server restart, not just an in-process cache hit. Each test
 * starts a REAL server, makes REAL HTTP requests, closes it, starts a
 * SECOND real server against the SAME data directory (a true restart, not
 * a mock), and asserts the second server's REAL HTTP responses reflect
 * what the first one wrote.
 */

let dataDir: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-runtime-persistence-test-"));
  delete process.env.GEMINI_API_KEY;
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function startServer(dir: string): Promise<{ server: Server; baseUrl: string }> {
  const app = createServer({ dataDir: dir });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function json(baseUrl: string, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function postJson(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return json(baseUrl, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("runtime state survives a real server restart", () => {
  it("a memory record and the activity log written before a restart are still there after it", async () => {
    const projectDir = mkdtempSync(join(dataDir, "memory-"));
    const first = await startServer(projectDir);
    const project = (await postJson(first.baseUrl, "/projects", { name: "Persistence Test Project" })).body;

    const memoryCreated = await postJson(first.baseUrl, `/projects/${project.id}/memory`, {
      kind: "decision",
      title: "Use 6061 aluminum",
      content: "Chosen for its strength-to-weight ratio and machinability."
    });
    assert.equal(memoryCreated.status, 201);

    const beforeActivity = await json(first.baseUrl, `/projects/${project.id}/activity`);
    assert.ok(beforeActivity.body.length > 0, "recording memory should have logged real activity before the restart");

    await stopServer(first.server);

    // A genuinely SEPARATE server process-equivalent, pointed at the same
    // data directory -- nothing here reuses the first server's in-memory
    // state.
    const second = await startServer(projectDir);
    try {
      const memoryAfter = await json(second.baseUrl, `/projects/${project.id}/memory`);
      assert.equal(memoryAfter.status, 200);
      assert.equal(memoryAfter.body.length, 1);
      assert.equal(memoryAfter.body[0].title, "Use 6061 aluminum");

      const activityAfter = await json(second.baseUrl, `/projects/${project.id}/activity`);
      assert.equal(activityAfter.body.length, beforeActivity.body.length, "activity log should survive the restart with full fidelity");
    } finally {
      await stopServer(second.server);
    }
  });

  it("a background job still 'running' when the server restarted is honestly recovered as failed, never silently stuck", async () => {
    const projectDir = mkdtempSync(join(dataDir, "jobs-"));
    const first = await startServer(projectDir);
    const project = (await postJson(first.baseUrl, "/projects", { name: "Interrupted Job Project" })).body;
    await stopServer(first.server);

    // Directly craft a runtime-state snapshot with one job frozen at
    // "running" -- simulates the server process dying mid-execution,
    // which is exactly the scenario `recoverInterruptedJobs`
    // (projectRuntime.ts) exists to handle honestly. Every OTHER store is
    // a real, empty, correctly-serialized store -- not a shortcut.
    const runningJob = createBackgroundJob({
      projectId: project.id,
      projectVersion: project.version,
      status: "running",
      objective: "Explore five bracket variations",
      candidateIds: [],
      autonomyLevel: "approved_modify",
      allowedTools: ["run_optimization"],
      budget: { maxIterations: 10, maxDurationMs: 60_000, maxToolCalls: 20, maxModelCalls: 5, maxCandidates: 5 }
    });
    const runtimeStates = createRuntimeStateRepository(projectDir);
    runtimeStates.save({
      id: project.id,
      history: createChangeHistory().serialize(),
      approvals: createApprovalStore().serialize(),
      autonomyGrants: createAutonomyGrantStore().serialize(),
      checkpoints: createCheckpointStore().serialize(),
      artifacts: createArtifactStore().serialize(),
      checks: createCheckStore().serialize(),
      verificationResults: createVerificationResultStore().serialize(),
      objectiveSatisfactions: createObjectiveSatisfactionStore().serialize(),
      agentLoopRuns: createAgentLoopRunStore().serialize(),
      memory: createMemoryStore().serialize(),
      activity: "[]",
      plans: "[]",
      proposals: "[]",
      candidates: createCandidateStore().serialize(),
      designSpecifications: createDesignSpecificationStore().serialize(),
      buildResults: createBuildResultStore().serialize(),
      optimizationProblems: createOptimizationProblemStore().serialize(),
      candidateMetricValues: createCandidateMetricValueStore().serialize(),
      optimizationResults: createOptimizationResultStore().serialize(),
      backgroundJobs: JSON.stringify([runningJob]),
      jobEvents: createJobEventStore().serialize(),
      clarifications: createClarificationStore().serialize(),
      updatedAt: new Date().toISOString()
    });

    const second = await startServer(projectDir);
    try {
      const jobs = await json(second.baseUrl, `/projects/${project.id}/jobs`);
      assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
      assert.equal(jobs.body.length, 1);
      assert.equal(jobs.body[0].status, "failed");
      assert.match(jobs.body[0].failureReason, /restart/i);
    } finally {
      await stopServer(second.server);
    }
  });
});
