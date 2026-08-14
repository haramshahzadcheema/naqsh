import type { ModelInvocationResult, ModelProviderDescriptor, ModelRequest } from "@naqsh/schemas";

/**
 * The Gemini/model-provider contract (P7) — the ONE way anything in this
 * repo is allowed to talk to a large language model. Lives in core, not a
 * provider package, for the same reason `EnvironmentAdapter` (P5) does:
 * core CONSUMES this abstraction and must be able to name the type without
 * depending on any concrete SDK. Concrete providers (the deterministic mock
 * and the real Gemini adapter, both in @naqsh/model-providers) live
 * strictly "below" this boundary and depend ON core/schemas, never the
 * reverse — enforced as a regression test in
 * packages/core/test/repo-boundaries.test.ts, exactly like the
 * adapters-package boundary. Nothing in this file, or anywhere else in
 * packages/core, imports `@google/genai` or any other provider SDK.
 *
 * `generate()` returns `Promise<ModelInvocationResult>` (never a bare
 * `ModelResponse`, never a thrown exception for an EXPECTED failure) — the
 * same discipline `executeTool` (P3) and `EnvironmentAdapter` (P5) already
 * established: a caller branches on `result.status`/`result.error.kind`,
 * never wraps every call in try/catch. API unavailability, auth failure,
 * timeout, rate limiting, and malformed/invalid model output are all
 * EXPECTED failure modes for a network-backed LLM call — none of them may
 * escape as a rejected promise. `describe()` is the one exception: it is
 * synchronous, static, and cannot fail.
 *
 * Authorization boundary: this interface has no concept of `AutonomyLevel`,
 * `Approval`, or `AutonomyGrant`, and no implementation of it may import
 * P4's authorization machinery (enforced in repo-boundaries.test.ts) — a
 * model provider is a dumb request/response mechanism, never a policy
 * decision point. A `ModelResponse` of kind `"tool_call"` carries an inert
 * `ModelToolCallIntent` (a name and JSON-safe arguments, structurally
 * incapable of carrying executable code) — it is NOT executed by anything
 * in this file or by any `ModelProvider` implementation. The only
 * sanctioned path from a tool-call intent to an actual tool invocation is
 * `executeModelToolCallIntent` (core), which does nothing but hand the
 * intent to the EXACT SAME `executeTool` boundary (validation -> the
 * `authorize` hook -> the registered handler) every other tool call goes
 * through. Gemini never gets a `ToolRegistry` reference, never gets a
 * `WorldModelState` reference, and never gets to decide whether a call is
 * authorized.
 */
export interface ModelProvider {
  /** Static identity + capabilities. Cannot fail. */
  describe(): ModelProviderDescriptor;

  /** The one way to ask a model to respond. `request` is a fully-formed,
   * already-bounded `ModelRequest` — this method does not reach into
   * `WorldModelState`, a `ToolRegistry`, or anything else "live"; whatever
   * context/tools the model needs must already be data on `request` (see
   * core's `buildModelContext`/`toModelToolDeclarations`). */
  generate(request: ModelRequest): Promise<ModelInvocationResult>;
}
