import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundJob } from "@naqsh/schemas";
import { initializeWorldModel } from "@naqsh/core";
import { createProjectRepository, createRuntimeStateRepository, type ProjectRecord, type ProjectRepository, type RuntimeStateRepository } from "../src/db/repositories.js";
import { discardProjectRuntime, getOrCreateProjectRuntime, isProjectRuntimeCached, setMaxCachedRuntimes } from "../src/projectRuntime.js";

/**
 * Proves the LRU eviction `projectRuntime.ts` uses to bound its in-memory
 * runtime cache -- without it, a long-running server holds a full
 * `ProjectRuntime` (tool registry, every `@naqsh/core` store) for EVERY
 * project it has ever been asked about, forever, an unbounded-memory-
 * growth bug for a server meant to serve many real projects over its
 * lifetime. `isProjectRuntimeCached` is a test-only introspection export;
 * everything else here is the exact real path `server.ts` uses.
 */

function createProject(projects: ProjectRepository, name: string): ProjectRecord {
  const worldModelState = initializeWorldModel({ name, description: "", objective: { summary: `Design a ${name}.` } });
  const now = new Date().toISOString();
  const record: ProjectRecord = { id: worldModelState.project.id, name, createdAt: now, updatedAt: now, worldModelState };
  projects.save(record);
  return record;
}

describe("projectRuntime.ts: bounded LRU runtime cache", () => {
  let dataDir: string;
  let projects: ProjectRepository;
  let runtimeStates: RuntimeStateRepository;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "naqsh-runtime-cache-test-"));
    projects = createProjectRepository(dataDir);
    runtimeStates = createRuntimeStateRepository(dataDir);
  });

  after(() => {
    setMaxCachedRuntimes(500); // restore the real default for any test file that runs after this one in the same process
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    setMaxCachedRuntimes(500);
  });

  it("evicts the least-recently-used runtime once the cap is reached, and a later request for it transparently rehydrates", () => {
    setMaxCachedRuntimes(2);
    const a = createProject(projects, "Bracket A");
    const b = createProject(projects, "Bracket B");
    const c = createProject(projects, "Bracket C");
    discardProjectRuntime(a.id);
    discardProjectRuntime(b.id);
    discardProjectRuntime(c.id);

    getOrCreateProjectRuntime(a.id, projects, "mock_cad", runtimeStates);
    getOrCreateProjectRuntime(b.id, projects, "mock_cad", runtimeStates);
    assert.equal(isProjectRuntimeCached(a.id), true);
    assert.equal(isProjectRuntimeCached(b.id), true);

    // A third distinct project, past the cap of 2 -- A is the
    // least-recently-used (touched first, never touched again), so it
    // must be the one evicted, never B (the more recently used of the two).
    getOrCreateProjectRuntime(c.id, projects, "mock_cad", runtimeStates);
    assert.equal(isProjectRuntimeCached(a.id), false, "the least-recently-used runtime must have been evicted");
    assert.equal(isProjectRuntimeCached(b.id), true);
    assert.equal(isProjectRuntimeCached(c.id), true);

    // Evicted, not lost: a later request for A rehydrates a genuinely
    // working runtime from persisted state, the same "cold cache miss"
    // path a real server restart already exercises.
    const rehydrated = getOrCreateProjectRuntime(a.id, projects, "mock_cad", runtimeStates);
    assert.equal(rehydrated.projectId, a.id);
    assert.equal(isProjectRuntimeCached(a.id), true);
  });

  it("touching a cached runtime again moves it to the most-recently-used end, protecting it from the next eviction", () => {
    setMaxCachedRuntimes(2);
    const a = createProject(projects, "Bracket D");
    const b = createProject(projects, "Bracket E");
    const c = createProject(projects, "Bracket F");
    discardProjectRuntime(a.id);
    discardProjectRuntime(b.id);
    discardProjectRuntime(c.id);

    getOrCreateProjectRuntime(a.id, projects, "mock_cad", runtimeStates);
    getOrCreateProjectRuntime(b.id, projects, "mock_cad", runtimeStates);
    // Re-touch A -- it is now the MOST recently used, so B becomes the
    // least-recently-used one instead.
    getOrCreateProjectRuntime(a.id, projects, "mock_cad", runtimeStates);
    getOrCreateProjectRuntime(c.id, projects, "mock_cad", runtimeStates);

    assert.equal(isProjectRuntimeCached(a.id), true, "A was re-touched after B, so B (not A) must be the one evicted");
    assert.equal(isProjectRuntimeCached(b.id), false);
    assert.equal(isProjectRuntimeCached(c.id), true);
  });

  it("never evicts a runtime with a background job genuinely running in this process, even when it is the least-recently-used", () => {
    setMaxCachedRuntimes(2);
    const busy = createProject(projects, "Bracket G");
    const idle = createProject(projects, "Bracket H");
    const fresh = createProject(projects, "Bracket I");
    discardProjectRuntime(busy.id);
    discardProjectRuntime(idle.id);
    discardProjectRuntime(fresh.id);

    const busyRuntime = getOrCreateProjectRuntime(busy.id, projects, "mock_cad", runtimeStates);
    const job = createBackgroundJob({
      projectId: busy.id,
      projectVersion: 1,
      status: "queued",
      objective: "Sweep candidates",
      candidateIds: [],
      autonomyLevel: "approved_modify",
      allowedTools: ["run_optimization"],
      budget: { maxIterations: 10, maxDurationMs: 60_000, maxToolCalls: 20, maxModelCalls: 5, maxCandidates: 5 }
    });
    busyRuntime.backgroundJobStore.save(job);
    busyRuntime.backgroundJobStore.transition(job.id, "running");

    // busy is touched FIRST (so it would normally be the LRU victim), then
    // idle -- past the cap of 2, eviction must skip busy (a real async
    // job is "running" against it) and take idle instead.
    getOrCreateProjectRuntime(idle.id, projects, "mock_cad", runtimeStates);
    getOrCreateProjectRuntime(fresh.id, projects, "mock_cad", runtimeStates);

    assert.equal(isProjectRuntimeCached(busy.id), true, "a runtime with a running background job must never be evicted");
    assert.equal(isProjectRuntimeCached(idle.id), false);
    assert.equal(isProjectRuntimeCached(fresh.id), true);
  });
});
