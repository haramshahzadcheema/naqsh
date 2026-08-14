# NAQSH

NAQSH is an agentic engineering system. This repository starts with a small foundation that keeps the world model, tools, permissions, and environment adapters separated from the beginning.

Repository layout:

- `apps/web` for the future human-facing UI
- `apps/api` for application orchestration and API surface
- `packages/core` for core domain and orchestration primitives
- `packages/schemas` for shared typed contracts
- `packages/adapters` for environment-specific integrations

## Dependency direction

```
packages/schemas   (data contracts: entities, transitions, Change, Tool,
                     Authorization, Environment — no behavior)
      ↑
packages/core       (behavior over that data: the World Model reducer,
                     ChangeHistory, ToolRegistry/executeTool, authorization
                     evaluation, and the EnvironmentAdapter CONTRACT +
                     reusable contract-test suite — no environment knows
                     which one it's talking to)
      ↑
packages/adapters   (concrete EnvironmentAdapter implementations — mocks
                     today, FreeCADAdapter in P12+ — never imported BY
                     core/schemas, only importing FROM them)
      ↑
apps/web, apps/api  (future UI / API surface)
```

`packages/core` depends on `packages/schemas`; `packages/adapters` depends
on both. Never the reverse in either case. `schemas` owns every data
contract — entities (`Project`, `Requirement`, `Constraint`,
`EngineeringObject`, `Decision`, `Experiment`, `Preference`, `SessionState`,
`WorldModelState`), the `WorldModelTransition` discriminated union, the
Change Model (`Change`, `ChangeCause`, `ChangeTarget`), the Tool system's
contracts (`Tool`, `ToolValueSchema`, `ToolRequest`, `ToolResult`), the
Authorization Model's contracts (`AutonomyLevel`, `Approval`,
`AutonomyGrant`, `AuthorizationDecision`), and the Environment Adapter's
data contracts (`EnvironmentDescriptor`, `EnvironmentSession`,
`EnvironmentObject`, `EnvironmentOperationResult`, ...) — plus their
validators, factories, and serialization. `core` owns behavior built on
top of that data: the `updateWorldModel` reducer and its transition
registry, `ChangeHistory` + `recordTransition` (the audited write path),
`ToolRegistry` + `executeTool` (the controlled tool execution boundary),
`evaluateToolAuthorization` + `ApprovalStore` + `AutonomyGrantStore` (the
authorization decision layer), and the `EnvironmentAdapter` *interface*
plus its reusable contract-test suite (`runEnvironmentAdapterContractTests`)
— core defines what an environment adapter must do, never a concrete one.
`packages/adapters` supplies the first real implementations of that
interface (currently two deterministic mocks; see below). No package
knows about Gemini or a UI framework — those integrate in later phases,
never by reaching into `core`/`schemas`/`adapters`.

`packages/core/test/repo-boundaries.test.ts` enforces every arrow above as
a regression test, not just a convention — including a static check,
scanned across every `.ts` file in `core/src`, `schemas/src`, and
`adapters/src`, that nothing contains `eval`, `Function` construction, or
subprocess/dynamic-import execution.

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

## Error model

Four error classes, one per layer, so a caller can branch on `.kind`
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
`status: "error"`, same discipline as `ToolResult`. Authorization
*denials* and environment operation *failures* are both not exceptions at
all in the expected case — see `AuthorizationDecision.denialReason` (one
of fourteen named values) and `EnvironmentOperationResult.error`.

## What's intentionally not implemented yet

No Gemini, no FreeCAD, no real CAD operations, no autonomous agent loop, no
approval UI, no production authentication, no cloud services, no
persistence/database of any kind, no background jobs, no simulation
engine. `ApprovalStore` and `AutonomyGrantStore` are in-memory only —
nothing survives a process restart, and the same is true of every
`EnvironmentAdapter`'s state. There is no orchestration loop that actually
creates approvals, grants autonomy, or wires `AuthorizationDecision`s or
`EnvironmentOperationResult`s into a persisted audit trail; P4/P5 provide
the primitives those would be built from, not the loop itself (that's
P11). The mock adapters in `packages/adapters` are deliberately
simplistic — proving the `EnvironmentAdapter` contract works, not
simulating a real CAD/simulation application; no geometry kernel, no
FEA/CFD, no real persistence to disk. `FreeCADAdapter` does not exist yet
(P12–P14) — nothing in `packages/adapters` imports FreeCAD, a Python
runtime, or any vendor SDK. There is no agent, no tool that calls an
adapter, and no Gemini structured tool calling (P7) — P6 only proves the
environment side of that future chain works in isolation. No
lint/formatter is configured — `strict`
TypeScript with `noUnusedLocals`/`noUnusedParameters` catches a meaningful
subset of what a linter would (verified during the P0–P4 foundation audit,
which found and fixed two real dead-import cases this way); style
enforcement beyond that is deferred.

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
