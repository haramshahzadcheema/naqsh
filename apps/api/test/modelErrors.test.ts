import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeModelError } from "../src/modelErrors.js";
import type { ModelError } from "@naqsh/schemas";

function err(message: string, kind: ModelError["kind"] = "provider_error"): ModelError {
  return { kind, message } as ModelError;
}

/**
 * The payload in the first test is not invented -- it is the exact string
 * captured from a real Gemini 503 while driving the running app, which is
 * how this defect was found.
 */
describe("describeModelError", () => {
  const REAL_503 = JSON.stringify({
    error: {
      message: '{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",\n    "status": "UNAVAILABLE"\n  }\n}\n',
      code: 503,
      status: "Service Unavailable"
    }
  });

  it("turns the REAL doubly-nested Gemini 503 into one actionable sentence, with no JSON left in it", () => {
    const text = describeModelError(err(REAL_503));
    assert.match(text, /temporarily overloaded/i);
    assert.match(text, /try again/i);
    assert.ok(!text.includes("{"), "no JSON may survive into user-facing text");
    assert.ok(!text.includes('\\"'), "no escaped quotes may survive either");
  });

  it("never tells you to retry an authentication failure -- that would waste the user's time", () => {
    const text = describeModelError(err(JSON.stringify({ error: { code: 401, message: "API key not valid" } })));
    assert.match(text, /API key/i);
    assert.match(text, /will not help/i);
  });

  it("distinguishes rate limiting from an outage", () => {
    assert.match(describeModelError(err(JSON.stringify({ error: { code: 429, message: "quota" } }))), /rate-limit/i);
  });

  it("falls back to the provider's OWN message when the status is unrecognised -- never a vague 'something went wrong'", () => {
    const text = describeModelError(err(JSON.stringify({ error: { code: 418, message: "Model refused to brew coffee" } })));
    assert.equal(text, "Model refused to brew coffee");
  });

  it("passes a plain non-JSON message through completely unchanged", () => {
    assert.equal(describeModelError(err("Connection reset by peer")), "Connection reset by peer");
  });

  it("uses the classified kind when there is no HTTP code to read", () => {
    assert.match(describeModelError(err("took too long", "timeout")), /too long/i);
    assert.match(describeModelError(err("no route to host", "api_unavailable")), /unreachable/i);
  });

  it("is honest when there is genuinely no reason available", () => {
    assert.match(describeModelError(undefined), /without reporting a reason/i);
    assert.match(describeModelError(err("   ")), /without reporting a reason/i);
  });

  it("never throws on malformed or hostile input", () => {
    for (const bad of ["{", "{}", '{"error":null}', '{"error":{}}', '{"error":"{"}', "null", "[]"]) {
      assert.equal(typeof describeModelError(err(bad)), "string");
    }
  });
});
