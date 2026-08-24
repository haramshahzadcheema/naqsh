import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pdfFileProcessor, processFile, textFileProcessor, withTimeout } from "../src/fileProcessing.js";

describe("withTimeout: bounds a slow/pathological parse instead of awaiting it indefinitely", () => {
  it("resolves with the real value when the promise settles before the deadline", async () => {
    const value = await withTimeout(Promise.resolve("real result"), 1000, "should not fire");
    assert.equal(value, "real result");
  });

  it("rejects with the timeout message once the deadline passes, without waiting for the slow promise", async () => {
    const neverResolves = new Promise(() => {});
    await assert.rejects(() => withTimeout(neverResolves, 10, "PDF processing timed out"), /PDF processing timed out/);
  });
});

describe("apps/api file processing: honest about what it can and can't actually extract", () => {
  it("a .txt file's content is extracted verbatim", async () => {
    const result = await processFile("text/plain", "requirements.txt", Buffer.from("Load capacity: 50 kg."));
    assert.equal(result.status, "success");
    assert.equal(result.text, "Load capacity: 50 kg.");
    assert.equal(result.error, null);
  });

  it("a .md file is recognized by extension even with a generic MIME type", async () => {
    assert.equal(textFileProcessor.canHandle("application/octet-stream", "spec.md"), true);
  });

  it("an unsupported file type (e.g. an image) is reported as 'unsupported', never silently treated as text", async () => {
    const result = await processFile("image/png", "drawing.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(result.status, "unsupported");
    assert.equal(result.text, null);
  });

  it("pdfFileProcessor claims .pdf files and application/pdf, nothing else", () => {
    assert.equal(pdfFileProcessor.canHandle("application/pdf", "spec.pdf"), true);
    assert.equal(pdfFileProcessor.canHandle("application/octet-stream", "model.fcstd"), false);
  });

  it("a PDF that isn't actually a valid PDF fails honestly -- 'failed', with a real error message, never silently returns empty success", async () => {
    const result = await pdfFileProcessor.process(Buffer.from("this is not a real PDF file"));
    assert.equal(result.status, "failed");
    assert.equal(result.text, null);
    assert.ok(result.error && result.error.length > 0);
  });

  it("extracted text is bounded, never dumped whole into a model context regardless of upload size", async () => {
    const huge = "x".repeat(100_000);
    const result = await processFile("text/plain", "huge.txt", Buffer.from(huge));
    assert.equal(result.status, "success");
    assert.ok(result.text && result.text.length < huge.length);
  });
});
