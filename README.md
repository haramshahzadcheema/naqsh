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
Change Model (`Change`, `ChangeCause`, `ChangeTarget`), and the Tool system's
contracts (`Tool`, `ToolValueSchema`, `ToolRequest`, `ToolResult`) — plus
their validators, factories, and serialization. `core` owns only behavior
built on top of that data: the `updateWorldModel` reducer and its transition
registry, `ChangeHistory` + `recordTransition` (the audited write path), and
`ToolRegistry` + `executeTool` (the controlled tool execution boundary).
Neither package knows about any specific environment (FreeCAD or otherwise),
Gemini, or a UI framework — those integrate through `packages/adapters` and
`apps/*` in later phases, never by reaching into `core`/`schemas`.

`packages/core/test/repo-boundaries.test.ts` enforces this direction as a
regression test, not just a convention — including a static check that the
tool system contains no `eval`, `Function` construction, or subprocess
execution.

## World Model, Change Model, and Tools

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
  function in a private closure — nothing outside the registry can obtain a
  raw handler reference. `executeTool` is the only sanctioned way to run one:
  validate input → policy seam (a hook, not an enforcement system — that's
  P4) → handler → validate output → a structured `ToolResult`, never a thrown
  exception for an expected failure mode. A mutating tool's handler returns
  transition-shaped *data*; the caller feeds that through the existing
  `recordTransition` pipeline, so a tool can never bypass the World Model or
  mutate hidden state.

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
