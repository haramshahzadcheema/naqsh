# NAQSH — Phase 8 Audit + Full P0–P8 Foundation Audit

Date: 2026-08-15
Scope: Rigorous re-audit of the actual repository (not prior audit reports) covering P0–P8, plus cross-phase architectural verification against the planned P9+ pipeline. No P9+ functionality was implemented.

---

## 1. P8 audit findings

Verified against the actual implementation (`packages/core/src/observe-project.ts`, `observation-tool.ts`, `apps/api/src/observation-service.ts`, `packages/schemas/src/observation-types.ts`), not assumed from passing tests.

**CRITICAL (found and fixed):** `ObservationResult` — and several individually-exported query functions (`getRequirementById`, `getConstraintById`, `getObjectById`, `getDecisionById`, `getExperimentById`, `getPreferenceById`, `getRelationshipsForEntity`) — returned **live, shared references** into `WorldModelState`'s own arrays/objects rather than independent copies. `result.requirements.push(...)` or `result.requirements[0].description = "x"` on an `ObservationResult` from `observeProject()` silently mutated the actual World Model. Confirmed by direct reproduction before fixing. Root cause: P1's entity factories (`createRequirement`, etc.) never freeze their output, and P8's original construction only shallow-froze already-shared references. See §2 for the fix.

**25-point requirement checklist** — all confirmed satisfied after the fix:
1. Deterministic observation — `observeProject` is a pure function of its `WorldModelState` argument (no I/O, no hidden state).
2. Read-only — structurally enforced: `observe-project.ts`/`observation-tool.ts` import nothing from the World-Model write path (`transitions.ts`, `change-history.ts`, `record-transition.ts`, `bootstrap.ts`), and every returned value is now a `structuredClone` + deep-frozen snapshot.
3. Whole-project observation — `scope: "project"`.
4. Focus-scoped observation — `scope: "focus"`, seeded from `SessionState.focusObjectIds`.
5. Object-scoped observation — `scope: "object", objectId`.
6. Relationship/context traversal — one-hop traversal via `EntityRelationship`, confirmed bounded by construction (see cycle test, §3).
7. Structured `ObservationResult` — typed, schema-validated contract.
8. Explicit missing-information representation — `missingInformation: string[]`, populated only by real structural checks (empty objective, zero requirements, stale focus id) — never fabricated.
9. Explicit ambiguity representation — `ambiguityIndicators` reserved, always empty in P8 (genuine detection is P19's job); a deliberate, documented placeholder, not a stub pretending to be real.
10. Provenance preservation — `source` always `"system"`.
11. State/version consistency — `projectId`/`projectVersion` copied from the live project at observation time; every transition (including P8's own `add_relationship`/`remove_relationship`) increments `project.version` through the same generic path every other transition uses.
12. Typed/schema-validated observation inputs — `observation-tool.ts`'s `inputSchema` (a `ToolValueSchema`), validated by `executeTool` before the handler runs.
13. Typed/schema-validated observation outputs — `assertObservationResult` deep-validates every entity array via the same `assertRequirement`/`assertConstraint`/etc. used everywhere else, plus JSON-safety on `metadata`.
14. Auditable agent-facing observation tool — `createObservationTool` registers a normal `Tool` (`mutation: "observe"`), executed through the same `executeTool` boundary as any other tool — no special-casing.
15. No Gemini dependency for authoritative observation — confirmed via `repo-boundaries.test.ts` and direct grep: zero real references to `@google/genai`/`@naqsh/model-providers` in observation files.
16. No FreeCAD dependency inside core observation logic — confirmed, zero references.
17. No mutation caused by observation — fixed (see CRITICAL finding above); now enforced by two independent regression tests.
18–23. Empty/requirements-only/objects-only/unrelated-entity/invalid-ID/malformed-relationship cases — all explicitly tested (`observe-project.test.ts`); malformed-relationship coverage extended this audit with explicit self-referential-relationship and relationship-cycle tests (§3).
24. Compatibility with existing World Model — reads `WorldModelState` directly, no parallel copy.
25. Compatibility with P0–P7 — reuses the same `Tool`/`ToolError`/`ToolRegistry`/`executeTool` machinery as every other phase; no parallel execution path.

**Quality-audit checklist:**
- Duplicated logic (found and fixed): `collectContextForSeeds` reimplemented the same "which entity is on the other side of this relationship" logic `getRelatedEntityRefs` already had, independently. Refactored to reuse `getRelatedEntityRefs`, eliminating the drift risk. All 34→36 tests in `observe-project.test.ts` still pass after the refactor.
- Unsafe casts: the `as Requirement[]`/`as Constraint[]`/etc. casts in `getRequirementsForObject` and friends, and the `entity as Requirement`/etc. casts in `pushIntoContext`, are all provably sound — each is downstream of a `switch`/filter on `EntityKind` that guarantees the runtime type matches before the cast. Confirmed safe, no change needed.
- Hidden mutable state: none — `observe-project.ts` and `observation-tool.ts` declare no module-level `let`/mutable `Map`/`Set` (also regression-tested in `repo-boundaries.test.ts`).
- Mutation through returned references / shallow-copy bugs: the CRITICAL finding above, now fixed with `structuredClone` + recursive freeze at every exit point.
- Incorrect object identity assumptions: none found beyond the CRITICAL finding.
- Inconsistent IDs / timestamps: none — ids via `createId`, timestamps via `toIsoTimestamp()`, consistent with every other phase.
- Incomplete validation: none in P8 itself (see §5 for a P1-level gap that indirectly affected `ObservationResult`'s trustworthiness).
- Silently swallowed errors: none — `observeProject` throws structured `ObservationError`s for the two genuinely erroring cases; `observation-tool.ts` maps them to `ToolError("invalid_input")`, never swallows.
- Fabricated/missing data presented as fact: none — `missingInformation` is real structural checks only.
- Accidental Gemini/environment coupling: none, confirmed by repo-boundaries tests.
- Circular dependencies / incorrect package boundaries: none.
- Overly broad interfaces / unnecessary abstractions / premature infrastructure: none found. `ObservationResult` is a flat, closed, purpose-built contract — no speculative fields beyond the deliberately-reserved `ambiguityIndicators`.
- Brittle tests / tests of implementation details: existing suite tests behavior (scope semantics, error asymmetry, immutability) not internals; no changes needed there.

**Is `ObservationResult` a stable contract for Phase 9?** Yes, with the mutation-leak fix in place. It is a flat, versioned, schema-validated, deeply-immutable snapshot with no live references back into `WorldModelState` — exactly the shape a P9 planner needs to reason over without accidentally corrupting the World Model or holding a reference that changes underneath it.

---

## 2. P8 fixes

1. **`createObservationResult`** (`packages/schemas/src/factories.ts`) — every entity array/object field now goes through `structuredClone` before the final `deepFreeze`, breaking all shared references to the source `WorldModelState` data.
2. **Individual query functions** (`packages/core/src/observe-project.ts`) — added a local `snapshot()`/`deepFreezeInPlace()` helper (structuredClone + recursive freeze); applied to `getRequirementById`, `getConstraintById`, `getObjectById`, `getDecisionById`, `getExperimentById`, `getPreferenceById`, `getRelationshipsForEntity`. Necessary because these are independently consumed by `apps/api/src/observation-service.ts`, bypassing `createObservationResult` entirely — a single fix at the factory level would not have covered this path.
3. **Deduplicated relationship-traversal logic** — `collectContextForSeeds` now reuses `getRelatedEntityRefs` instead of reimplementing the same source/target resolution inline.
4. **README correction** — the Observation section previously claimed entity arrays were "the SAME already-frozen entities `WorldModelState` already holds" — false, and the direct cause of the CRITICAL bug going unnoticed. Rewritten to accurately describe the `structuredClone`-based snapshot guarantee and why it's load-bearing.

---

## 3. P8 tests added/changed

- `observe-project.test.ts`: two new regression tests — mutating any field of a returned `ObservationResult` throws `TypeError` and leaves the World Model untouched; the same guarantee for every individual query function (`getRequirementById`, `getRelationshipsForEntity`, `getFocusedObjects`).
- `observe-project.test.ts`: explicit self-referential-relationship test (a relationship where source === target is excluded from "related" refs, not treated as a neighbor).
- `observe-project.test.ts`: explicit relationship-cycle test (A→B→C→A) proving traversal resolves to exactly the one-hop neighbors and terminates — cycles cannot cause unbounded traversal by construction (no recursive walk exists).
- No meaningless tests added — every new test targets a specific, previously-unverified invariant named in the audit brief.

Net: `observe-project.test.ts` went from 34 to 36 tests; `packages/core` suite overall grew from 240 to 242 (the other addition is the change-history `.kind` regression test, §14).

---

## 4. P0 — Foundation

**Confirmed correct:**
- Package boundaries are real and enforced, not aspirational: `packages/schemas` has zero dependencies; `core` depends only on `schemas`; `adapters`/`model-providers` depend on `core`+`schemas`. `repo-boundaries.test.ts` checks actual `package.json` fields and scans source text for forbidden imports.
- TypeScript strictness is real and uniform: `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals/Parameters: true` in `tsconfig.base.json`, inherited identically by every package.
- Test infrastructure is consistent: every package uses `node --import tsx --test` with an explicit file list — no test-runner mixing.
- No hidden global mutable state anywhere in `packages/core/src`.
- Extensibility is contained: adding a new entity kind touches a small, predictable set of files, and the `TransitionRegistry`'s mapped type makes forgetting a core registry entry a **compile error**.

**Fixed this audit:**
- `repo-boundaries.test.ts` had guards for every wrong-direction import (`adapters`, `model-providers`, `@google/genai`) except `apps/api`/`apps/web`. Added the missing guard.

**Deferred, documented (not fixed):**
- Every package's `package.json` `main`/`types` point at `./src/index.ts`, not `dist/`. This works today because the whole workspace runs through `tsx`, but it means nothing has actually verified a `dist/`-only consumption path works. Not a P0–P8 blocker — flagged as a decision to make explicitly before any deployment that doesn't register `tsx`.

---

## 5. P1 — World Model

**Confirmed correct:**
- Exactly one definition of every canonical entity type/factory/validator — no hand-duplicated copies anywhere in the repo (this was the exact historical bug `repo-boundaries.test.ts` already regression-guards for).
- `updateWorldModel` never mutates its input; every transition handler constructs new objects/arrays.
- Compile-time-enforced exhaustiveness: `TransitionRegistry` is a mapped type over `TransitionKind` — a missing entry is a build error, not just a runtime `default: throw` (though the runtime guard exists too, for untyped/malformed input).

**Fixed this audit:**
- **`unit` field on `Requirement`/`Constraint` was typed (`string | null`) but never validated** — `createRequirement({ unit: 42 })` previously passed validation despite violating its declared type. Fixed: `assertRequirement`/`assertConstraint` now check `unit`.
- **P1 entities skipped the JSON-safety check every P2+ entity enforces.** `isJsonSafeValue` (rejects functions, Symbols, `Date`/`Map`/`Set`/`RegExp`, `NaN`/`Infinity`) was wired into `assertChange`, `assertTool`, `assertApproval`, all `assertEnvironment*`/`assertModel*` — but not `assertObjective`, `assertRequirement`, `assertConstraint`, `assertEngineeringObject`, `assertDecision`, `assertExperiment`, `assertPreference`, `assertProject`, `assertSessionState`. Concrete failure this allowed: a `Requirement.metadata` (or `.value`) containing a function or `Date` would pass validation, then silently vanish or change type on `JSON.stringify` — a silent, undetected data-loss path. Fixed: `isJsonSafeValue` now checked on `metadata` (all nine functions) plus the free-form `value`/`properties`/`inputs`/`result` fields specifically.
- **Root-cause fix for the live-reference bug class:** `createAutonomyGrant`'s `toolNames` array is now deep-frozen (see §8 — this is the P4 instance of the identical bug class P8 had). P1's own entity factories (`createRequirement` etc.) were deliberately **left unfrozen** — freezing them was considered and rejected as out of proportion to the actual risk today (see §15 for why).

**Deferred, documented (not fixed):**
- P1 entity factories still don't freeze their output, unlike every P2+ factory. This is a latent, not currently observed, risk (see §5's discussion in the original audit and §15 below for the full reasoning on why this stays deferred rather than being fixed wholesale).

---

## 6. P2 — Change Model

**Confirmed correct:**
- No duplicated `Change`/`ChangeCause`/`ChangeTarget` types.
- Changes are JSON-serializable by construction — `assertChange` requires `isJsonSafeValue` on `transition`/`before`/`after`/`metadata`, and round-trip fidelity is explicitly tested.
- `parentChangeId` chain integrity is enforced structurally: `ChangeHistory.append()` rejects any entry whose `sequence`/`parentChangeId` doesn't match the current head, and rejects duplicate ids — a cycle cannot be constructed through this API.
- Checkpoint/rollback is not structurally blocked: `Change.transition` stores a replayable form, and replaying the full chain against a fresh state reproduces the same result deterministically (exercised and passing). No O(1) checkpoint exists yet — an explicit, documented P15+ scope decision, not a design flaw.

**Fixed this audit:**
- **`WorldModelValidationError` was the one error class in the entire repo without a `.kind` discriminator**, unlike `ToolError`/`AuthorizationError`/`EnvironmentError`/`ModelError`/`ObservationError`, all of which exist specifically so callers can branch without string-matching a message. Fixed: added `WorldModelValidationErrorKind = "invalid_shape" | "invalid_transition" | "invalid_change_sequence"`, threaded through all 20 throw sites across `validators.ts`, `tool-schema.ts`, `serialization.ts`, `transitions.ts`, and `change-history.ts`. Purely additive — no existing message-matching test needed to change.

**Deferred, documented (not fixed):**
- `ChangeHistory`'s `before`/`after` fields store the same (unfrozen) entity object references that live in `WorldModelState` — in principle, a caller holding a stale `Change.after` reference could mutate it and retroactively corrupt recorded history, the same bug class P8 had. This is a **latent** risk, not an observed one: nothing in the current P0-P2 code path holds such a reference and mutates it, and every existing consumer either reads-and-discards or goes through the read-only accessors. See §15 for the full reasoning on why this is deferred rather than fixed by freezing P1 factories wholesale.

---

## 7. P3 — Tools

**Confirmed correct (no changes needed):**
- No registry bypass: `ToolRegistry` has no `invoke` method; `invokeRegisteredTool` is the sole dispatch primitive, deliberately not re-exported from `packages/core/src/index.ts`, and `execute-tool.ts` is its only importer. Regression-tested.
- Input **and** output are both validated against `tool.inputSchema`/`outputSchema` on every call, via the single canonical `matchesToolValueSchema`.
- No arbitrary code execution anywhere in `core`/`schemas`/`adapters`/`model-providers`: no `eval`, `new Function`, `child_process`, or dynamic-specifier `import()` — statically enforced by `repo-boundaries.test.ts`. `Tool` structurally cannot carry a handler field.
- Schema freezing: `createTool` deep-freezes `inputSchema`/`outputSchema`, so a registered tool's validation contract can't be mutated in place after registration.
- P7's `executeModelToolCall` correctly funnels every model-originated call through the same `executeTool` boundary — the only addition is checking the tool was actually declared to the model for that turn, a legitimate extra guard, not a shortcut.
- No duplicate type definitions for `Tool`/`ToolValueSchema`/`ToolError`/etc.

**Deferred, documented (not fixed):**
- `Tool.metadata`/`Approval.metadata`/`AutonomyGrant.metadata` (besides `toolNames`, fixed — see §8) are shallow-frozen only. Confirmed **not currently security-relevant** — nothing in `core`'s authorization/execution logic reads `tool.metadata`. Low-value churn without a concrete exploit path; left alone.

---

## 8. P4 — Permissions / Authorization

**CRITICAL (found and fixed):** `AutonomyGrant.toolNames` was a live, mutable array despite the top-level `grant` object being frozen — `Object.freeze()` is shallow, so `grant.toolNames.push("dangerous_tool")` on any object returned by `AutonomyGrantStore.create()`/`getById()`/`list()` silently expanded an **already-active** grant's authorized scope, with no new `Change`, no revoke/recreate, and nothing for `evaluateAutonomyGrant` (which reads `grant.toolNames.includes(...)` directly off the stored object) to catch. Reproduced and confirmed exploitable before fixing: pushing a tool name onto a returned grant, then evaluating authorization for that tool at autonomy level `"autonomous"`, succeeded. This is the exact same live-reference bug class as P8's, but with direct security stakes (privilege escalation of a standing grant) rather than a World-Model-integrity issue. Fixed: `createAutonomyGrant` now deep-freezes `toolNames`.

**Confirmed correct:**
- Double-decision and stale-grant reuse are properly prevented: `ApprovalStore.approve/reject` require `status === "pending"`; `revoke` requires `status === "approved"`; `consume` checks both status and `consumedAt`. `AutonomyGrantStore.recordUse` independently re-checks active/not-expired/not-exhausted **at consumption time**, not just at evaluation time.
- The "observe" classification trust model is sound: authorization branches solely on `tool.mutation`, read from the frozen, registry-resident `Tool` object — no tool-name-specific carve-out exists anywhere.
- No enforcement bypass introduced by P7/P8: `executeModelToolCall` and `observation-tool.ts`'s handler both go through the identical `executeTool` → `authorize` hook path as any other caller.

**Confirmed intentional, not a bug — flagged for P11's attention:** `executeTool`'s `authorize` parameter is **optional**, defaulting to always-allow (`input.authorize ?? (() => true)`). This is deliberate, documented, and explicitly tested ("allows execution by default when no authorize hook is given") — P4's design is "mechanism in P3, policy plugged in by the caller," the same pattern as Express/Koa middleware. `createExecuteToolAuthorizer` (`authorization.ts`) already exists as the ready-made bridge from real P4 policy (`AutonomyLevel`/`ApprovalStore`/`AutonomyGrantStore`) into this hook. **Nothing in the repository currently wires this up by default** (`apps/api/src` has no server yet). This is not a P0-P8 defect — it's a correctly-built, correctly-tested seam — but whoever builds the P11 agent loop **must** remember to pass `authorize: createExecuteToolAuthorizer(...)` on every call, or every tool (including "modify"/"autonomous" ones) executes unchecked. Recorded here explicitly so it isn't rediscovered as a surprise during P11.

**Deferred, documented (not fixed):**
- Auditability: `AuthorizationDecision` persistence is only via an optional `onDecision` hook; nothing forces a caller to capture the audit trail. Matches P4's own stated scope boundary (no logging system built yet) — a real gap to close before autonomous execution ships, not a P0-P8 defect.

---

## 9. P5 — EnvironmentAdapter

**Confirmed correct, no changes needed:**
- Single canonical definition of `EnvironmentObject`/`EnvironmentOperationResult`/error kinds.
- The `EnvironmentAdapter` interface plus one reusable contract-test suite (`runEnvironmentAdapterContractTests`) lives in `core`, exercised against three mock implementations — `core` itself contains zero references to FreeCAD (confirmed by grep; only doc comments explaining the future P12 boundary).
- No cross-coupling between `packages/adapters` and `packages/model-providers`.
- Lifecycle consistency: all three named mock environments (`mock-cad-environment.ts`, `mock-simulation-environment.ts`, `mock-environment.ts`) are thin config wrappers around one shared engine (`in-memory-environment.ts`), so they cannot silently diverge on `connect()`/lifecycle behavior.
- `EnvironmentAdapter`'s eleven operation methods are all non-optional, enforced by a repo-boundaries regression test.

No findings requiring action in P5 itself — the one real bug in this area (§10) lives in the shared engine, categorized under P6 since that's where it was found and where it's most consequential.

---

## 10. P6 — Deterministic mock environment

**CRITICAL (found and fixed):** `packages/adapters/src/in-memory-environment.ts` — `inspectObject`, `listObjects`, `createObject`, and `modifyObject` all returned the **exact same `EnvironmentObject` reference** stored in the adapter's internal `objects` Map. `createEnvironmentObject` only shallow-`Object.freeze`s its return value — the top-level object becomes non-reassignable, but the nested `properties`/`relationships` arrays and `metadata` object are not frozen or cloned. Confirmed exploitable: `result.data.properties.push({...})` on an inspected object silently corrupted the adapter's own ground truth for every subsequent call, not just the caller's local copy — the same bug class as P8's, just in the environment layer instead of the World Model layer, and affecting `createObject`/`modifyObject` too (their returned `data` is the exact object just stored into the Map), not only the two read-only methods first identified. Fixed: added a local `snapshot()`/`deepFreezeInPlace()` helper (mirroring `observe-project.ts`'s pattern) and applied it at all four call sites.

**Confirmed correct:**
- Determinism is real: `createMockEnvironment()` defaults to `createDeterministicIdGenerator()`/`createDeterministicClock()` — counter-based ids, logical clock, never `Math.random()`/`Date.now()` directly.
- State isolation: every `createInMemoryEnvironmentAdapter()` call builds fresh closure-scoped state — no module-level singleton (verified against existing "two separate instances don't share state" tests).
- The throw-safety/id-collision fix referenced in git history (`fix(p6): close throw-safety and id-collision gaps`) is still intact: malformed input is caught and converted to a structured `invalid_operation` result, and a colliding caller-supplied id returns `conflict` rather than clobbering.

---

## 11. P7 — Gemini / ModelProvider

**Confirmed correct, all previously-fixed bugs still intact** (re-verified against current source, not assumed from the fix history):
- Zero `@google/genai` dependency in `packages/core` — the `ModelProvider` interface is genuinely provider-agnostic.
- `structuredResult` validation against `outputSchema` runs unconditionally on every success path in both the Gemini and mock providers.
- Undeclared-tool-name rejection happens before `authorize`/handler run, with a regression test explicitly asserting neither runs.
- `executeModelToolCall` uses the exact same `executeTool` boundary as every direct call — no shortcut, enforced by a repo-boundaries test.
- Multiple Gemini function calls in one response now throw `ModelError("unexpected_output")` rather than silently truncating.
- Error-kind mapping is precise (401/403→authentication_failure, 429→rate_limit, 408/504→timeout, 5xx→api_unavailable), not collapsed into one bucket.
- `maxRetries` is actually consumed by the retry loop.
- The provider is network-free testable via an injectable `generateContent` dependency.
- Gemini structured-output text is correctly mapped to `structured_result`.
- `ModelResponse` content is never directly writable to `WorldModelState` — the only path from model output to any effect is `executeModelToolCall` → `executeTool`, itself subject to the `authorize` hook.

**Low, deferred (not fixed):** `GEMINI_MAX_RETRIES=0` cannot currently be set via environment variable — `parsePositiveInt` requires `parsed > 0`, so an explicit `0` silently falls back to the default (`2`), even though the retry loop (`Math.max(0, config.maxRetries)`) is written to support disabling retries entirely. Cosmetic config-surface gap, not a correctness or security issue; left for whoever next touches provider configuration.

---

## 12. P8 — Observation

Covered in full in §1–3 above.

---

## 13. Cross-phase architectural findings

The pipeline **WORLD MODEL → DETERMINISTIC OBSERVATION → STRUCTURED OBSERVATION → AGENT REASONING → PROPOSED ACTION → APPROVAL/PERMISSION → EXECUTION → VERIFICATION** was audited for seam compatibility. Only P0–P8 exist; nothing in P9+ was implemented, only verified that current seams would support it.

- **WORLD MODEL → OBSERVATION → STRUCTURED OBSERVATION** (P1→P8): sound after this audit's fix. `ObservationResult` is now a genuinely immutable, independent snapshot — safe for a future P9 planner to hold across multiple reasoning steps without it silently going stale or being corrupted by a careless mutation.
- **AGENT REASONING** (P7): `ModelProvider`/Gemini can already be handed an arbitrary prompt/context; nothing currently builds that context FROM an `ObservationResult` (P7 predates P8), which is correct and expected — wiring observation into the model-context-building step is P9/P11's job, not a P0-P8 gap. `context-builder.ts` is one-directional (`WorldModelState` → `ModelContext`) and never touches `ObservationResult` today; no design conflict exists that would force rework.
- **PROPOSED ACTION → APPROVAL/PERMISSION → EXECUTION** (P7→P3→P4): already fully wired and working for the single-tool-call case. `executeModelToolCall` routes every model-originated tool call through the exact same `executeTool` boundary as any other caller, including the `authorize` hook. `createExecuteToolAuthorizer` (P4) is the ready-made bridge from real autonomy/approval policy into that hook. **P11's job is to call `executeModelToolCall` with `authorize: createExecuteToolAuthorizer(...)` — no new infrastructure or redesign needed.** The one thing to actively remember (see §8) is that this wiring is not automatic; omitting it silently disables all authorization.
- **EXECUTION → VERIFICATION** (P3 → P16+): does not exist yet, correctly. `ToolResult`'s `status`/`error.kind` discipline (never throwing for expected failure modes) already gives a P16 verification layer a clean, structured signal to build on without needing try/catch-based error handling threaded through it.
- **P12+ (FreeCAD)**: the `EnvironmentAdapter` boundary is intact and unleaked into `core`; P6's fix (§10) means a future real FreeCAD adapter inherits the same "never leak internal state through a read" discipline the mock now correctly demonstrates.
- **P18+ (NL requirements), P20 (from-scratch generation), P22+ (alternatives), P24 (memory), P25 (background experimentation), P26 (multi-environment)**: no seam currently exists for any of these, and none was built — nothing in the current architecture would need to be reworked to add them (they're additive: new tools, new ModelRequest shapes, new EnvironmentAdapter implementations — all extension points already proven out by P3/P5's design).

No cross-phase redesign is needed. The seams support the next stages; they were not built ahead of need.

---

## 14. Fixes performed across P0–P8

| # | Phase | Severity | Fix |
|---|-------|----------|-----|
| 1 | P8 | Critical | `ObservationResult` + individual query functions leaked live `WorldModelState` references — fixed via `structuredClone`+deep-freeze at both the factory and query-function level |
| 2 | P6 | Critical | `in-memory-environment.ts`'s `inspectObject`/`listObjects`/`createObject`/`modifyObject` leaked live internal-Map references — fixed via the same snapshot pattern |
| 3 | P4 | Critical | `AutonomyGrant.toolNames` was a live mutable array; mutating it silently expanded an active grant's authorized scope — fixed via deep-freeze |
| 4 | P1 | Medium | `Requirement`/`Constraint.unit` was typed but never validated — added validation |
| 5 | P1 | Medium | P1 entities (`Requirement`, `Constraint`, `EngineeringObject`, `Decision`, `Experiment`, `Preference`, `Project`, `SessionState`) skipped the JSON-safety check every P2+ entity enforces on `metadata`/free-form fields — added `isJsonSafeValue` checks |
| 6 | P2 | Medium | `WorldModelValidationError` was the sole error class without a `.kind` discriminator — added `WorldModelValidationErrorKind`, threaded through all 20 throw sites |
| 7 | P0 | Low | `repo-boundaries.test.ts` had no guard against `core`/`schemas` importing `apps/api`/`apps/web` — added |
| 8 | P8 | Quality | `collectContextForSeeds` duplicated `getRelatedEntityRefs`'s traversal logic — refactored to reuse it |
| 9 | Docs | — | README's Observation section falsely claimed entities were "already-frozen" and reused directly — corrected to describe the actual (now-fixed) clone-based guarantee |

All nine fixes are covered by new or updated regression tests (see the diff for exact test names); none inflate the suite with redundant coverage.

---

## 15. Issues intentionally deferred to later phases, and why

- **P1 entity factories still don't freeze their own output** (unlike every P2+ factory). This is the root cause behind both fixed bugs (#1, #2 above are consumer-side patches, not this). Freezing every P1 factory wholesale was considered and rejected FOR THIS AUDIT: it's a larger, more invasive change (touching 9 factories plus anything downstream that assumes mutability, e.g. `modifyObject`-style spread-based updates) whose only currently-provable benefit is closing a **latent** risk in `ChangeHistory.before`/`after` (§6) — nothing today actually holds a stale entity reference and mutates it. The two bugs that WERE real and exploitable (P8's `ObservationResult`, P4's `AutonomyGrant.toolNames`) are both fixed at their actual points of exposure. Freezing P1 wholesale is the right EVENTUAL fix and should be revisited if/when a future phase (P9's planner holding entity references across turns, P24's memory) introduces a concrete path for this latent risk to become real — flagging it now so it isn't forgotten, without doing speculative work today.
- **`executeTool`'s `authorize` hook is optional, not mandatory** (§8). Confirmed deliberate, tested, and architecturally sound as a mechanism/policy split — changing it to be required would be an invasive signature change to a stable, working contract for a "someone might forget to wire it up" risk that's a P11 integration responsibility, not a P0-P8 defect. Documented prominently instead.
- **`Tool.metadata`/`Approval.metadata`/`AutonomyGrant.metadata` shallow-freeze inconsistency** (§7). Confirmed not currently security-relevant (nothing reads these fields in authorization logic). Low-value churn without a concrete exploit path.
- **`AuthorizationDecision` audit-trail persistence** (§8). P4's own documented scope boundary — no logging system exists yet, by design. A real gap to close before autonomous execution ships (P10/P11), not a P0-P8 defect.
- **`GEMINI_MAX_RETRIES=0` can't be set via env** (§11). Cosmetic config-surface gap, unrelated to correctness or security.
- **Package `main`/`types` point at `src/`, not `dist/`** (§4). Works today because the whole workspace runs through `tsx`; worth an explicit decision before any deployment that doesn't register `tsx`, not before P9.

None of these represent a foundational issue that would force a P9 redesign — each is either genuinely out of scope for P0-P8, or a latent risk with no current exploit path, explicitly logged so it isn't rediscovered as a surprise.

---

## 16. Full test result

All workspaces, after all fixes:

```
@naqsh/api            5 / 5   passed
@naqsh/web             (no test script)
@naqsh/adapters       90 / 90 passed
@naqsh/core          242 / 242 passed
@naqsh/model-providers 62 / 62 passed
@naqsh/schemas       208 / 208 passed
-----------------------------------
TOTAL                607 / 607 passed, 0 failed
```

Per-phase confirmation: P0 (boundaries) — PASS. P1 (World Model/entities) — PASS. P2 (Change Model) — PASS. P3 (Tools) — PASS. P4 (Authorization) — PASS. P5 (EnvironmentAdapter contract) — PASS. P6 (mock environment) — PASS. P7 (ModelProvider/Gemini) — PASS. P8 (Observation) — PASS.

## 17. Typecheck result

`npm run typecheck --workspaces --if-present` — clean, zero errors, across `api`, `adapters`, `core`, `model-providers`, `schemas`.

## 18. Build result

`npm run build --workspaces --if-present` — clean, zero errors, across all five TypeScript packages plus `apps/web`'s placeholder build script.

## 19. Lint result

No lint tooling is configured in this repository (no `.eslintrc`/`eslint.config.*` anywhere, no package defines a `lint` script; the root `lint` script is a no-op `--if-present` over all workspaces). This is unchanged from every prior phase — not a new gap, and not one this audit introduces tooling to close, per the explicit instruction not to add dependencies without concrete architectural reason.

## 20. Final architectural verdict

# READY FOR P9

All three CRITICAL findings (P8's `ObservationResult` live-reference leak, P6's mock-environment live-reference leak, P4's `AutonomyGrant.toolNames` mutable-scope leak) are fixed and regression-tested. All MEDIUM findings (P1 validation gaps, missing error-kind discriminator) are fixed. The one HIGH-looking item (`executeTool`'s optional `authorize` hook) is confirmed to be a deliberate, correctly-built, correctly-tested seam — not a defect — with the bridge P11 needs (`createExecuteToolAuthorizer`) already in place; it is documented here specifically so it is acted on deliberately rather than rediscovered as a surprise. The remaining deferred items are genuinely low-severity, out-of-scope-for-P0-P8, or latent risks with no current exploit path — none would force a redesign of P0–P8 once P9 begins. The full repository (607 tests, typecheck, build) is green.
