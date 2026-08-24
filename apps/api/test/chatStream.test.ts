import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "../src/server.js";

/**
 * Part 10's SSE streaming endpoint (`POST /conversations/:id/messages/
 * stream`), tested against the REAL running Express server (not a mocked
 * transport) -- real HTTP, real SSE framing, real body parsing on this
 * end. The deterministic mock provider has no `generateStream` (see
 * mock-model-provider.ts -- it has nothing to progressively reveal), so
 * these tests exercise the honest "single `done` event, zero `delta`
 * events" fallback path -- the actual, disclosed behavior when the
 * selected model can't genuinely stream, never a simulated one.
 */

let baseUrl: string;
let server: Server;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "naqsh-stream-test-"));
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

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsedBody = await res.json().catch(() => null);
  return { status: res.status, body: parsedBody };
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Reads a whole SSE response body and parses it into discrete events --
 * a small, real parser (not a mock), since this is exactly what a real
 * client (or the frontend's own SSE reader) has to do. */
async function readSseEvents(res: Response): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = raw.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
      if (eventLine && dataLine) {
        events.push({ event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) });
      }
    }
  }
  return events;
}

describe("POST /conversations/:id/messages/stream", () => {
  it("with a provider that cannot genuinely stream (deterministic), delivers exactly one 'done' event and zero 'delta' events -- never a fake drip-fed reveal", async () => {
    const project = (await postJson("/projects", { name: "Streaming Test Project" })).body;
    const conversation = (await postJson("/conversations", { projectId: project.id })).body;

    const res = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello Naqsh", modelId: "deterministic" })
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = await readSseEvents(res);
    const deltas = events.filter((e) => e.event === "delta");
    const done = events.filter((e) => e.event === "done");
    assert.equal(deltas.length, 0, "the deterministic provider has nothing to progressively reveal -- it must never fake incremental delivery");
    assert.equal(done.length, 1);

    const finalResult = done[0]!.data as { userMessage: { text: string }; assistantMessage: { role: string; text: string } };
    assert.equal(finalResult.userMessage.text, "Hello Naqsh");
    assert.equal(finalResult.assistantMessage.role, "assistant");
    assert.ok(finalResult.assistantMessage.text.length > 0);
  });

  it("the final 'done' event's shape matches the plain (non-streaming) JSON endpoint's response shape exactly, so the frontend can share one result-handling path", async () => {
    const project = (await postJson("/projects", { name: "Shape Parity Project" })).body;
    const conversation = (await postJson("/conversations", { projectId: project.id })).body;

    const plain = await postJson(`/conversations/${conversation.id}/messages`, { text: "hi", modelId: "deterministic" });

    const streamRes = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi again", modelId: "deterministic" })
    });
    const events = await readSseEvents(streamRes);
    const done = events.find((e) => e.event === "done")!.data as Record<string, unknown>;

    assert.deepEqual(Object.keys(done).sort(), Object.keys(plain.body).sort());
  });

  it("a Gemini model with no GEMINI_API_KEY configured returns the SAME honest 503 JSON as the non-streaming endpoint, never an SSE stream pretending to work", async () => {
    const project = (await postJson("/projects", { name: "No Gemini Stream Project" })).body;
    const conversation = (await postJson("/conversations", { projectId: project.id })).body;

    const res = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", modelId: "gemini-3.5-flash" })
    });
    assert.equal(res.status, 503);
    assert.doesNotMatch(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = (await res.json()) as { assistantMessage: { error: { kind: string } } };
    assert.equal(body.assistantMessage.error.kind, "not_configured");
  });

  it("a conversation belonging to a different identity is unreachable through the streaming endpoint, same as the plain one", async () => {
    const project = (await postJson("/projects", { name: "Isolated Stream Project" })).body;
    const conversation = (await postJson("/conversations", { projectId: project.id })).body;

    const res = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-naqsh-user": "someone-else" },
      body: JSON.stringify({ text: "intrusion attempt", modelId: "deterministic" })
    });
    assert.equal(res.status, 404);
  });
});
