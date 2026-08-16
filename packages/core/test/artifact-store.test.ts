import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifactStore, computeContentHash, byteSizeOf } from "../src/artifact-store.js";

describe("ArtifactStore: put/get/has", () => {
  it("stores and retrieves content by id", () => {
    const store = createArtifactStore();
    store.put("artifact_1", "hello world");
    assert.equal(store.get("artifact_1"), "hello world");
    assert.equal(store.has("artifact_1"), true);
  });

  it("returns undefined/false for an unknown id", () => {
    const store = createArtifactStore();
    assert.equal(store.get("does_not_exist"), undefined);
    assert.equal(store.has("does_not_exist"), false);
  });

  it("refuses to overwrite an existing artifact id -- immutable once written", () => {
    const store = createArtifactStore();
    store.put("artifact_1", "original");
    assert.throws(() => store.put("artifact_1", "tampered"), /already exists/);
    // The original content must survive the rejected overwrite attempt.
    assert.equal(store.get("artifact_1"), "original");
  });

  it("rejects an empty artifactId", () => {
    const store = createArtifactStore();
    assert.throws(() => store.put("", "content"), /artifactId is required/);
  });

  it("two independent stores never share state", () => {
    const a = createArtifactStore();
    const b = createArtifactStore();
    a.put("shared_id", "from a");
    assert.equal(b.has("shared_id"), false);
  });
});

describe("computeContentHash: deterministic SHA-256 integrity signal", () => {
  it("produces a 64-character lowercase hex digest", () => {
    const hash = computeContentHash("hello world");
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic -- the same content always hashes the same way", () => {
    assert.equal(computeContentHash("some content"), computeContentHash("some content"));
  });

  it("detects a single-byte change -- corruption must be detectable", () => {
    assert.notEqual(computeContentHash("some content"), computeContentHash("some Content"));
  });
});

describe("byteSizeOf: UTF-8 byte length", () => {
  it("matches the exact UTF-8 byte length, not the JS string length", () => {
    // A multi-byte UTF-8 character (e) has a UTF-16 string length of 1 but
    // a UTF-8 byte length of 2 -- proves this is genuinely byte-accurate,
    // not just `.length`.
    const content = "café";
    assert.equal(content.length, 4);
    assert.equal(byteSizeOf(content), 5);
  });
});
