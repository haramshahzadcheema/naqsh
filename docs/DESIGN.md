# Naqsh — the core model, and what is deliberately absent

Split out of the README so the front page stays readable. This is the
reference for how the World Model, tools and authorization actually fit
together, and an honest list of what has NOT been built.

See [PHASES.md](PHASES.md) for the phase-by-phase implementation notes.

---

## World Model, Change Model, Tools, and Authorization

- **World Model** (P1) — `WorldModelState` is the current materialized
  state. `updateWorldModel(state, transition)` is a pure reducer; it has no
  knowledge of history or persistence.
- **Change Model** (P2) — `recordTransition(history, state, transition)`
  wraps the reducer to also produce a `Change`: a frozen, JSON-safety-checked
  record of what changed, before/after, who/what caused it, and why.
  `ChangeHistory` is an in-memory, append-only, sequence- and
  parent-chain-verified log — the "how did we get here," never the current
  state itself.
- **Tools** (P3) — `Tool` is pure metadata (identity, target domain,
  mutation classification, JSON-Schema-compatible input/output contracts);
  it never carries a handler. `ToolRegistry` pairs a `Tool` with its handler
  function in a private closure — there is no `invoke`/`execute` method on
  `ToolRegistry` itself; dispatch lives in a free function
  (`invokeRegisteredTool`) that is deliberately NOT exported from
  `@naqsh/core`'s public barrel, so `executeTool` is the only realistic
  caller. `executeTool` is the sanctioned way to run a tool: validate input
  → policy seam (an `authorize` hook) → handler → validate output → a
  structured `ToolResult`, never a thrown exception for an expected failure
  mode. A mutating tool's handler returns transition-shaped *data*; the
  caller feeds that through the existing `recordTransition` pipeline, so a
  tool can never bypass the World Model or mutate hidden state.
- **Authorization** (P4) — four ordered `AutonomyLevel`s (`observe` <
  `suggest` < `approved_modify` < `autonomous`, ordering is load-bearing:
  it's the rank comparison). `evaluateToolAuthorization` is the
  deterministic decision function: given a `Tool`'s mutation
  classification, the current autonomy level, and the current contents of
  an `ApprovalStore`/`AutonomyGrantStore`, it returns an
  `AuthorizationDecision` — allowed, or denied with one of fourteen named
  reasons (never a bare `Error("denied")`). It never mutates the stores it
  reads (deciding and consuming an approval/grant-use are separate,
  explicit steps) and never consults an LLM. `createExecuteToolAuthorizer`
  adapts it into the exact shape `executeTool`'s `authorize` hook expects —
  the only integration point between P3 and P4; `executeTool` itself is
  unmodified in behavior and still has no idea autonomy levels exist. Its
  optional `onDecision` hook (called with every decision, allowed or
  denied) has a small, reusable reference implementation —
  `createAuthorizationLogger()` (`authorization-logger.ts`, external audit
  fix) — that turns each decision into one structured JSON log line to an
  injectable sink (defaulting to `console.log`); a caller wires it in with
  `createExecuteToolAuthorizer({ ..., onDecision: createAuthorizationLogger() })`.
  `core` still does not log anything on its own — this is opt-in, not a new
  default behavior.
  `Approval` authorizes exactly one `(toolName, target)` pair and is
  single-use (`consumedAt`); `AutonomyGrant` authorizes a bounded set of
  future calls (explicit `toolNames` allowlist, optional target scope,
  optional `expiresAt`/`maxUses`) and is revocable. Both record who acted
  on them (`Approval.decidedBy`, `AutonomyGrant.revokedBy`) — no state
  transition happens without a recorded actor. When more than one
  approval/grant covers a call, the MOST SPECIFIC one wins (exact target >
  target-type-only > fully open), not merely the first one found, so a
  narrow rejection can't be shadowed by a broader approval created earlier.
- **Environment Adapter** (P5) — `EnvironmentAdapter` (core) is the ONE way
  anything in this repo is allowed to talk to an external engineering
  environment (CAD, simulation, manufacturing, robotics, EDA, ...). Eleven
  methods (`describe`/`health`/`connect`/`disconnect`/`listObjects`/
  `inspectObject`/`createObject`/`modifyObject`/`deleteObject`/`save`/
  `checkpoint`/`restore`), every one of them present on every adapter
  regardless of what it actually supports — an adapter that doesn't
  support `create` still has a `createObject` method; calling it resolves
  to `{status:"error", error:{kind:"unsupported_capability"}}` rather than
  being absent or throwing. What an adapter *can* do is declared up front
  via `EnvironmentDescriptor.capabilities` (`create`/`modify`/`delete`/
  `save`/`checkpoint` — reading is always assumed baseline). This is what
  lets ONE reusable suite, `runEnvironmentAdapterContractTests` (core),
  run unmodified against adapters with entirely different capability
  profiles — proven today by `packages/adapters`' mocks
  (`createMockCadEnvironment`: full capability set;
  `createMockSimulationEnvironment`: `modify` + `checkpoint` only, fixed topology (P26);
  `createMockEnvironment`: P6's deterministic lab, see below) and intended
  to run against a real `FreeCADAdapter` in P12+ the exact same way.
  `EnvironmentObject` is deliberately NOT `EngineeringObject`: an adapter
  reports a raw environment fact, not NAQSH's interpreted domain belief —
  nothing in `environment-adapter.ts` or any mock ever touches
  `WorldModelState`/`ChangeHistory`/`updateWorldModel` (enforced as a
  repo-boundaries regression test). Reconciling environment observations
  into the World Model (Environment → observation → interpretation →
  World Model update) is P8's job, not P5's. `connect()` takes an optional,
  environment-specific `options` bag (e.g. which document to open) — the
  one write-shaped parameter every adapter needs but whose shape can never
  be fixed by the contract itself.
- **Deterministic mock environment** (P6) — `createMockEnvironment`
  (`packages/adapters/src/mock-environment.ts`) is the canonical laboratory
  later phases build and test against, distinct from the two P5 example
  mocks (which exist only to prove the contract tolerates different
  capability profiles). It returns a plain `EnvironmentAdapter` — no
  parallel mock interface — built on the same
  `createInMemoryEnvironmentAdapter` engine as every other mock, so
  `Core/Tool → EnvironmentAdapter → createMockEnvironment → in-memory
  state` is a real call chain, not a diagram. `describe().kind` is the
  literal string `"mock"`, never a real environment's name. Deterministic
  *by default*: every instance gets its own fresh
  `createDeterministicIdGenerator()`/`createDeterministicClock()`
  (`packages/adapters/src/deterministic.ts`) — a per-prefix counter and a
  logical clock that only ever advances when called, never touching
  `Math.random()`/wall-clock time — so the same sequence of operations
  against two independent instances produces byte-identical
  `EnvironmentOperationResult`s, ids and timestamps included, while two
  instances never share state. `generateId`/`now` are injectable on both
  `createMockEnvironment` and the underlying engine for callers that need
  specific values. Full capability set, two seeded objects with one
  seeded relationship between them (proving `EnvironmentObject`'s
  relationship field is actually exercised, not just typed). Every mock
  built on the shared engine (`createInMemoryEnvironmentAdapter`) honors
  the contract's own "never throw for an expected failure" discipline for
  `createObject`/`modifyObject`: a shape-invalid input (found during the P6
  audit — the engine originally let the schemas layer's validation
  exception escape as a rejected promise) now always comes back as
  `{status:"error", error:{kind:"invalid_operation"}}`; a `createObject`
  call whose id collides with an existing object comes back as
  `kind:"conflict"` rather than silently overwriting it; and a batch
  `modifyObject` call is all-or-nothing — one invalid key in the batch
  applies none of the changes, valid keys included.
- **Gemini / model provider integration** (P7) — `ModelProvider` (core) is
  the ONE way anything in this repo is allowed to talk to a large language
  model: `describe()` (sync, cannot fail) plus `generate(request):
  Promise<ModelInvocationResult>`, never a thrown exception for an expected
  failure (API unavailable, auth failure, timeout, rate limit, malformed
  output) — the identical discipline `EnvironmentAdapter` and `executeTool`
  already established. `packages/model-providers` supplies two
  implementations: `createMockModelProvider` (deterministic, network-free,
  configurable canned responses — the default test double for everything
  above it) and `createGeminiModelProvider` (the real `@google/genai`
  adapter; **implemented and unit-tested at the request/response-mapping
  level, but UNVERIFIED against the live API** — no `GEMINI_API_KEY` is
  configured in this environment, and this repository does not fake that
  verification). `runModelProviderContractTests` (core) is the reusable
  suite both run against today, meant to run against
  `createGeminiModelProvider` unmodified once credentials make that
  possible, mirroring `runEnvironmentAdapterContractTests`.

  A `ModelRequest` is built by `buildModelContext` (core) — a pure,
  deterministic, bounded projection of `WorldModelState` (project identity,
  objective, entity *counts*, session mode/focus — never full entity
  bodies) — plus `toModelToolDeclarations` (core), which projects
  registered `Tool`s into `ModelToolDeclaration`s using the tool's own
  `inputSchema` UNCHANGED. This is the whole answer to "one canonical
  schema, not four copies": `ToolValueSchema` (P3) is already a valid JSON
  Schema subset, so it is handed to Gemini's function-calling
  `parametersJsonSchema`/structured-output `responseJsonSchema` fields
  as-is (`packages/model-providers/src/schema-bridge.ts`) — no second,
  hand-maintained "Gemini schema" exists to drift from it.

  A model's turn is a typed `ModelResponse` (`text` /
  `structured_result` / `tool_call` / `clarification_request` / `error`,
  exactly the field matching `kind` populated, every other field null —
  validated, not merely typed). A `structured_result` is additionally
  checked with `validateStructuredResult` (core) against
  `ModelRequest.outputSchema` — JSON-safety alone does not prove a model's
  structured answer matches the shape NAQSH actually asked for, so both
  providers call this before returning `status: "success"`; a shape that's
  valid JSON but the wrong shape comes back as `schema_validation_failed`,
  never a silently-accepted mismatch. A `tool_call` response carries a
  `ModelToolCallIntent` — a name and JSON-safe arguments, structurally
  incapable of holding executable code, exactly like `Tool` never carries a
  handler. Gemini never receives a `ToolRegistry` or `WorldModelState`
  reference and never decides whether a call is authorized:
  `executeModelToolCall` (core) is the one sanctioned path from an intent
  to an actual invocation, and it does nothing but unpack the intent and
  hand it to the EXISTING `executeTool` boundary — the same input
  validation, the same `authorize` policy hook, the same handler. It also
  requires the originating `ModelRequest` and rejects any `toolName` that
  wasn't among the tools actually DECLARED to the model for that request —
  `executeTool` alone resolves names against the full registry, which can
  legitimately hold tools the model was never offered this turn, so this
  check runs first and short-circuits with `unknown_tool` before
  `authorize` is ever consulted. This is proven, not merely asserted:
  `execute-model-tool-call.test.ts` shows an unknown tool name, a real but
  UNDECLARED tool name, mismatched arguments, and a denying `authorize`
  hook all reject the call before any handler runs, and
  `repo-boundaries.test.ts` statically guards that no other file in core
  combines `executeTool` with `ModelToolCallIntent`.

  The Gemini adapter treats model output as hostile input throughout: more
  than one function call in a single turn is rejected outright
  (`unexpected_output`) rather than silently keeping only the first and
  discarding the rest; a function call with no name or non-object arguments
  is rejected as `tool_call_schema_failure`; and structured-output text
  that fails to parse as JSON is `malformed_response` — all via the
  previously-unused `ModelError` class (schemas), which now actually
  carries the precise `ModelErrorKind` through `mapGeminiResponseToModelResponseInput`
  instead of collapsing every failure into one generic bucket.
  `createGeminiModelProvider` retries a bounded number of times
  (`GeminiProviderConfig.maxRetries`, previously loaded from the
  environment but never consulted) — but only for classified-retryable
  failures (`rate_limit`/`timeout`/`api_unavailable`); an authentication
  failure or a malformed response is never retried, and the number of
  attempts made is always recorded in `ModelInvocationResult.metadata`.
  The provider's actual network call is injectable
  (`GeminiModelProviderDependencies.generateContent`, defaulting to the
  real SDK client), which is what makes this retry control flow directly
  testable without live credentials — before this, `generate()`'s
  orchestration had zero test coverage beyond its pure helper functions.


## What's intentionally not implemented yet

No real CAD MODIFICATION (create/modify/delete/checkpoint against FreeCAD
are all structurally present but capability-gated to
`unsupported_capability` — see the P12 section above), no full unrestricted
autonomy (P25's `BackgroundJob` is explicitly BOUNDED — see the P25 section
above — never "keep working forever"), no production authentication (the
`x-naqsh-user` header is an unsigned, client-supplied local-dev identity
stand-in — see `apps/api/src/auth.ts`'s own doc comment — never real auth),
no simulation engine, no FEA/CFD, no geometry generation.
**This paragraph is otherwise stale** and predates a later hardening pass:
a real approval UI exists today (`ProposalCard` for single proposals,
`ExplorationCard` for a background job's multi-tool approval checklist —
both wired to the real generic `/proposals/:id/approve|reject` and
`/projects/:id/approvals/:id/approve|reject` routes); real, disk-backed
persistence exists for everything a `ProjectRuntime` holds (approvals,
checkpoints, plans, proposals, background jobs, agent loop runs, etc. — see
`RuntimeStateRecord`/`JsonCollectionStore`, `apps/api/src/db/`), a deliberate
choice of a plain JSON-file store over a real SQL database (documented in
that file's own doc comment), not "no persistence" outright; and a real
Cloud Run deployment path exists (`apps/api/Dockerfile`, a documented
`gcloud run deploy` command in this repo's own top-level README) — though it
has never actually been deployed to a live GCP project from this sandbox
(no credentials here to do so). `ApprovalStore` and `AutonomyGrantStore`
ARE genuinely in-memory-only *within one process* (nothing about them is a
database), but that in-memory state is itself serialized into
`RuntimeStateRecord` and restored on restart — "in-memory only" and "never
survives a restart" are not the same claim, and only the first is still
true. The same is true of every `EnvironmentAdapter`'s (including
`FreeCadAdapter`'s own session tracking),
`ModelProvider`'s state. `AgentLoopRun` is the one exception to this
section's own "in-memory only" framing: a real `AgentLoopRunStore`
(`packages/core/src/agent-loop-run-store.ts`) now exists, is registered per
project in `ProjectRuntime`, and is persisted through the same
`RuntimeStateRecord` JSON-file mechanism every other per-project store
(`ApprovalStore`, `CheckpointStore`, etc.) already uses — added once
`executeProposal` began genuinely calling `resumeAgentLoopRunAfterApproval`
per execution (see the P11 section above) and needed somewhere real to keep
the resulting audit record, rather than constructing one and immediately
discarding it. The mock
adapters in `packages/adapters` remain the primary environment for unit
tests/CI/deterministic evaluation — P12 does not replace or weaken them;
they stay deliberately simplistic (no geometry kernel, no FEA/CFD, no real
persistence to disk). `FreeCadAdapter` proves the EXECUTE step can reach a
real environment, but deliberately does NOT reconcile an environment's
reported result back into `WorldModelState` — mapping an
`EnvironmentObjectId` to an `EngineeringObject.id` and interpreting raw
`EnvironmentProperty` data as World Model facts is real,
adapter-specific interpretation work (the environment↔World-Model
reconciliation `environment-types.ts`'s own P5 header names as "a later
phase's job"); P12 only proves the boundary is real, permission-gated, and
genuinely observes a real environment — it does not solve interpretation.
P11's agent loop is also deliberately
narrow in scope: it never chooses among multiple plan steps beyond a
simple, overridable "first pending step" default
(`selectFirstPendingPlanStep`) — prioritizing among candidate steps is a
planning concern, not this phase's; it never retries a failed/stale/
rejected run automatically — a new loop run is simply initiated again by
the caller; and `LoopDiscrepancy` detection is implemented only for
`target.entityType === "object"` (the only kind `modify_object`/
`modify_environment_object` can currently affect) — any other target
shape is honestly reported as "not checked," never guessed. Outside of
tests, nothing calls a `ModelProvider` for observation-adjacent reasoning,
planning, proposing, or the agent loop. `createGeminiModelProvider` has never
been called against the real Gemini API in this environment — no
`GEMINI_API_KEY` is configured, and none was faked; treat it as
implemented-and-typechecked, not verified-against-the-live-service, until
it has actually been run against one. P8's `observeProject` deliberately
does NOT do deep "what's actually relevant to this instruction" relevance
extraction (P8's `ModelContext`-style bounded summarization is limited to
counts/identifiers, same as P7's `buildModelContext`) — every entity within
a scope is included wholesale, never ranked or filtered by relevance, and
`ObservationResult.ambiguityIndicators` is always empty: genuine ambiguity
DETECTION is P19's job. `EntityRelationship` records are readable and
traversable (P8) but nothing yet CREATES one outside of tests or direct
`WorldModelState` construction — no tool, no Gemini path, and no UI writes
one; that's wiring for P9+ to add once there is a reason to assert a
specific relationship. No lint/formatter is configured — `strict`
TypeScript with `noUnusedLocals`/`noUnusedParameters` catches a meaningful
subset of what a linter would (verified during the P0–P4 foundation audit,
which found and fixed two real dead-import cases this way); style
enforcement beyond that is deferred.

