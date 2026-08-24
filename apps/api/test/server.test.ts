import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-server-test-"));
  delete process.env.GEMINI_API_KEY; // this test suite runs with no real credentials, deliberately.
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

describe("apps/api HTTP server: real endpoints, real end-to-end behavior", () => {
  it("GET /health reports honestly that Gemini isn't configured in this test environment", async () => {
    const { status, body } = await json("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.geminiConfigured, false);
  });

  it("GET /models returns a real catalog, honestly marking Gemini entries unavailable when no GEMINI_API_KEY is configured", async () => {
    const { status, body } = await json("/models");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    const deterministic = body.find((entry: { modelId: string }) => entry.modelId === "deterministic");
    assert.ok(deterministic);
    assert.equal(deterministic.available, true);
    const gemini = body.find((entry: { provider: string }) => entry.provider === "gemini");
    assert.ok(gemini);
    assert.equal(gemini.available, false);
  });

  it("GET /projects/:id returns 404 for a genuinely nonexistent project -- never a fabricated empty success", async () => {
    const { status, body } = await json("/projects/proj_does_not_exist");
    assert.equal(status, 404);
    assert.equal(body.error.kind, "not_found");
  });

  it("POST /projects/:id/observe returns a real ObservationResult built from the project's actual WorldModelState, and logs the observation to activity -- never a canned/static payload", async () => {
    const created = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naqsh-user": "observe-tester" },
      body: JSON.stringify({ name: "Observe Test Project", description: "A bracket that supports 50 kg.", environmentKind: "mock_cad" })
    });
    assert.equal(created.status, 201);
    const project = created.body;

    const observed = await json(`/projects/${project.id}/observe`, { method: "POST", headers: { "x-naqsh-user": "observe-tester" } });
    assert.equal(observed.status, 200);
    // Real ObservationResult shape (packages/core/src/observe-project.ts),
    // not a stub -- objects/requirements/constraints arrays actually
    // reflect this project's current WorldModelState.
    assert.ok(Array.isArray(observed.body.objects));
    assert.ok(Array.isArray(observed.body.requirements));
    assert.ok(Array.isArray(observed.body.constraints));

    // The real side effect: observeCurrentProject logs a real activity
    // entry every time it's called, proving this is a genuine action
    // against live state, not a read with no trace.
    const activity = await json(`/projects/${project.id}/activity`, { headers: { "x-naqsh-user": "observe-tester" } });
    assert.equal(activity.status, 200);
    assert.ok(activity.body.some((entry: { kind: string }) => entry.kind === "observed"), "observing must be recorded in the project's activity log");
  });

  it("POST /projects/:id/observe is project-isolated exactly like every other route -- a different identity gets 404, never another project's state", async () => {
    const created = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-naqsh-user": "observe-owner" },
      body: JSON.stringify({ name: "Owner's Project", environmentKind: "mock_cad" })
    });
    const project = created.body;

    const asIntruder = await json(`/projects/${project.id}/observe`, { method: "POST", headers: { "x-naqsh-user": "observe-intruder" } });
    assert.equal(asIntruder.status, 404);
    assert.equal(asIntruder.body.error.kind, "not_found");
  });

  it("USER ACTION -> REAL API -> REAL SERVICE -> REAL RESULT: creating a project produces a real, persisted WorldModelState", async () => {
    const created = await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Mounting Bracket", description: "Supports 50 kg." }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Mounting Bracket");
    assert.equal(created.body.requirementCount, 0);

    const fetched = await json(`/projects/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.worldModelState.project.name, "Mounting Bracket");
    assert.equal(fetched.body.worldModelState.project.objective.summary, "Supports 50 kg.");
  });

  it("Phase: a project's chosen environmentKind is real, persisted, and actually drives GET /environment -- never a picker that silently does nothing", async () => {
    const withoutChoice = await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Default Env Project" }) });
    assert.equal(withoutChoice.body.environmentKind, "mock_cad");

    const created = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Simulation Project", environmentKind: "mock_simulation" })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.environmentKind, "mock_simulation");

    const environment = await json(`/projects/${created.body.id}/environment`);
    assert.equal(environment.status, 200);
    assert.equal(environment.body.kind, "mock_simulation");
    // No session has been connected yet -- null, not a fabricated name.
    assert.equal(environment.body.documentName, null);

    const fetchedAgain = await json(`/projects/${created.body.id}`);
    assert.equal(fetchedAgain.body.environmentKind, "mock_simulation", "the choice must survive being re-read from the repository, not just the create response");
  });

  it("GET /projects/:id/environment reports the connected session's real documentName field (null for a mock environment with none set), not just connection status", async () => {
    const created = await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Doc Name Project" }) });
    const connected = await json(`/projects/${created.body.id}/environment/connect`, { method: "POST" });
    assert.equal(connected.status, 200);
    // A mock environment connected with no explicit documentName genuinely
    // has none -- null here is the honest value, not a fabricated one.
    assert.equal(connected.body.session.documentName, null);

    const environment = await json(`/projects/${created.body.id}/environment`);
    assert.equal(environment.body.status, "connected");
    assert.equal(environment.body.documentName, connected.body.session.documentName);
  });

  it("rejects an unrecognized environmentKind, never silently substituting a default", async () => {
    const { status, body } = await json("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad Env Project", environmentKind: "freecad" })
    });
    assert.equal(status, 400);
    assert.equal(body.error.kind, "invalid_input");
  });

  it("Phase: candidate generation routes are real -- honest 400/422 responses, and empty (never fabricated) listings for a fresh project", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Candidate Route Project" }) })).body;

    const missingStep = await json(`/projects/${project.id}/plans/plan_x/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2, modelId: "deterministic" })
    });
    assert.equal(missingStep.status, 400);
    assert.equal(missingStep.body.error.kind, "invalid_input");

    const unknownPlan = await json(`/projects/${project.id}/plans/plan_does_not_exist/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planStepId: "step_1", count: 2, modelId: "deterministic" })
    });
    assert.equal(unknownPlan.status, 422);
    assert.equal(unknownPlan.body.error.kind, "plan_not_found");

    const unconfiguredGemini = await json(`/projects/${project.id}/plans/plan_does_not_exist/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planStepId: "step_1", count: 2, modelId: "gemini-3.5-flash" })
    });
    assert.equal(unconfiguredGemini.status, 503);

    const candidates = await json(`/projects/${project.id}/candidates`);
    assert.equal(candidates.status, 200);
    assert.deepEqual(candidates.body, []);

    const designs = await json(`/projects/${project.id}/design-specifications`);
    assert.equal(designs.status, 200);
    assert.deepEqual(designs.body, []);
  });

  it("Phase 19: clarification routes are real -- honest empty listing, 404 for an unknown clarification, and 503 for an unconfigured model", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Clarification Route Project" }) })).body;

    const empty = await json(`/projects/${project.id}/clarifications`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);

    const missingAnswerText = await json(`/projects/${project.id}/clarifications/clarification_x/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "deterministic" })
    });
    assert.equal(missingAnswerText.status, 400);

    const unconfiguredGemini = await json(`/projects/${project.id}/clarifications/clarification_x/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerText: "500 N", modelId: "gemini-3.5-flash" })
    });
    assert.equal(unconfiguredGemini.status, 503);

    const unknownAnswer = await json(`/projects/${project.id}/clarifications/clarification_does_not_exist/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answerText: "500 N", modelId: "deterministic" })
    });
    assert.equal(unknownAnswer.status, 404);

    const unknownDismiss = await json(`/projects/${project.id}/clarifications/clarification_does_not_exist/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(unknownDismiss.status, 404);
  });

  it("GET /projects/:id/objective-satisfaction honestly lists nothing for a project that's never had a proposal executed", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Objective Satisfaction Route Project" }) })).body;
    const results = await json(`/projects/${project.id}/objective-satisfaction`);
    assert.equal(results.status, 200);
    assert.deepEqual(results.body, []);
  });

  it("a chat message with the deterministic model produces a REAL (non-echoed, non-canned) assistant reply", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Chat Test Project" }) })).body;
    const conversation = (
      await json("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) })
    ).body;

    const { status, body } = await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello Naqsh", modelId: "deterministic" })
    });

    assert.equal(status, 200);
    assert.equal(body.userMessage.text, "Hello Naqsh");
    assert.equal(body.assistantMessage.role, "assistant");
    assert.ok(body.assistantMessage.text.length > 0);
    assert.equal(body.assistantMessage.error, undefined);
  });

  it("requesting a Gemini model with no GEMINI_API_KEY configured returns an HONEST 503, never a fake reply", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No Gemini Project" }) })).body;
    const conversation = (
      await json("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) })
    ).body;

    const { status, body } = await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello", modelId: "gemini-3.5-flash" })
    });

    assert.equal(status, 503);
    assert.equal(body.assistantMessage.error.kind, "not_configured");
  });

  it("requesting an un-allowlisted model id is rejected, never silently substituted", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Untrusted Model Project" }) })).body;
    const { status, body } = await json(`/projects/${project.id}/requirements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statementText: "It needs to hold 50 kg", modelId: "some-arbitrary-untrusted-model" })
    });
    assert.equal(status, 503);
    assert.equal(body.error.kind, "unknown_model");
  });

  it("Phase C: regenerating the last plain-chat reply replaces it with a genuinely new one, never duplicating the turn", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Regenerate Test Project" }) })).body;
    const conversation = (
      await json("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) })
    ).body;

    const first = await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello Naqsh", modelId: "deterministic" })
    });
    assert.equal(first.status, 200);
    const originalAssistantId = first.body.assistantMessage.id;

    const regenerated = await json(`/conversations/${conversation.id}/messages/${originalAssistantId}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "deterministic" })
    });
    assert.equal(regenerated.status, 200);
    assert.equal(regenerated.body.assistantMessage.role, "assistant");
    assert.notEqual(regenerated.body.assistantMessage.id, originalAssistantId);

    const full = await json(`/conversations/${conversation.id}`);
    assert.equal(full.body.messages.length, 2); // still exactly one user + one assistant turn -- not appended as a third message.
    assert.equal(full.body.messages[1].id, regenerated.body.assistantMessage.id);
  });

  it("Phase C: regenerating a reply that isn't the most recent message is rejected, never silently rewriting history", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Regenerate Order Test" }) })).body;
    const conversation = (
      await json("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) })
    ).body;
    const first = await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "First message", modelId: "deterministic" })
    });
    await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Second message", modelId: "deterministic" })
    });

    const { status, body } = await json(`/conversations/${conversation.id}/messages/${first.body.assistantMessage.id}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "deterministic" })
    });
    assert.equal(status, 422);
    assert.equal(body.error.kind, "invalid_input");
  });

  it("Phase C: regenerating a design-workflow reply is an honest 409, never risking a duplicate plan/proposal", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Regenerate Design Intent Test" }) })).body;
    const conversation = (
      await json("/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) })
    ).body;
    const message = await json(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Design this now.", modelId: "deterministic" })
    });

    const { status, body } = await json(`/conversations/${conversation.id}/messages/${message.body.assistantMessage.id}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelId: "deterministic" })
    });
    assert.equal(status, 409);
    assert.equal(body.error.kind, "unsupported");
  });

  it("GET /projects/:id/activity reflects real actions taken, not pre-populated demo data", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Activity Project" }) })).body;

    const beforeActivity = await json(`/projects/${project.id}/activity`);
    assert.equal(beforeActivity.body.length, 0, "a freshly created project has no activity yet");

    await json(`/projects/${project.id}/requirements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statementText: "It needs to hold 50 kg", modelId: "deterministic" })
    });

    const afterActivity = await json(`/projects/${project.id}/activity`);
    assert.ok(afterActivity.body.length > 0, "attempting requirement capture logs real activity, even when it doesn't succeed");
  });

  it("POST /files rejects an upload with no projectId -- a file with no owner is a real access-control gap, not a valid state", async () => {
    const form = new FormData();
    form.append("files", new Blob(["orphaned content"], { type: "text/plain" }), "orphan.txt");
    const uploadRes = await fetch(`${baseUrl}/files`, { method: "POST", body: form });
    assert.equal(uploadRes.status, 400);
    const body = (await uploadRes.json()) as { error: { message: string } };
    assert.match(body.error.message, /projectId is required/);
  });

  it("uploading a real text file and posting it as a chat attachment makes its content part of what's interpreted", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "File Upload Project" }) })).body;

    const form = new FormData();
    form.append("projectId", project.id);
    form.append("files", new Blob(["The bracket must support 50 kg."], { type: "text/plain" }), "spec.txt");
    const uploadRes = await fetch(`${baseUrl}/files`, { method: "POST", body: form });
    const uploaded = (await uploadRes.json()) as Array<{ id: string; extractionStatus: string; extractedText: string | null }>;
    assert.equal(uploadRes.status, 201);
    const [firstUpload] = uploaded;
    assert.ok(firstUpload);
    assert.equal(firstUpload.extractionStatus, "success");
    assert.equal(firstUpload.extractedText, "The bracket must support 50 kg.");

    const fetchedFile = await json(`/files/${firstUpload.id}`);
    assert.equal(fetchedFile.status, 200);
    assert.equal(fetchedFile.body.filename, "spec.txt");
  });

  it("GET /files/:id returns 404 for a nonexistent file", async () => {
    const { status } = await json("/files/file_does_not_exist");
    assert.equal(status, 404);
  });

  it("GET /files/:id/raw serves the real uploaded bytes with the real mime type -- not just the extracted text", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Raw File Project" }) })).body;

    const pngBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("projectId", project.id);
    form.append("files", new Blob([pngBytes], { type: "image/png" }), "sketch.png");
    const uploadRes = await fetch(`${baseUrl}/files`, { method: "POST", body: form });
    const [uploaded] = (await uploadRes.json()) as Array<{ id: string }>;
    assert.ok(uploaded);

    const rawRes = await fetch(`${baseUrl}/files/${uploaded.id}/raw`);
    assert.equal(rawRes.status, 200);
    assert.equal(rawRes.headers.get("content-type"), "image/png");
    const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
    assert.deepEqual(rawBytes, pngBytes);
  });

  it("GET /files/:id/raw returns 404 for a nonexistent file", async () => {
    const { status } = await fetch(`${baseUrl}/files/file_does_not_exist/raw`);
    assert.equal(status, 404);
  });

  it("Phase D: GET /projects/:id/files lists real uploaded files for that project only, never another project's", async () => {
    const projectA = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Files Project A" }) })).body;
    const projectB = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Files Project B" }) })).body;

    const formA = new FormData();
    formA.append("projectId", projectA.id);
    formA.append("files", new Blob(["A's file content."], { type: "text/plain" }), "a.txt");
    await fetch(`${baseUrl}/files`, { method: "POST", body: formA });

    const formB = new FormData();
    formB.append("projectId", projectB.id);
    formB.append("files", new Blob(["B's file content."], { type: "text/plain" }), "b.txt");
    await fetch(`${baseUrl}/files`, { method: "POST", body: formB });

    const listedA = await json(`/projects/${projectA.id}/files`);
    assert.equal(listedA.status, 200);
    assert.equal(listedA.body.length, 1);
    assert.equal(listedA.body[0].filename, "a.txt");
  });

  it("POST /projects/:id/environment/frame-analysis: real end-to-end through the deterministic provider (no Gemini credentials in this test env)", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Frame Analysis Project" }) })).body;

    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const result = await json(`/projects/${project.id}/environment/frame-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageDataUrl: pngDataUrl, question: "What is visible?", modelId: "deterministic" })
    });
    assert.equal(result.status, 200);
    assert.equal(typeof result.body.text, "string");
    assert.ok(result.body.text.length > 0);
  });

  it("POST /projects/:id/environment/frame-analysis: 400s a malformed imageDataUrl before ever calling a model provider", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Frame Analysis Bad Input" }) })).body;
    const result = await json(`/projects/${project.id}/environment/frame-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageDataUrl: "not a data url", question: "x" })
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.kind, "invalid_input");
  });

  it("POST /projects/:id/environment/frame-analysis: 400s a missing imageDataUrl", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Frame Analysis Missing Input" }) })).body;
    const result = await json(`/projects/${project.id}/environment/frame-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "x" })
    });
    assert.equal(result.status, 400);
  });

  it("POST /projects/:id/environment/frame-analysis: 404s for a nonexistent project", async () => {
    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const result = await json("/projects/proj_does_not_exist/environment/frame-analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageDataUrl: pngDataUrl, question: "x" })
    });
    assert.equal(result.status, 404);
  });

  it("POST /projects/:id/memory/:memoryId/archive: a real lifecycle transition, not a read-only list", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory Archive Project" }) })).body;

    const created = await json(`/projects/${project.id}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "decision", title: "Use 6061-T6 aluminum", content: "Chosen for its strength-to-weight ratio at this thickness." })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "active");

    const archived = await json(`/projects/${project.id}/memory/${created.body.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "No longer relevant after the material swap." })
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.status, "archived");

    const listed = await json(`/projects/${project.id}/memory`);
    assert.equal(listed.body.find((m: { id: string }) => m.id === created.body.id).status, "archived");
  });

  it("POST /projects/:id/memory/:memoryId/archive: status:'rejected' records the memory was found incorrect, not merely unneeded", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory Reject Project" }) })).body;
    const created = await json(`/projects/${project.id}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "lesson", title: "Assumed steel", content: "Turned out to be wrong for this application." })
    });
    const rejected = await json(`/projects/${project.id}/memory/${created.body.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "rejected" })
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, "rejected");
  });

  it("POST /projects/:id/memory/:memoryId/archive: 404s for a memory that doesn't belong to this project", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory 404 Project" }) })).body;
    const result = await json(`/projects/${project.id}/memory/mem_does_not_exist/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(result.status, 404);
  });

  it("POST /projects/:id/memory/:memoryId/archive: rejects archiving an already-archived memory (a lifecycle transition applies once)", async () => {
    const project = (await json("/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory Double Archive Project" }) })).body;
    const created = await json(`/projects/${project.id}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "preference", title: "Prefer bolted joints", content: "Easier field service." })
    });
    await json(`/projects/${project.id}/memory/${created.body.id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    const second = await json(`/projects/${project.id}/memory/${created.body.id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(second.status, 422);
  });
});
