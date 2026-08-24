import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * Part J/K: real HTTP coverage for research (P21) and memory (P24), now
 * that both are actually wired (see the Phase A audit that found neither
 * reachable from any route). No test here makes a real outbound network
 * call -- the fetch tests exercise the REAL SSRF-blocking logic (which
 * rejects before any network attempt) and input validation; the
 * source/evidence/memory tests exercise the REAL World Model write path,
 * which needs no network at all.
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-research-test-"));
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

describe("POST /projects/:id/research/fetch", () => {
  it("rejects a private/loopback locator as blocked_locator, before any real network attempt", async () => {
    const project = (await postJson("/projects", { name: "Research Fetch Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/research/fetch`, { locator: "http://127.0.0.1:9999/internal" });
    assert.equal(status, 422);
    // The research_fetch TOOL boundary (core, unmodified) deliberately
    // collapses every provider-level failure into ToolErrorKind
    // "execution_failure" -- the specific reason (blocked/private address)
    // lives in the message, exactly like every other tool in this codebase.
    assert.equal(body.error.kind, "execution_failure");
    assert.match(body.error.message, /private|reserved/i);
  });

  it("rejects a missing locator with 400, never attempting the tool call", async () => {
    const project = (await postJson("/projects", { name: "Research Fetch Missing Locator" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/research/fetch`, {});
    assert.equal(status, 400);
    assert.equal(body.error.kind, "invalid_input");
  });

  it("a different identity cannot fetch against another identity's project", async () => {
    const project = (await postJson("/projects", { name: "Isolated Research Project" }, "owner-1")).body;
    const { status } = await postJson(`/projects/${project.id}/research/fetch`, { locator: "http://127.0.0.1/" }, "someone-else");
    assert.equal(status, 404);
  });
});

describe("POST /projects/:id/research/sources and /evidence: real World Model writes", () => {
  it("records a real, audited Source, then real Evidence citing it -- both readable back via GET /research", async () => {
    const project = (await postJson("/projects", { name: "Citation Project" })).body;

    const sourceRes = await postJson(`/projects/${project.id}/research/sources`, {
      title: "6061-T6 Aluminum Datasheet",
      sourceType: "datasheet",
      locator: "https://example.com/6061-t6-datasheet",
      publisher: "MatWeb"
    });
    assert.equal(sourceRes.status, 201);
    assert.equal(sourceRes.body.title, "6061-T6 Aluminum Datasheet");
    assert.equal(sourceRes.body.status, "active");

    const evidenceRes = await postJson(`/projects/${project.id}/research/evidence`, {
      sourceId: sourceRes.body.id,
      claim: "6061-T6 has a yield strength of 276 MPa.",
      excerpt: "Yield strength: 276 MPa (40,000 psi)"
    });
    assert.equal(evidenceRes.status, 201);
    assert.equal(evidenceRes.body.sourceId, sourceRes.body.id);

    const listed = await json(`/projects/${project.id}/research`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sources.length, 1);
    assert.equal(listed.body.evidence.length, 1);
  });

  it("rejects evidence citing a source that doesn't exist -- never fabricates the reference", async () => {
    const project = (await postJson("/projects", { name: "Bad Evidence Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/research/evidence`, { sourceId: "src_does_not_exist", claim: "an unsupported claim" });
    assert.equal(status, 422);
    assert.match(body.error.message, /source/i);
  });

  it("rejects a source with a missing sourceType with 400", async () => {
    const project = (await postJson("/projects", { name: "Bad Source Project" })).body;
    const { status } = await postJson(`/projects/${project.id}/research/sources`, { title: "No type given" });
    assert.equal(status, 400);
  });
});

describe("POST /projects/:id/memory: real memory records, closing the 'permanently empty' gap", () => {
  it("records a real MemoryRecord, readable back via GET /memory", async () => {
    const project = (await postJson("/projects", { name: "Memory Project" })).body;

    const before = await json(`/projects/${project.id}/memory`);
    assert.equal(before.body.length, 0, "a fresh project has no memory yet");

    const created = await postJson(`/projects/${project.id}/memory`, {
      kind: "decision",
      title: "Chose aluminum over steel",
      content: "Aluminum was chosen for the bracket to meet the mass budget, at the cost of a lower safety margin."
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.kind, "decision");
    assert.equal(created.body.status, "active");

    const after = await json(`/projects/${project.id}/memory`);
    assert.equal(after.body.length, 1);
    assert.equal(after.body[0].title, "Chose aluminum over steel");
  });

  it("rejects an invalid memory kind with a real, structured tool error, never silently coercing it", async () => {
    const project = (await postJson("/projects", { name: "Bad Memory Kind Project" })).body;
    const { status, body } = await postJson(`/projects/${project.id}/memory`, { kind: "not_a_real_kind", title: "x", content: "y" });
    assert.equal(status, 422);
    assert.equal(body.error.kind, "invalid_input");
  });

  it("rejects a missing title/content with 400", async () => {
    const project = (await postJson("/projects", { name: "Missing Memory Fields Project" })).body;
    const { status } = await postJson(`/projects/${project.id}/memory`, { kind: "lesson" });
    assert.equal(status, 400);
  });

  it("a different identity cannot add memory to another identity's project", async () => {
    const project = (await postJson("/projects", { name: "Isolated Memory Project" }, "owner-2")).body;
    const { status } = await postJson(`/projects/${project.id}/memory`, { kind: "lesson", title: "x", content: "y" }, "intruder");
    assert.equal(status, 404);
  });
});
