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
owns every entity type, validator, and factory (`Project`, `Requirement`,
`Constraint`, `EngineeringObject`, `Decision`, `Experiment`, `Preference`,
`SessionState`, `WorldModelState`) — the shared contracts other packages
build on. `core` owns only the orchestration layer on top: a typed,
discriminated-union `WorldModelTransition` and the `updateWorldModel` pure
reducer that applies one to a `WorldModelState`. Neither package knows about
any specific environment (FreeCAD or otherwise), Gemini, or a UI framework —
those integrate through `packages/adapters` and `apps/*` in later phases,
never by reaching into `core`/`schemas`.

`packages/core/test/repo-boundaries.test.ts` enforces this direction as a
regression test, not just a convention.

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
