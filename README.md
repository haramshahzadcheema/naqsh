# NAQSH

NAQSH is an agentic engineering system. This repository starts with a small foundation that keeps the world model, tools, permissions, and environment adapters separated from the beginning.

Repository layout:

- `apps/web` for the future human-facing UI
- `apps/api` for application orchestration and API surface
- `packages/core` for core domain and orchestration primitives
- `packages/schemas` for shared typed contracts
- `packages/adapters` for environment-specific integrations

## Dependency direction

`packages/core` depends on `packages/schemas`. Never the reverse. `schemas`
owns every data contract — entities (`Project`, `Requirement`, `Constraint`,
`EngineeringObject`, `Decision`, `Experiment`, `Preference`, `SessionState`,
`WorldModelState`), the `WorldModelTransition` discriminated union, the
Change Model (`Change`, `ChangeCause`, `ChangeTarget`), the Tool system's
contracts (`Tool`, `ToolValueSchema`, `ToolRequest`, `ToolResult`), and the
Authorization Model's contracts (`AutonomyLevel`, `Approval`,
`AutonomyGrant`, `AuthorizationDecision`) — plus their validators,
factories, and serialization. `core` owns only behavior built on top of
that data: the `updateWorldModel` reducer and its transition registry,
`ChangeHistory` + `recordTransition` (the audited write path),
`ToolRegistry` + `executeTool` (the controlled tool execution boundary),
and `evaluateToolAuthorization` + `ApprovalStore` + `AutonomyGrantStore`
(the authorization decision layer). Neither package knows about any
specific environment (FreeCAD or otherwise), Gemini, or a UI framework —
those integrate through `packages/adapters` and `apps/*` in later phases,
never by reaching into `core`/`schemas`.

`packages/core/test/repo-boundaries.test.ts` enforces this direction as a
regression test, not just a convention — including a static check, scanned
across every `.ts` file in both `core/src` and `schemas/src`, that nothing
contains `eval`, `Function` construction, or subprocess/dynamic-import
execution.

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
  optional `expiresAt`/`maxUses`) and is revocable.

## What's intentionally not implemented yet

No Gemini, no FreeCAD, no real CAD operations, no autonomous agent loop, no
approval UI, no production authentication, no cloud services, no
persistence/database of any kind, no background jobs. `ApprovalStore` and
`AutonomyGrantStore` are in-memory only — nothing survives a process
restart. There is no orchestration loop that actually creates approvals,
grants autonomy, or wires `AuthorizationDecision`s into a persisted audit
trail; P4 provides the primitives those would be built from, not the
loop itself (that's P11). `AutonomyGrant`/`Approval` target-matching
picks the first covering match rather than the most specific one when
several overlap — correct for the single-match cases every current test
exercises, worth revisiting if overlapping scopes become common.

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
