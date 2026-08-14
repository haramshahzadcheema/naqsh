import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModelRequest, createModelResponse, type ModelRequest } from "@naqsh/schemas";
import { validateStructuredResult } from "../src/validate-model-response.js";

function buildRequest(outputSchema?: Parameters<typeof createModelRequest>[0]["outputSchema"]): ModelRequest {
  return createModelRequest({
    context: {},
    instruction: "status",
    outputSchema,
    config: { modelId: "mock-v1" }
  });
}

describe("validateStructuredResult", () => {
  it("returns no errors when the structured result matches the requested schema", () => {
    const request = buildRequest({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult: { ok: true } });
    assert.deepEqual(validateStructuredResult(response, request), []);
  });

  it("returns errors when the structured result violates the requested schema", () => {
    const request = buildRequest({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const response = createModelResponse({
      requestId: request.id,
      kind: "structured_result",
      structuredResult: { ok: "not-a-boolean" }
    });
    const errors = validateStructuredResult(response, request);
    assert.equal(errors.length > 0, true);
    assert.match(errors[0]!, /must be a boolean/);
  });

  it("returns errors when a required field is missing", () => {
    const request = buildRequest({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult: {} });
    const errors = validateStructuredResult(response, request);
    assert.equal(errors.length > 0, true);
  });

  it("returns no errors when the request declared no outputSchema -- nothing to validate against", () => {
    const request = buildRequest(undefined);
    const response = createModelResponse({ requestId: request.id, kind: "structured_result", structuredResult: { anything: 1 } });
    assert.deepEqual(validateStructuredResult(response, request), []);
  });

  it("returns no errors for a non-structured_result response, even with an outputSchema present", () => {
    const request = buildRequest({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    const response = createModelResponse({ requestId: request.id, kind: "text", text: "hello" });
    assert.deepEqual(validateStructuredResult(response, request), []);
  });
});
