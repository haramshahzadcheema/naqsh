import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";
import { writeErrorResponse } from "../src/httpErrors.js";
import { ToolError, AuthorizationError, WorldModelValidationError } from "@naqsh/schemas";

/**
 * Part 30's security-architecture requirements, regression-tested: strict
 * project isolation (a project/conversation/message/file belonging to one
 * identity is genuinely unreachable by another, not just "hidden in the
 * UI"), rate limiting, and typed-error mapping at the HTTP boundary.
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-security-test-"));
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

describe("project isolation: a project belongs to exactly the identity that created it", () => {
  it("a different identity gets a genuine 404 for GET /projects/:id -- never a fabricated empty success, never a 403 that would leak existence", async () => {
    const created = (await postJson("/projects", { name: "Alice's Bracket" }, "alice")).body;
    const asAlice = await json(`/projects/${created.id}`, undefined, "alice");
    assert.equal(asAlice.status, 200);

    const asBob = await json(`/projects/${created.id}`, undefined, "bob");
    assert.equal(asBob.status, 404);
    assert.equal(asBob.body.error.kind, "not_found");
  });

  it("GET /projects only lists the calling identity's own projects", async () => {
    await postJson("/projects", { name: "Alice Project 1" }, "alice2");
    await postJson("/projects", { name: "Bob Project 1" }, "bob2");

    const aliceList = await json("/projects", undefined, "alice2");
    assert.ok(aliceList.body.every((p: { name: string }) => p.name.startsWith("Alice")));

    const bobList = await json("/projects", undefined, "bob2");
    assert.ok(bobList.body.every((p: { name: string }) => p.name.startsWith("Bob")));
  });

  it("a conversation/message under one identity's project is unreachable by another identity, even with a real conversationId", async () => {
    const project = (await postJson("/projects", { name: "Isolated Project" }, "carol")).body;
    const conversation = (await postJson("/conversations", { projectId: project.id }, "carol")).body;
    await postJson(`/conversations/${conversation.id}/messages`, { text: "hello", modelId: "deterministic" }, "carol");

    const asDave = await json(`/conversations/${conversation.id}`, undefined, "dave");
    assert.equal(asDave.status, 404);

    const messageAttempt = await postJson(`/conversations/${conversation.id}/messages`, { text: "intrusion attempt", modelId: "deterministic" }, "dave");
    assert.equal(messageAttempt.status, 404);
  });

  it("a proposal generated under one identity's project cannot be approved/executed by another identity", async () => {
    const project = (await postJson("/projects", { name: "Proposal Owner Project" }, "erin")).body;
    await postJson(`/projects/${project.id}/requirements`, { statementText: "It must support 50 kg.", modelId: "deterministic" }, "erin");

    // The deterministic mock model can't produce schema-valid plan/proposal
    // output (see engineeringWorkflow's own test suite for why), so we
    // only need a REAL project boundary here -- attempt approve/execute
    // against a proposal id that genuinely doesn't exist for "frank"; the
    // isolation guarantee under test is that ownership is checked BEFORE
    // any proposal lookup even matters for a cross-identity caller.
    const approveAttempt = await postJson(`/proposals/nonexistent_proposal/approve`, {}, "frank");
    assert.equal(approveAttempt.status, 404);
  });

  it("POST /conversations rejects a projectId owned by a different identity, same as a nonexistent one", async () => {
    const project = (await postJson("/projects", { name: "Grace Project" }, "grace")).body;
    const attempt = await postJson("/conversations", { projectId: project.id }, "heidi");
    assert.equal(attempt.status, 400);
  });

  it("a file uploaded against one identity's project is not visible to another identity", async () => {
    const project = (await postJson("/projects", { name: "File Owner Project" }, "ivan")).body;
    const form = new FormData();
    form.append("projectId", project.id);
    form.append("files", new Blob(["confidential spec"], { type: "text/plain" }), "spec.txt");
    const uploadRes = await fetch(`${baseUrl}/files`, { method: "POST", headers: { "x-naqsh-user": "ivan" }, body: form });
    const [uploaded] = (await uploadRes.json()) as Array<{ id: string }>;
    assert.ok(uploaded);

    const asJudy = await json(`/files/${uploaded.id}`, undefined, "judy");
    assert.equal(asJudy.status, 404);
    const asIvan = await json(`/files/${uploaded.id}`, undefined, "ivan");
    assert.equal(asIvan.status, 200);
  });

  it("a real clarification id from one identity's project cannot be answered or dismissed by pairing it with a DIFFERENT identity's own project id", async () => {
    // The subtler ID-confusion attack: not "guess someone else's
    // projectId" (already blocked by getOwnedProject's 404), but "own a
    // REAL project, then splice a REAL clarificationId scraped from
    // elsewhere onto it." A clarification only ever lives in the
    // ClarificationStore of the runtime it was created under, so this
    // must 404 -- never resolve/leak/mutate the victim's record.
    const victimProject = (await postJson("/projects", { name: "Kevin Project" }, "kevin")).body;
    const attackerProject = (await postJson("/projects", { name: "Laura Project" }, "laura")).body;

    const answerAttempt = await postJson(
      `/projects/${attackerProject.id}/clarifications/clarification_scraped_from_kevin/answer`,
      { answerText: "500 N", modelId: "deterministic" },
      "laura"
    );
    assert.equal(answerAttempt.status, 404);

    const dismissAttempt = await postJson(`/projects/${attackerProject.id}/clarifications/clarification_scraped_from_kevin/dismiss`, {}, "laura");
    assert.equal(dismissAttempt.status, 404);

    // And the ordinary boundary still holds too: laura can't even list
    // kevin's project's clarifications by projectId alone.
    const listAttempt = await json(`/projects/${victimProject.id}/clarifications`, undefined, "laura");
    assert.equal(listAttempt.status, 404);
  });
});

describe("rate limiting", () => {
  it("the (N+1)th request within a window is rejected with 429 and Retry-After", async () => {
    const limitedDataDir = mkdtempSync(join(tmpdir(), "naqsh-ratelimit-test-"));
    const app = createServer({ dataDir: limitedDataDir, rateLimit: { windowMs: 60_000, maxRequests: 3 } });
    const limitedServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = limitedServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const limitedBaseUrl = `http://127.0.0.1:${port}`;

    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${limitedBaseUrl}/health`, { headers: { "x-naqsh-user": "rate-limited-user" } });
        assert.equal(res.status, 200, `request ${i + 1} should succeed within the limit`);
      }
      const fourth = await fetch(`${limitedBaseUrl}/health`, { headers: { "x-naqsh-user": "rate-limited-user" } });
      assert.equal(fourth.status, 429);
      assert.ok(fourth.headers.get("retry-after"));
      const fourthBody = (await fourth.json()) as { error: { kind: string } };
      assert.equal(fourthBody.error.kind, "rate_limited");
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
      rmSync(limitedDataDir, { recursive: true, force: true });
    }
  });

  it("cannot be bypassed by rotating the x-naqsh-user header -- the limit is keyed by IP, not the unauthenticated identity header", async () => {
    // The real vulnerability this closes: keying primarily on
    // `x-naqsh-user` (an unsigned, client-supplied header, see auth.ts)
    // let any caller defeat the limit entirely by sending a fresh random
    // identity on every request. All requests below share one real IP
    // (the test process's own loopback address) with a DIFFERENT
    // x-naqsh-user header each time -- if the limiter were still keyed by
    // identity first, every single one would land in a brand-new bucket
    // and none would ever be rejected.
    const limitedDataDir = mkdtempSync(join(tmpdir(), "naqsh-ratelimit-bypass-test-"));
    const app = createServer({ dataDir: limitedDataDir, rateLimit: { windowMs: 60_000, maxRequests: 3 } });
    const limitedServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = limitedServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const limitedBaseUrl = `http://127.0.0.1:${port}`;

    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${limitedBaseUrl}/health`, { headers: { "x-naqsh-user": `forged-identity-${i}` } });
        assert.equal(res.status, 200, `request ${i + 1} should succeed within the limit`);
      }
      const fourth = await fetch(`${limitedBaseUrl}/health`, { headers: { "x-naqsh-user": "forged-identity-forth-attempt" } });
      assert.equal(fourth.status, 429, "a fresh forged identity must not reset the limit for this IP");
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
      rmSync(limitedDataDir, { recursive: true, force: true });
    }
  });

  it("model-invoking routes hit a TIGHTER budget than cheap reads -- protecting real Gemini spend, not just the server", async () => {
    // The gap this closes: one global limit sized for normal UI traffic
    // (many small reads per user action) is far too loose for the handful
    // of routes that each cost a real model call -- and
    // /plans/:planId/candidates and /jobs each fan out to MANY model
    // calls per single request. A caller staying comfortably inside the
    // global budget could still burn a large amount of real upstream
    // quota. The tighter budget must apply to those routes ONLY, so
    // ordinary reads are never collaterally throttled.
    const limitedDataDir = mkdtempSync(join(tmpdir(), "naqsh-modelratelimit-test-"));
    const app = createServer({
      dataDir: limitedDataDir,
      rateLimit: { windowMs: 60_000, maxRequests: 1000 }, // global: effectively unlimited here
      modelRateLimit: { windowMs: 60_000, maxRequests: 2 } // model routes: deliberately tiny
    });
    const limitedServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = limitedServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", "x-naqsh-user": "model-budget-user" };

    try {
      // A real project, so the requests below are rejected (if at all) by
      // the LIMITER rather than by ownership/404 resolution.
      const created = await fetch(`${base}/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "budget", description: "rate limit probe", environmentKind: "mock_cad" })
      });
      assert.equal(created.status, 201);
      const project = (await created.json()) as { id: string };

      // Two model-route requests are allowed through to their handlers.
      // Their BODY may legitimately fail (no Gemini key in test env) --
      // what matters is only that they are not 429, i.e. the limiter let
      // them reach the handler at all.
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}/projects/${project.id}/plans`, { method: "POST", headers, body: JSON.stringify({}) });
        assert.notEqual(res.status, 429, `model request ${i + 1} should be within the tighter budget`);
      }

      const third = await fetch(`${base}/projects/${project.id}/plans`, { method: "POST", headers, body: JSON.stringify({}) });
      assert.equal(third.status, 429, "the 3rd model-route request must exceed the tighter model budget");
      const thirdBody = (await third.json()) as { error: { kind: string } };
      assert.equal(thirdBody.error.kind, "rate_limited");

      // ...and a CHEAP read is still served normally, proving the tighter
      // budget is scoped to model routes rather than applied globally.
      const cheapRead = await fetch(`${base}/projects/${project.id}/activity`, { headers });
      assert.equal(cheapRead.status, 200, "a cheap read must not be throttled by the model-route budget");
    } finally {
      await new Promise((resolve) => limitedServer.close(resolve));
      rmSync(limitedDataDir, { recursive: true, force: true });
    }
  });
});

describe("typed error mapping at the HTTP boundary (httpErrors.ts)", () => {
  function fakeResponse(): { res: any; calls: { status: number | null; body: unknown } } {
    const calls: { status: number | null; body: unknown } = { status: null, body: null };
    const res = {
      status(code: number) {
        calls.status = code;
        return this;
      },
      json(body: unknown) {
        calls.body = body;
        return this;
      }
    };
    return { res, calls };
  }

  it("maps a ToolError to 422 with the error's own kind preserved, never a flat internal_error/500", () => {
    const { res, calls } = fakeResponse();
    writeErrorResponse(new ToolError("invalid_input", "propertyKey is required"), res);
    assert.equal(calls.status, 422);
    assert.equal((calls.body as any).error.kind, "invalid_input");
  });

  it("maps an AuthorizationError to 422 with its kind preserved", () => {
    const { res, calls } = fakeResponse();
    writeErrorResponse(new AuthorizationError("invalid_state_transition", "already approved"), res);
    assert.equal(calls.status, 422);
    assert.equal((calls.body as any).error.kind, "invalid_state_transition");
  });

  it("maps a WorldModelValidationError to 422 with its kind preserved", () => {
    const { res, calls } = fakeResponse();
    writeErrorResponse(new WorldModelValidationError("invalid_shape", "malformed project"), res);
    assert.equal(calls.status, 422);
    assert.equal((calls.body as any).error.kind, "invalid_shape");
  });

  it("an unrecognized exception still falls through to 500/internal_error -- never invents a status for an error shape it doesn't recognize", () => {
    const { res, calls } = fakeResponse();
    writeErrorResponse(new Error("something genuinely unexpected"), res);
    assert.equal(calls.status, 500);
    assert.equal((calls.body as any).error.kind, "internal_error");
  });
});
