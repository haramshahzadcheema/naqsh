# NAQSH

**An agent you can let near your actual files.**

Naqsh takes an engineering goal in plain English and turns it into real
geometry in a real CAD document — a genuine FreeCAD `.FCStd` on disk, not
a description of one, not a picture of one.

The hard part of an agent that edits real work isn't getting it to act.
It's making the acting *trustworthy*. So every mutation in Naqsh goes
through the same path, and none of it depends on the model behaving:

- **It cannot act without approval.** Authorization is re-checked at
  execution time against a real `Approval` record, independently of
  whatever the model claimed it was doing.
- **It checkpoints before it writes.** Every approved change snapshots the
  live document first, so anything can be undone.
- **It can only do a closed set of things.** The FreeCAD boundary is an
  explicit allowlist — four shape types, bounded dimensions, placement,
  booleans, fillets. There is no `eval`, no arbitrary property write, no
  generic execution path. A test greps the source to prove it.
- **It verifies with code, not vibes.** Results are re-measured off the
  real geometry and compared numerically. The model never grades its own
  homework.

That restraint *is* the feature. An agent that can quietly do anything to
your files is not one you'd actually give a CAD document to.

📹 **[Demo video](https://www.youtube.com/watch?v=uQXj_l76ppc)**

## Quickstart

**Judging this?** See **[JUDGES.md](JUDGES.md)** — a 2-minute walkthrough that needs no API key at all.

**Looking for a hosted URL?** There isn't one, and **[DEPLOYMENT.md](DEPLOYMENT.md)** says exactly why: the two-service Cloud Run pipeline is complete and reviewable in this repo, but running it requires a billing account, and creating one places a hold on a payment card we were not willing to place.

```bash
npm install
npm run dev
```

That's the whole thing: the root `dev` script runs the real API server (`apps/api`, Express, port 3001) and the real web frontend (`apps/web`, Vite, port 5173) together. Open **http://localhost:5173**.

Optional environment variables (see `apps/api/src/start.ts` / `packages/model-providers/src/config.ts`):

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | Enables real Gemini calls. Without it, every AI action honestly reports "Gemini isn't configured," never a fake reply. | unset |
| `GEMINI_MODEL` | Overrides the default model id. | `gemini-3.5-flash` |
| `PORT` | API server port. | `3001` |
| `NAQSH_DATA_DIR` | Where project/file state persists as JSON on disk. | `apps/api/data` |
| `NAQSH_FREECAD_CMD` | Path to a real `freecadcmd` binary, for the one live CAD integration. | auto-discovered |

Run everything's tests: `npm test`. Typecheck everything: `npm run typecheck`. Build everything: `npm run build`.

## For judges: a five-minute tour

1. `npm install && npm run dev`, open http://localhost:5173. Without a `GEMINI_API_KEY`, every AI surface honestly reports Gemini is unconfigured — nothing fabricates a reply. The **Deterministic (testing)** model exercises the full mechanical loop offline.
2. Create a project, describe an engineering goal ("a bracket that holds 2 kg, aluminum, 100×60×20 mm"), and watch requirements land as structured state under the **Requirements** tab — not chat text.
3. Say "make the bracket lighter" (natural phrasing works — no magic commands): a real Plan and a concrete tool-level Proposal appear. **Nothing executes without your approval**, and an unapproved execution fails honestly on screen.
4. Approve → the change runs through the one authorized tool path, gets a before/after discrepancy diff, and a **deterministic verification** (numeric comparison code, never the model grading itself).
5. Kill the server and restart it — projects, memory, approvals, and history all survive (JSON persistence under `NAQSH_DATA_DIR`), and interrupted background jobs are honestly marked failed rather than left "running" forever.

Where the trust boundaries live, if you want to read the enforcement rather than take our word: [execute-tool.ts](packages/core/src/execute-tool.ts) (schema → authorize → invoke, unbypassable), [authorization.ts](packages/core/src/authorization.ts) (never consults the model), [agent-loop.ts](packages/core/src/agent-loop.ts) (replay-protected approvals, before/after diff), [verify.ts](packages/core/src/verify.ts) (deterministic checks that return INCONCLUSIVE rather than defaulting to pass), [freecad-runtime.ts](packages/adapters/src/freecad-runtime.ts) + [runner.py](packages/adapters/freecad/runner.py) (argv-only subprocess, fixed operation table), and [http-research-provider.ts](packages/adapters/src/http-research-provider.ts) (SSRF hardening incl. per-redirect DNS re-checks). `SUBMISSION.md` has the deployment steps and demo script.

## Architecture

```
                         ┌─────────────────────┐
                         │   apps/web (React)  │
                         │  chat · projects ·   │
                         │  environment · files │
                         └──────────┬───────────┘
                                    │ HTTP (x-naqsh-user header)
                         ┌──────────▼───────────┐
                         │   apps/api (Express)  │
                         │ routes → engineering-  │
                         │ Workflow / chatWorkflow│
                         └─────┬────────────┬────┘
              ┌────────────────┘            └────────────────┐
   ┌──────────▼───────────┐                       ┌──────────▼───────────┐
   │     packages/core      │                       │ packages/model-      │
   │ World Model · tools ·  │◄──ModelProvider───────│ providers             │
   │ authorization ·        │    contract           │ @google/genai →       │
   │ checkpoints · verify    │                       │ Gemini API             │
   └──────────┬───────────┘                       └───────────────────────┘
              │ EnvironmentAdapter contract
   ┌──────────▼───────────┐
   │   packages/adapters    │
   │ mock_cad · mock_sim ·  │
   │ FreeCAD (real subprocess│
   │ to a local freecadcmd) │
   └─────────────────────────┘
```

Every arrow above is a real, typed contract (`packages/schemas`) — `apps/api` never imports `@google/genai` or a CAD adapter directly, only the `ModelProvider`/`EnvironmentAdapter` interfaces `packages/core` defines. Swapping Gemini for another provider, or FreeCAD for another CAD tool, means writing one new adapter, not touching the orchestration layer.

Repository layout:

- `apps/web` — the real chat-first frontend (React + Vite)
- `apps/api` — the real Express API server: routes, authorization enforcement, chat/engineering workflow orchestration
- `apps/desktop` — an optional Electron shell adding real OS-level window/screen capture of a connected CAD application
- `packages/core` — the World Model, tool execution + authorization, checkpoints, deterministic verification
- `packages/schemas` — shared typed contracts every other package imports, never redefines
- `packages/adapters` — concrete `EnvironmentAdapter`s (mock CAD, mock simulation, real FreeCAD)
- `packages/model-providers` — concrete `ModelProvider`s (the real Gemini provider, and a deterministic mock used in tests/offline demos)

## Deployment

A complete two-service Cloud Run pipeline lives in this repo
(`apps/api/Dockerfile` with FreeCAD installed, `apps/web/Dockerfile`, and
`cloudbuild.yaml` that deploys both and wires CORS between them).

**It has never been run.** [DEPLOYMENT.md](DEPLOYMENT.md) explains why,
gives the exact commands, and separates what is verified from what is
not.

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
apps/web, apps/api          (the real UI / API surface)
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

## How it works, in depth

- **[docs/DESIGN.md](docs/DESIGN.md)** — the World Model, the
  change/tool/authorization model, and an honest list of what is
  deliberately **not** implemented.
- **[docs/PHASES.md](docs/PHASES.md)** — phase-by-phase implementation
  notes for every part of the system, including the alternatives that
  were considered and rejected.

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
