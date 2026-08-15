# NAQSH

NAQSH is an agentic engineering system. This repository starts with a small foundation that keeps the world model, tools, permissions, environment adapters, and model providers separated from the beginning.

Repository layout:

- `apps/web` for the future human-facing UI
- `apps/api` for application orchestration and API surface — as of P8, a
  thin observation-service seam (`src/observation-service.ts`), not yet a
  running server
- `packages/core` for core domain and orchestration primitives
- `packages/schemas` for shared typed contracts
- `packages/adapters` for environment-specific integrations
- `packages/model-providers` for LLM-provider-specific integrations (Gemini, and a deterministic mock)

## Dependency direction

```
packages/schemas          (data contracts: entities, transitions, Change,
                            Tool, Authorization, Environment, Model — no
                            behavior)
      ↑
packages/core              (behavior over that data: the World Model
                            reducer, ChangeHistory, ToolRegistry/
                            executeTool, authorization evaluation, the
                            EnvironmentAdapter CONTRACT, and the
                            ModelProvider CONTRACT + reusable
                            contract-test suites for both — no environment
                            and no model provider knows which concrete one
                            it's talking to)
      ↑                           ↑
packages/adapters          packages/model-providers
(concrete EnvironmentAdapter (concrete ModelProvider implementations —
 implementations — mocks     a deterministic mock and the real Gemini
 today, FreeCADAdapter in    adapter, the ONLY place @google/genai is
 P12+)                       imported)
      ↑                           ↑
apps/web, apps/api          (future UI / API surface)
```

`packages/core` depends on `packages/schemas`; `packages/adapters` and
`packages/model-providers` each depend on both, and never on each other —
they are siblings, not layered on top of one another. Never the reverse in
any case. `schemas` owns every data contract — entities (`Project`,
`Requirement`, `Constraint`, `EngineeringObject`, `Decision`, `Experiment`,
`Preference`, `SessionState`, `WorldModelState`), the `WorldModelTransition`
discriminated union, the Change Model (`Change`, `ChangeCause`,
`ChangeTarget`), the Tool system's contracts (`Tool`, `ToolValueSchema`,
`ToolRequest`, `ToolResult`), the Authorization Model's contracts
(`AutonomyLevel`, `Approval`, `AutonomyGrant`, `AuthorizationDecision`), the
Environment Adapter's data contracts (`EnvironmentDescriptor`,
`EnvironmentSession`, `EnvironmentObject`, `EnvironmentOperationResult`,
...), and the Model Provider's data contracts (`ModelRequest`,
`ModelContext`, `ModelToolDeclaration`, `ModelResponse`,
`ModelInvocationResult`, ...) — plus their validators, factories, and
serialization. `core` owns behavior built on top of that data: the
`updateWorldModel` reducer and its transition registry, `ChangeHistory` +
`recordTransition` (the audited write path), `ToolRegistry` + `executeTool`
(the controlled tool execution boundary), `evaluateToolAuthorization` +
`ApprovalStore` + `AutonomyGrantStore` (the authorization decision layer),
the `EnvironmentAdapter` *interface* plus its reusable contract-test suite
(`runEnvironmentAdapterContractTests`), and the `ModelProvider` *interface*
plus its reusable contract-test suite (`runModelProviderContractTests`) —
core defines what an environment adapter or a model provider must do,
never a concrete one. `packages/adapters` and `packages/model-providers`
supply the first real implementations of those interfaces. No package
knows about a UI framework — that integrates in a later phase, never by
reaching into `core`/`schemas`/`adapters`/`model-providers`.

`packages/core/test/repo-boundaries.test.ts` enforces every arrow above as
a regression test, not just a convention — including a static check,
scanned across every `.ts` file in `core/src`, `schemas/src`,
`adapters/src`, and `model-providers/src`, that nothing contains `eval`,
`Function` construction, or subprocess/dynamic-import execution, and that
`@google/genai` never appears anywhere under `core/src`.

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
  unmodified in behavior and still has no idea autonomy levels exist.
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
  `createMockSimulationEnvironment`: `modify` only, fixed topology;
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

## Observation (P8)

**`WorldModelState` is the source of truth. `ObservationResult` is a
snapshot derived from it, never a second copy of it.** The only function
allowed to build one is `observeProject` (`packages/core/src/observe-project.ts`)
— a pure, deterministic function of its `WorldModelState` argument: no id
generation beyond the result's own envelope, no I/O, and critically no
import of `updateWorldModel`/`ChangeHistory`/`recordTransition` (enforced
as a repo-boundaries regression test) — observation cannot mutate the
World Model because it never holds a reference to anything that could.
Every entity array on an `ObservationResult` is an independent, deep
`structuredClone` of the corresponding `WorldModelState` data, then
recursively `Object.freeze`d — never the same live objects/arrays
`WorldModelState` holds. This is load-bearing, not defensive polish:
neither `Project`'s own arrays nor the P1 entity factories
(`createRequirement`, `createConstraint`, etc.) freeze their output, so
without an independent clone a caller doing
`result.requirements.push(...)` or `result.requirements[0].description =
"x"` would silently mutate the World Model itself. The same guarantee
holds for every individual query function in `observe-project.ts`
(`getRequirementById`, `getRelationshipsForEntity`, `getFocusedObjects`,
...), not just for a full `ObservationResult` — several of them are
consumed directly by `apps/api/src/observation-service.ts`, bypassing
`observeProject` entirely. The intended flow is:

```
WorldModelState -> observeProject() -> ObservationResult -> (later,
optionally) Gemini reasons OVER the result
```

never the reverse — nothing in `observe-project.ts` or
`observation-tool.ts` imports `@naqsh/model-providers`, `@google/genai`,
`@naqsh/adapters`, or an `EnvironmentAdapter` (all enforced as
repo-boundaries checks alongside the World-Model-write-path guard above).
Gemini can be handed an `ObservationResult` to reason over later; it can
never be the thing that constructs one.

**Scopes.** `observeProject(state, options)` supports three:
- `{scope: "project"}` (the default) — every requirement, constraint,
  object, decision, experiment, preference, and relationship. Unfiltered.
- `{scope: "focus"}` — only `SessionState.focusObjectIds`, plus whatever
  is directly connected to them via `EntityRelationship` (one hop). Lets a
  caller avoid loading the whole project into every prompt.
- `{scope: "object", objectId}` — exactly one named object plus its
  one-hop context. The narrowest scope.

Error handling is deliberately asymmetric between them:
`scope: "object"` names one entity explicitly, so a nonexistent id throws
`ObservationError("entity_not_found")` — the same "an explicit lookup that
misses is a hard failure" precedent `EnvironmentAdapter.inspectObject`
already set. `scope: "focus"` aggregates potentially many objects from
session state; one stale id there does NOT fail the whole observation (a
project can legitimately have a stale focus reference without being
"broken") — it is recorded in `ObservationResult.missingInformation`
instead, and the rest of the observation still succeeds. `scope:
"project"` never fails. `missingInformation` is populated by real,
deterministic structural checks only (an empty objective, zero
requirements, a stale focus id) — never fabricated, never guessed.
`ambiguityIndicators` is reserved and always empty in P8: genuine
ambiguity DETECTION is P19's job, not this one's.

**Relationships.** `EntityRelationship` (schemas) is a new, first-class,
queryable link between two World Model entities (e.g. "object obj_2
satisfies requirement req_1") — a NEW top-level `Project.relationships`
array, added the exact same way every other Change Model entity array was
(an `add_relationship`/`remove_relationship` transition pair in core's
registry, mirroring `add_requirement`/`remove_requirement`). This is
deliberately SEPARATE from `EngineeringObject.relationships` (P1, still
intentionally `unknown[]`): that field is reserved for CAD/domain-specific
structural facts an environment adapter reports (mates, joints, assembly
containment — P12+); `EntityRelationship` is NAQSH's own traceability
concept and never touches an `EnvironmentAdapter`. `EntityKind` (schemas)
is a new closed-but-additive union (`requirement`/`constraint`/`object`/
`decision`/`experiment`/`preference`) giving relationship source/target
real type safety, distinct from `ChangeTarget`'s deliberately open
`entityType: string` (which also has to cover non-repeatable concepts like
`project`/`session` that `EntityKind` does not). `getRelationshipsForEntity`/
`getRelatedEntityRefs`/`getRelatedEntitiesOfKind` (core) are the generic
traversal primitives; `getRequirementsForObject`/`getConstraintsForObject`/
`getDecisionsForObject`/`getExperimentsForRequirement` are thin, typed
convenience wrappers answering the exact questions the P8 brief names. A
dangling relationship reference (the target entity no longer exists) is
skipped gracefully during traversal, never thrown — the same "read-time
fact to tolerate" treatment as a stale focus id.

**The observation tool.** `createObservationTool(getState)`
(`packages/core/src/observation-tool.ts`) is the first agent-facing,
PRODUCTION `Tool` in this repository — every `Tool` before P8 existed only
as a test fixture. Registered and executed the normal way
(`registry.register(tool, handler)`, `executeTool`); classified
`mutation: "observe"`, `target: "world_model"` — the same classification
P4 authorization already gates on, with nothing special required to make
it permission-aware. `getState: () => WorldModelState` is an explicit
accessor, not a captured/global reference: this repository has no
singleton "current world model," and this tool does not introduce one.
Its `outputSchema` needed a `ToolValueSchema` feature that didn't exist
before P8 — `nullable: true` (`packages/schemas/src/types.ts`,
`tool-schema.ts`) — because `ObservationResult.scopeObjectId` is genuinely
`string | null` and `ToolValueSchema` has no `oneOf`/union support; purely
additive, every schema written before P8 is unaffected.

**API seam.** `apps/api/src/observation-service.ts` is the "expose the
necessary API/service boundary" seam the P8 brief asks for — four thin,
literal pass-throughs to `observeProject`/`getRelationshipsForEntity`/
`getRelatedEntityRefs` (whole-project, focused, single-object, and
relationship/context observation). Deliberately NOT a running HTTP
server: no route table, no framework choice, no port binding — standing
one up is not a P8 concern, and no later-numbered phase has claimed that
work yet either. What it IS: the exact functions a future HTTP handler
would call directly, already typed against `@naqsh/core`'s real
observation API, so wiring an actual server later is pure plumbing.

## Error model

Six error classes, one per layer, so a caller can branch on `.kind`
instead of string-matching a message: `WorldModelValidationError` (schemas)
for data-shape/domain-contract violations across P0–P2 — malformed
entities, unsupported transition kinds, out-of-order/mismatched-parent
Change appends. `ToolError` (P3) for the tool execution pipeline's own
outcomes — `invalid_input` / `unknown_tool` / `execution_failure` /
`invalid_output` / `policy_rejected` / `unavailable` /
`duplicate_registration`. `AuthorizationError` (P4) for
`ApprovalStore`/`AutonomyGrantStore` lifecycle violations —
`not_found` / `invalid_state_transition` — deliberately NOT `ToolError`,
since no tool execution is involved in e.g. approving an already-decided
approval. `EnvironmentError` (P5), available for an adapter implementation
to throw on a genuinely unexpected failure — `not_connected` /
`object_not_found` / `unsupported_capability` / `invalid_operation` /
`environment_failure` / `conflict` — but never used for an EXPECTED
failure; those are always a returned `EnvironmentOperationResult` with
`status: "error"`, same discipline as `ToolResult`. `ModelError` (P7),
available for a `ModelProvider` implementation to throw internally while
building a result — `api_unavailable` / `authentication_failure` /
`timeout` / `rate_limit` / `malformed_response` / `schema_validation_failed`
/ `unexpected_output` / `tool_call_schema_failure` / `provider_error` — but
`generate()` itself never rejects; every one of these becomes a returned
`ModelInvocationResult` with `status: "error"`. `ObservationError` (P8) —
`entity_not_found` / `invalid_scope` / `invalid_focus` — thrown by
`observeProject` for an invalid observation REQUEST (e.g. a `scope:
"object"` lookup naming an id that doesn't exist). Unlike
`EnvironmentError`/`ModelError` (internal, caught by their own boundary
before a caller ever sees them), `ObservationError` surfaces directly to a
caller of `observeProject` the same way a malformed `createX` call
surfaces `WorldModelValidationError` — the one place it IS caught and
converted into a structured result is the observation tool's `executeTool`
boundary, exactly like any other handler exception. Authorization
*denials*, environment operation *failures*, and model invocation
*failures* are all not exceptions at all in the expected case — see
`AuthorizationDecision.denialReason` (one of fourteen named values),
`EnvironmentOperationResult.error`, and `ModelInvocationResult.error`.

## What's intentionally not implemented yet

No FreeCAD, no real CAD operations, no autonomous agent loop, no approval
UI, no production authentication, no cloud services, no
persistence/database of any kind, no background jobs, no simulation
engine. `ApprovalStore` and `AutonomyGrantStore` are in-memory only —
nothing survives a process restart, and the same is true of every
`EnvironmentAdapter`'s and `ModelProvider`'s state. There is no
orchestration loop that actually creates approvals, grants autonomy, or
wires `AuthorizationDecision`s, `EnvironmentOperationResult`s, or
`ModelInvocationResult`s into a persisted audit trail; P4/P5/P7 provide the
primitives those would be built from, not the loop itself (that's P11).
The mock adapters in `packages/adapters` are deliberately simplistic —
proving the `EnvironmentAdapter` contract works, not simulating a real
CAD/simulation application; no geometry kernel, no FEA/CFD, no real
persistence to disk. `FreeCADAdapter` does not exist yet (P12–P14) —
nothing in `packages/adapters` imports FreeCAD, a Python runtime, or any
vendor SDK. There is no agent loop, no planner, and no proposal system
(P9–P11) — P7 only establishes the provider boundary, typed
request/response contracts, and the validation/permission-respecting path
from a tool-call intent to `executeTool`; nothing decides what to ask the
model, when, or what to do with a response, and nothing calls a
`ModelProvider` outside of tests. `createGeminiModelProvider` has never
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

## Configuration

`packages/model-providers/src/config.ts` is the ONE place environment
variables are read for Gemini — nowhere else in the repository touches
`process.env` for this. `loadGeminiConfigFromEnv()` reads:

- `GEMINI_API_KEY` — required; returns `null` (never throws, never fakes a
  config) if absent or empty
- `GEMINI_MODEL` — optional, defaults to `gemini-2.5-flash`
- `GEMINI_TIMEOUT_MS` — optional, defaults to `30000`
- `GEMINI_MAX_RETRIES` — optional, defaults to `2`

No API key is committed anywhere in this repository, and `.env`/`.env.*`
are gitignored. Nothing currently calls `loadGeminiConfigFromEnv()` except
its own tests — wiring a real provider into any running process is later
work.

## Tooling

TypeScript (`strict: true`) is authored directly and run via
[`tsx`](https://github.com/privatenumber/tsx) — no separate build step is
needed to run tests. Each package exposes:

- `npm run typecheck` — `tsc --noEmit`, the fast correctness gate
- `npm run build` — `tsc` with real emit to `dist/` (gitignored)
- `npm run test` — Node's built-in test runner (`node:test`), no test
  framework dependency

Run any of these from the repo root across every workspace, e.g.
`npm run test`.
