import { matchesToolValueSchema, type ModelRequest, type ModelResponse } from "@naqsh/schemas";

/**
 * `ModelResponse`'s own validator (schemas' `assertModelResponse`) only
 * checks that `structuredResult` is JSON-safe — it has no access to the
 * REQUEST that produced the response, so it cannot check the result
 * actually conforms to `ModelRequest.outputSchema`. Without this check, a
 * model could satisfy schema validation by returning ANY JSON-safe object
 * while claiming `kind: "structured_result"`, regardless of whether it
 * matches the shape NAQSH actually asked for — exactly the "wrong
 * primitive types" / "invalid enum values" class of hostile output the P7
 * audit calls out. Every `ModelProvider` implementation must run this
 * after constructing a `structured_result` response and before returning
 * `status: "success"` (see mock-model-provider.ts / gemini-model-provider.ts).
 *
 * Returns an empty array (valid, nothing to check) when `kind` isn't
 * `"structured_result"` or the request didn't specify an `outputSchema` —
 * there is no schema to validate against in either case.
 */
export function validateStructuredResult(response: ModelResponse, request: ModelRequest): string[] {
  if (response.kind !== "structured_result" || !request.outputSchema) {
    return [];
  }
  return matchesToolValueSchema(request.outputSchema, response.structuredResult, "structuredResult");
}
