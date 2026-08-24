import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockModelProvider } from "@naqsh/model-providers";
import type { ModelRequest } from "@naqsh/schemas";
import { analyzeFrame, parseImageDataUrl } from "../src/frameAnalysis.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("parseImageDataUrl: pure data-URL parsing", () => {
  it("parses a well-formed PNG data URL", () => {
    const parsed = parseImageDataUrl(`data:image/png;base64,${PNG_1X1_BASE64}`);
    assert.deepEqual(parsed, { mimeType: "image/png", dataBase64: PNG_1X1_BASE64 });
  });

  it("rejects a non-data-URL string", () => {
    assert.equal(parseImageDataUrl("not a data url"), null);
  });

  it("rejects a disallowed mime type", () => {
    assert.equal(parseImageDataUrl(`data:application/pdf;base64,${PNG_1X1_BASE64}`), null);
  });

  it("rejects malformed base64", () => {
    assert.equal(parseImageDataUrl("data:image/png;base64,not base64!!"), null);
  });
});

describe("analyzeFrame: real ModelProvider call, deterministic mock (no network)", () => {
  it("sends the frame as a bounded image attachment and returns the model's text", async () => {
    const seenRequests: ModelRequest[] = [];
    const provider = createMockModelProvider({
      respond: (request) => {
        seenRequests.push(request);
        return { response: { kind: "text", text: "This shows a bracket with four mounting holes." } };
      }
    });

    const outcome = await analyzeFrame(provider, {
      imageDataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
      question: "What is shown in this view?",
      modelConfig: { modelId: "mock-v1" }
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.status === "success" && outcome.text, "This shows a bracket with four mounting holes.");
    assert.equal(seenRequests.length, 1);
    const seenRequest = seenRequests[0];
    assert.ok(seenRequest);
    assert.equal(seenRequest.attachments.length, 1);
    const attachment = seenRequest.attachments[0];
    assert.ok(attachment);
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.dataBase64, PNG_1X1_BASE64);
    assert.match(seenRequest.instruction, /What is shown in this view/);
  });

  it("defaults the instruction to a generic prompt when no question is given", async () => {
    const seenRequests: ModelRequest[] = [];
    const provider = createMockModelProvider({
      respond: (request) => {
        seenRequests.push(request);
        return { response: { kind: "text", text: "ok" } };
      }
    });

    await analyzeFrame(provider, {
      imageDataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
      question: "   ",
      modelConfig: { modelId: "mock-v1" }
    });

    assert.match(seenRequests[0]?.instruction ?? "", /Describe what is visible/);
  });

  it("returns a structured invalid_input error for a malformed imageDataUrl, never calling the provider", async () => {
    let called = false;
    const provider = createMockModelProvider({
      respond: () => {
        called = true;
        return { response: { kind: "text", text: "should not be reached" } };
      }
    });

    const outcome = await analyzeFrame(provider, {
      imageDataUrl: "not a data url",
      question: "x",
      modelConfig: { modelId: "mock-v1" }
    });

    assert.equal(outcome.status, "error");
    assert.equal(outcome.status === "error" && outcome.error.kind, "invalid_input");
    assert.equal(called, false);
  });

  it("propagates a provider-level error rather than fabricating text", async () => {
    const provider = createMockModelProvider({
      respond: () => ({ error: { kind: "api_unavailable", message: "simulated outage" } })
    });

    const outcome = await analyzeFrame(provider, {
      imageDataUrl: `data:image/png;base64,${PNG_1X1_BASE64}`,
      question: "x",
      modelConfig: { modelId: "mock-v1" }
    });

    assert.equal(outcome.status, "error");
    assert.equal(outcome.status === "error" && outcome.error.kind, "api_unavailable");
  });
});
