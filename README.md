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
 plus the real FreeCadAdapter adapter, the ONLY place @google/genai is
 (P12), a Python-runtime-    imported)
 backed subprocess boundary)
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

## Planning (P9)

**`WorldModelState` is what is currently known to be true about the
project. A `Plan` is what NAQSH PROPOSES should happen next. These are
never merged.** Generating a plan cannot add a requirement, add a
decision, modify an object, or mark anything complete — none of those are
things `packages/core/src/planner.ts` (or anything it calls) is even
capable of, because nothing in the planning files imports
`updateWorldModel`/`ChangeHistory`/`recordTransition`, an
`EnvironmentAdapter`, or a concrete `ModelProvider` implementation (all
enforced as repo-boundaries checks, mirroring P8's identical guards). The
flow is:

```
ObservationResult -> ModelRequest -> ModelProvider.generate() ->
structured output -> shape validation -> id remapping ->
semantic validation -> Plan
```

never `WorldModelState -> Plan` directly — `generatePlanProposal` takes an
already-built `ObservationResult` (P8), the same "observe first" boundary
P8 established for Gemini. Gemini's output is never automatically
authoritative: a `status: "success"` `ModelInvocationResult` only proves
the model's JSON matches `outputSchema`'s SHAPE (`validateStructuredResult`,
run inside the provider). `generatePlanProposal` adds two more layers
before anything is called a `Plan`: reassembling the shape into real,
schema-validated domain objects (`createPlan`/`createPlanStep`/... —
`assertPlan` and friends, which catch things `ToolValueSchema` can't
express, like "title must be non-empty"), and `validatePlanSemantics`
(`packages/core/src/plan-semantics.ts`) — the deterministic check that
catches a structurally-valid plan referencing a requirement/constraint/
object/decision id that doesn't exist in the observation it was built
from, a step dependency on an unknown step, a step that depends on itself,
or a dependency cycle (DFS over `dependsOn`, cycle-safe by construction —
no plan can hang generation). A plan that fails either layer is REJECTED
(`generatePlanProposal` resolves to `{status: "error", error: {kind, message}}`,
never throws for an expected failure), never silently repaired — a
hallucinated id is never dropped or guessed-at, it fails validation and
the whole plan is rejected.

**One `Plan` type, not a parallel "PlanProposal" schema.** The same design
`Approval` already uses (`status: "pending" -> "approved"`, one type, not
two): a freshly generated plan is simply a `Plan` with `status:
"proposed"`. `PlanStatus` (`draft` / `proposed` / `approved` / `executing`
/ `completed` / `rejected` / `superseded`) and `PlanStepStatus` (`pending`
/ `in_progress` / `complete` / `blocked` / `skipped`) both define their
FULL future-compatible range now — `generatePlanProposal` only ever
produces `"proposed"`/`"pending"`. Nothing decides what to do with a
proposed plan (approve it, execute it, mark a step complete) — that is
explicitly P10 (concrete modification proposals) and P11 (the
observe/reason/propose/approve/execute loop)'s job, not this phase's.
`Plan.supersedesPlanId`/`version` exist so a future revision mechanism has
somewhere to record "this plan replaces that one" without a breaking
schema change; P9 itself never sets `supersedesPlanId` to anything but
`null`.

**Known vs. assumed vs. unknown vs. proposed — never collapsed into one
bucket.** A plan step's `relevantRequirementIds`/`relevantConstraintIds`/
`relevantObjectIds`/`relevantDecisionIds` are the KNOWN category made
concrete: real ids copied from the `ObservationResult`, checked against it
by `validatePlanSemantics` — never free text ("based on what we discussed
earlier..."). `Plan.assumptions` (each with an `id`/`description`/
`rationale`) is the ASSUMED category: something the plan treats as true
FOR PLANNING PURPOSES without it being a confirmed project fact — recorded
once at the plan level and referenced by `PlanStep.assumptionIds`, not
copy-pasted per step. `Plan.missingInformation` (seeded from the source
observation's own list, so a gap the World Model already knew about is
never silently dropped, plus whatever the model additionally identifies)
and `Plan.unresolvedQuestions` are the UNKNOWN category: real, structural
gaps and open questions, never fabricated. The PLAN ITSELF — every step —
is the PROPOSED category: intended engineering work NAQSH suggests, not
something already decided or already true. The system prompt sent to the
model (`PLANNING_SYSTEM_INSTRUCTION`, `planner.ts`) states these rules
explicitly, but the actual enforcement is `validatePlanSemantics`, not the
model's good behavior.

**Dependencies are a graph, not just a number.** `PlanStep.dependsOn` (a
list of other step ids in the same plan) is the AUTHORITATIVE dependency
signal; `PlanStep.order` is a display/sequencing hint only, so a future
execution loop can eventually run independent steps in parallel instead of
being forced into one linear sequence. The model assigns its own local
step/assumption id labels (e.g. `"step-1"`); `generatePlanProposal`
remaps every one of them to NAQSH's canonical `createId` format before
constructing the `Plan`, rewriting every `dependsOn`/`assumptionRefs`
reference to match. A reference that doesn't resolve to one of the
model's OWN declared ids is passed through UNCHANGED rather than silently
dropped — dropping it would be exactly the "silently repair fabricated
model output" the P9 brief forbids; left unresolved, it correctly fails
`validatePlanSemantics`'s `unknown_dependency`/`unknown_assumption_reference`
check instead.

**The planning tool.** `createPlanningTool(getState, provider)`
(`packages/core/src/plan-tool.ts`) is the second agent-facing, PRODUCTION
`Tool` in this repository (after P8's `observe_project`). Registered and
executed the normal way; classified `mutation: "suggest"` — the tier
`AutonomyLevel`'s own doc comment defines as "may also reason/propose
(still zero mutation)" — `target: "world_model"`, matching
`observe_project`'s target since planning reasons about World Model data.
Its handler calls `observeProject` (read) then `generatePlanProposal`
(pure orchestration over the injected `ModelProvider`) — nothing else. A
`PlanGenerationResult` error is mapped onto `ToolError`
(`invalid_input`/`unavailable`/`execution_failure`, by kind), the same
"never let an internal error class leak past the tool boundary" discipline
`observation-tool.ts` established for `ObservationError`.

**Inspection.** `packages/core/src/plan-query.ts` provides deterministic,
read-only query helpers over an already-generated `Plan` —
`getPlanSummary`/`getPlanStepById`/`getStepDependencies`/
`getStepDependents`. Unlike `observe-project.ts`'s query functions, none
of these need a defensive clone-and-freeze step: `createPlan` already
deep-freezes every `Plan` it returns, so there is no live, World-Model-style
mutable reference to guard against here.

**API seam.** `apps/api/src/plan-service.ts` mirrors
`observation-service.ts`'s exact shape: `generateWholeProjectPlan`/
`generateFocusedPlan`/`generateObjectPlan` (thin pass-throughs composing
`observeProject` + `generatePlanProposal`) and
`inspectPlanSummary`/`inspectPlanStep`/`inspectStepDependencies` (thin
pass-throughs to `plan-query.ts`). Deliberately NOT a running HTTP server,
for the same reason P8's service isn't one.

**Empty and existing-model projects both work.** Planning does not require
any `EngineeringObject` to already exist — a from-scratch project
(`objects: []`) produces a legitimate plan (e.g. clarify requirements,
select material, draft geometry), and an existing-model project's plan can
reference real objects/decisions already in the observation. Neither path
is special-cased in `planner.ts`; both are exercised in
`planner.test.ts`.

## Proposals (P10)

**PLAN is what NAQSH proposes should happen, at the level of a step. A
`Proposal` is the concrete, single tool call that would realize one such
step — the boundary between INTENT and REALITY, drawn one layer more
precisely than P9's own World-Model-vs-Plan boundary.** The pipeline:

```
PLAN -> PLAN STEP -> PROPOSAL -> (later, P11) HUMAN APPROVAL -> EXECUTION
```

P10 implements only `PLAN STEP -> PROPOSAL`. There is no
`approveProposal`, no `rejectProposal`, no `executeProposal` function
anywhere in this repository, and no `execute_proposal` tool — all
structurally guarded by `repo-boundaries.test.ts`'s P10 block, not merely
by convention. `Proposal.status` defines its full future lifecycle
(`proposed` / `approved` / `rejected` / `executed` / `superseded`, the
identical "define the whole enum, only produce a subset now" convention
`Plan.status` already established) but P10 code only ever produces
`"proposed"`.

**A `Proposal` is "a specific `Tool` (P3) call NAQSH proposes making, and
why" — not a bespoke action vocabulary reinvented from scratch.**
`toolName`/`input` mirror `ToolRequest`'s own shape exactly: the precise
`{name, arguments}` pair that WOULD be handed to `executeTool` if this
proposal is ever approved. This is what keeps the abstraction genuinely
environment-independent, the explicit P10 requirement: a CAD parameter
edit, a new CAD object, a simulation setup, or a manufacturing operation
are all just "a call to some registered `Tool`" — P3's `Tool` system
already IS the generic vocabulary for "an action NAQSH can take," so a
`Proposal` is a proposed instance of exactly that. `target` reuses
`ChangeTarget` (P2) — the identical generic "what this acts on" reference
`Change` already uses for an APPLIED transition, now describing one that
hasn't applied. `target: null`/`target.entityId: null` is how a proposal
that would CREATE something new (no id exists yet) is represented — this
is what makes P10 work for a from-scratch project (`objects: []`)
without a special case: `packages/core/test/proposal-generator.test.ts`
exercises exactly this.

**Two validation layers, mirroring P9's exact discipline.** `createProposal`
(`packages/schemas/src/factories.ts`) + `assertProposal` enforce SHAPE —
every field present, correctly typed, `input`/`metadata` JSON-safe,
`rationale`/`expectedEffect` genuinely non-empty (an unexplained proposal
defeats the entire point of proposing instead of just acting).
`validateProposalSemantics` (`packages/core/src/proposal-semantics.ts`)
then enforces MEANING: the proposal's `planId`/`projectId` actually match
its stated plan, `planStepId` actually names a real step in that plan,
`relevantRequirementIds`/`relevantConstraintIds` are a SUBSET of what that
plan step itself already cited (a proposal may narrow, never invent, a new
one its plan step never vetted), a non-null `target.entityId` was likewise
already cited by the plan step (when its `entityType` is one `PlanStep`
tracks relevance for — `object`/`requirement`/`constraint`/`decision`;
other `entityType`s, e.g. a future environment-specific resource kind, are
left unchecked here rather than rejected, since `ChangeTarget.entityType`
is deliberately open-ended), and — when a `ToolRegistry` is supplied —
`toolName` actually names a registered tool AND `input` actually matches
that tool's own `inputSchema`. A proposal failing either layer is
REJECTED, never silently repaired — a hallucinated tool name or a
parameter shape that wouldn't validate against the real tool's schema is
never allowed to become a "successful" proposal.

**`generateProposal`** (`packages/core/src/proposal-generator.ts`) is the
P10 analogue of P9's `generatePlanProposal`: `Plan` + a `PlanStep.id` +
a `ToolRegistry` (read-only — only `getByName`/`list`, never dispatch) +
a `ModelProvider` -> `ProposalGenerationResult`
(`{status:"success", proposal}` or `{status:"error", error:{kind,
message}}`, never throwing for an expected failure). The model is shown
the plan step's own content plus a text summary of every registered
tool's name/description/`inputSchema` (embedded in the instruction, not
`ModelRequest.tools` — declaring `tools` alongside `outputSchema` would
risk the model making an actual function-call turn instead of describing
one) and asked to propose exactly one concrete call. `toolTarget` is
never trusted from the model — it is DERIVED from the real registered
`Tool.target` once `toolName` is confirmed to exist, the same "don't ask
the model to restate what the application already knows authoritatively"
discipline applied one field further than P9 needed to.

**The proposal tool.** `createProposalTool(registry, provider)`
(`packages/core/src/proposal-tool.ts`) is the third agent-facing,
PRODUCTION `Tool` (after P8's `observe_project` and P9's `create_plan`),
classified `mutation: "suggest"` — the identical tier `create_plan` uses,
verified end-to-end against the real P4 authorization engine (not just a
static assertion) in `proposal-tool.test.ts`: allowed at autonomy level
`"suggest"` or above with no `Approval`/`AutonomyGrant` needed, denied at
`"observe"`. Unlike `create_plan`, this tool takes no `getState` — a
`Proposal` is realized from an already-generated `Plan` VALUE the caller
supplies directly (there is still no `PlanStore`; see P9's own note on
this deferral), not from live `WorldModelState`. Its handler calls only
`generateProposal` — never `executeTool`, never `invokeRegisteredTool` —
confirmed by a dedicated regression test that registers a real
`modify_object` tool with a call-tracking handler and asserts it is NEVER
invoked by creating a proposal that names it.

**API seam.** `apps/api/src/proposal-service.ts` mirrors
`plan-service.ts`'s exact shape: one thin pass-through,
`generatePlanStepProposal`, composing nothing beyond `generateProposal`
itself.

## Controlled Agent Loop (P11)

**The first complete controlled agent loop:**

```
OBSERVE -> REASON -> PROPOSE -> APPROVAL -> EXECUTE -> OBSERVE
```

P11 does not reimplement any of these stages — OBSERVE is P8's
`observeProject`, REASON is P9's `generatePlanProposal`, and PROPOSE is
P10's `generateProposal`, all used exactly as those phases built them.
What P11 adds is genuinely new: an APPROVAL gate tied to the exact
proposal it authorizes, a real EXECUTE step that runs an approved
proposal through the SAME `executeTool` boundary every other tool call
in this repository goes through, and a second, post-execution OBSERVE
that becomes the basis for what the loop reports — never the model's own
claim of what it did.

**Two entry points, not one giant function**
(`packages/core/src/agent-loop.ts`), because human approval is genuinely
asynchronous:

- `beginAgentLoopRun` — OBSERVE -> REASON -> PROPOSE -> (request) APPROVAL,
  then stops. Returns an `AgentLoopRun` (below) with status
  `"awaiting_approval"`, or an earlier failure status if any stage
  couldn't produce something valid.
- `resumeAgentLoopRunAfterApproval` — called only after a human (or a
  future policy) has decided the requested `Approval` via the same
  `ApprovalStore` P4 already provides. Re-reads that decision itself
  (never trusts the run's own, necessarily-stale snapshot), then
  EXECUTE -> OBSERVE.

**The critical invariant: NO APPROVAL -> NO MUTATION.**
`resumeAgentLoopRunAfterApproval` never calls `executeTool` unless (a) the
run is genuinely `"awaiting_approval"`, (b) the CURRENT state of the
referenced `Approval` — re-read from the store — is `"approved"`, (c)
that approval's own `proposalId` matches this exact proposal (a new P11
field on `Approval`, additive, defaults `null`; toolName+target alone
cannot distinguish two different proposals that happen to name the same
tool and target), and (d) the proposal's `projectVersion` still matches
the CURRENT World Model version (staleness). Any one of these failing
routes to a terminal, non-executing status (`"rejected"`/`"stale"`)
before `executeTool` is ever reached.

**`modify_object`** (`packages/core/src/modify-object-tool.ts`) is this
repository's FIRST real `mutation: "mutate"` tool — every tool registered
before P11 (`observe_project`, `create_plan`, `create_proposal`) is
`"observe"`/`"suggest"`. Its handler calls `recordTransition` (never a
bare `updateWorldModel`), so every successful call produces a real,
auditable `Change` (P2) — there is no second, unaudited write path. It
closes a genuine P1–P10 gap: `EngineeringObject` was creatable
(`add_object`) but had no update transition, unlike every other core
entity (`update_requirement`). The new `update_object`
`WorldModelTransition` (`propertyKey`/`value`, matching the exact
`modify_object` input shape P10's own test fixtures had already
established) mirrors `update_requirement` exactly.

**`modify_environment_object`**
(`packages/core/src/modify-environment-object-tool.ts`) proves a
proposal can equally target a real `EnvironmentAdapter` (P5/P6), not only
the World Model — a thin, generic wrapper around
`EnvironmentAdapter.modifyObject`, callable against the mock CAD
environment today and, unchanged, against a real `FreeCADAdapter` once
P12 exists. It deliberately does NOT reconcile the environment's result
back into `WorldModelState` — mapping an `EnvironmentObjectId` to an
`EngineeringObject.id` and interpreting raw `EnvironmentProperty` data as
World Model facts is real, adapter-specific interpretation work
(`environment-types.ts`'s own header names this as a later phase's job);
attempting it generically here would mean guessing. This tool proves the
EXECUTE step can legitimately reach a real environment through the same
typed/permission boundary every other tool goes through; full
environment↔World-Model reconciliation remains explicitly deferred (see
below).

**`AgentLoopRun`** (`packages/schemas/src/agent-loop-types.ts`) is the
complete, traceable audit record — P11's "CHANGE / AUDIT RECORD"
requirement made concrete, the same relationship `Change` has to a
`WorldModelTransition` applied to a whole loop pass. It embeds the REAL
value each stage produced (an actual `ObservationResult`/`Plan`/
`Proposal`/`Approval`/`ExecutionResult`, never just an id) — there is no
`ObservationStore`/`PlanStore`/`ProposalStore` a reference could
resolve against later (none exist yet, by deliberate P9/P10 design), so
an id-only reference would be unresolvable the moment the value outlives
its creating call. A reviewer can reconstruct the entire loop — what was
observed, what objective was pursued, what was reasoned about, what was
proposed and why, what approval was requested and by whom it was
decided, what exactly executed, what the environment/World Model
reported, and what the post-execution observation showed — from this one
value.

**"COMMAND SUCCEEDED != OBJECTIVE SATISFIED"** is enforced structurally,
not aspirationally: `LoopDiscrepancy` (part of `AgentLoopRun`) is computed
by comparing the proposal's declared target entity between the pre- and
post-execution `ObservationResult`s — never by re-interpreting
`Proposal.expectedEffect` prose. A tool that reports `status: "success"`
while genuinely changing nothing is caught this way, exercised directly
in `packages/core/test/agent-loop.test.ts`'s CASE F.

**`ExecutionResult.outcome`** is deliberately narrower than the P11
brief's full illustrative list: `"succeeded" | "failed" | "rejected" |
"stale"`, omitting `"requested"/"approved"/"started"` (already
represented by `AgentLoopRun.status`'s own progression, so recording them
again on `ExecutionResult` would be a second, driftable copy of the same
axis) and `"partially_completed"` (this architecture's execution
primitive — one `executeTool` call — is atomic by construction; a
`ToolResult` is always wholly success or wholly error, so that value
could never be genuinely reachable, and adding it would be exactly the
kind of fabricated, unreachable status `ObservationResult.
missingInformation`'s own precedent forbids).

**API seam.** `apps/api/src/agent-loop-service.ts` mirrors every prior
phase's service file exactly: two thin pass-throughs
(`startAgentLoopRun`/`continueAgentLoopRun`), composing nothing beyond
`beginAgentLoopRun`/`resumeAgentLoopRunAfterApproval` themselves.

## FreeCAD Adapter (P12)

**The first real (non-mock) `EnvironmentAdapter` implementation** —
`packages/adapters/src/freecad-adapter.ts` — proving `WorldModelState`,
the Change Model, Tools, Authorization, Observation, Planning, Proposals,
and the P11 agent loop all work unmodified against a genuine external CAD
environment, not just an in-memory stand-in. FreeCAD is the FIRST
environment, never the architecture: nothing about `createFreeCadAdapter`
is visible anywhere above the `EnvironmentAdapter` interface (P5) — the
same generic contract `createMockCadEnvironment`/`createMockSimulationEnvironment`/
`createMockEnvironment` already satisfy.

**Runtime boundary.** FreeCAD's automation API is Python-only with no
Node.js binding, so `packages/adapters/freecad/` is a small, isolated
Python runtime: `runner.py` dispatches to a fixed, named table of
operations (`health`/`connect`/`list_objects`/`inspect_object`/`save`) and
is invoked as a ONE-SHOT `freecadcmd` subprocess per call —
`packages/adapters/src/freecad-runtime.ts` is the ONLY file in the entire
repository allowed to import `node:child_process` (enforced structurally
in `repo-boundaries.test.ts`'s P12 guard block). There is no persistent
FreeCAD process and no cross-call FreeCAD-side session state; each
operation opens the target `.FCStd` document fresh, does exactly one
thing, and closes it again. See `packages/adapters/freecad/README.md` for
the full protocol, the two FreeCAD invocation quirks that shape it
(argv indexing, `__name__` under `freecadcmd`), and the tradeoff this
design deliberately makes (per-call FreeCAD startup latency, in exchange
for a crash-safe design with no state to desync).

**Scope.** `capabilities` is exactly `["save"]` — inspection (document
discovery, object enumeration, property/relationship reading) and a real
document save, nothing else. `create`/`modify`/`delete`/`checkpoint` are
real, present `EnvironmentAdapter` methods (the interface requires them
unconditionally) but every one returns `unsupported_capability` in this
phase — no CAD manipulation, no fabricated rollback capability. FreeCAD
properties are normalized into a controlled, bounded, JSON-safe
representation (`runner.py`'s `normalize_value`) — a `Quantity` becomes
`{value, unit}`, a `Placement` becomes `{position, angle}`, and anything
unconvertible (a `TopoShape`/`Solid`, a `Material`, ...) becomes an
explicit `{unsupported: true, pythonType: ...}` marker rather than a
crash or a silently-dropped field. Relationships are exposed only from
FreeCAD's own `OutList` (real dependency links it already tracks) — never
fabricated.

**Security.** `runner.py` has no `eval`/`exec` on request data anywhere,
no operation that accepts caller-supplied code, and no generic "run this
Python" primitive — adding a capability means adding a named function to
its fixed `OPERATIONS` table. Gemini never gets anywhere near FreeCAD:
nothing in the P7 model-provider boundary or the P11 agent loop holds a
`freecad-runtime.ts` reference: the only path to FreeCAD is
`EnvironmentAdapter` → a registered `Tool` → `executeTool`'s
permission-checked boundary, identical to every other environment-target
tool.

**Testing.** Two levels, both under `packages/adapters/test/`:
`freecad-adapter.test.ts` (LEVEL 1) is fully deterministic and requires no
FreeCAD install — `FreeCadAdapter`'s injectable `runOperation` option
replaces the subprocess call with a fake, so every branch of the adapter
logic is exercised without spawning a process; it also runs the exact
same reusable `runEnvironmentAdapterContractTests` suite (P5) the mock
adapters use. `freecad-adapter.integration.test.ts` (LEVEL 2) runs
against a REAL FreeCAD install (resolved via `NAQSH_FREECAD_CMD`, or
`freecadcmd` on `PATH`) — when unavailable, every test in the file is
registered `{ skip: <reason> }` and reported as **skipped**, never
failed; `npm test` exits `0` either way. Both are wired into
`packages/adapters/package.json`'s `test` script and run as part of the
normal test suite.

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
`EnvironmentOperationResult.error`, and `ModelInvocationResult.error`. Plan
generation (P9) follows the same "not an exception" discipline rather than
adding a seventh throwable class: `generatePlanProposal` resolves to
`PlanGenerationResult`, `{status: "error", error: {kind, message}}` for
every expected failure — `invalid_input` / `model_unavailable` /
`invalid_model_output` / `malformed_plan_shape` /
`semantic_validation_failed` (`PlanGenerationErrorKind`). `generateProposal`
(P10) follows the identical shape one level down the pipeline —
`ProposalGenerationResult`, the same five `kind` values
(`ProposalGenerationErrorKind`), `"invalid_input"` additionally covering a
`planStepId` that doesn't name a real step in the given plan.

## What's intentionally not implemented yet

No real CAD MODIFICATION (create/modify/delete/checkpoint against FreeCAD
are all structurally present but capability-gated to
`unsupported_capability` — see the P12 section above), no full autonomous
engineering, no approval UI, no production authentication, no cloud
services, no persistence/database of any kind, no background jobs, no
simulation engine, no FEA/CFD, no geometry generation. `ApprovalStore` and
`AutonomyGrantStore` are in-memory only — nothing survives a process
restart, and the same is true of every `EnvironmentAdapter`'s (including
`FreeCadAdapter`'s own session tracking), `ModelProvider`'s, and
`AgentLoopRun`'s state (no `AgentLoopRunStore` exists either — a caller
holds the value `beginAgentLoopRun`/`resumeAgentLoopRunAfterApproval`
returns, matching `ApprovalStore`/`AutonomyGrantStore`/the absent
`PlanStore`/`ProposalStore`'s own in-memory-only precedent). The mock
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

`NAQSH_FREECAD_CMD` (optional) — read directly by
`createFreeCadAdapter` (`packages/adapters/src/freecad-adapter.ts`), not
through `config.ts` (that file is Gemini-specific): the path to FreeCAD's
headless CLI (`freecadcmd`/`freecadcmd.exe`). Falls back to the bare
`freecadcmd` command resolved via `PATH` when unset. Also read by
`packages/adapters/test/freecad-adapter.integration.test.ts` to decide
whether to run the real-FreeCAD test suite or skip it. Never required —
every other test and every mock adapter works with no FreeCAD install at
all.

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
