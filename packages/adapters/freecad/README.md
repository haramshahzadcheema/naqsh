# FreeCAD runtime (Phase 12 + Phase 13 + Phase 14)

This directory is the **entire** FreeCAD-side surface NAQSH talks to. Nothing
under `packages/core` or `packages/schemas` may import anything here or
anything FreeCAD-related at all — enforced structurally by
`packages/core/test/repo-boundaries.test.ts`'s P12/P13 guard blocks, not
merely by convention.

## Why a separate Python runtime

FreeCAD's automation API is a Python API with no Node.js binding. Rather than
forcing FreeCAD into the Node.js core (explicitly forbidden by the Phase 12
brief) or building a persistent cross-language server (real complexity this
phase doesn't need), the boundary is a **one-shot subprocess per operation**:

```
TypeScript NAQSH core
        |
        v
EnvironmentAdapter interface        (packages/core/src/environment-adapter.ts)
        |
        v
FreeCadAdapter                      (packages/adapters/src/freecad-adapter.ts)
        |
        v
freecad-runtime.ts                  (packages/adapters/src/freecad-runtime.ts)
        |   spawns: freecadcmd runner.py <base64 request>
        v
runner.py                           (this directory)
        |
        v
FreeCAD's real Python API
```

Every call to `FreeCadAdapter` spawns a fresh `freecadcmd` (FreeCAD's own
headless CLI) process, which imports `runner.py`, opens the target document,
performs exactly one operation, closes the document, and exits. There is no
persistent FreeCAD process kept alive between calls, and no session state on
the FreeCAD side at all — the **only** thing carried between calls on the
NAQSH side is the document's file path (stored in
`EnvironmentSession.metadata.filePath`).

**Tradeoff, stated explicitly:** this costs FreeCAD's own startup latency
(several hundred ms to a few seconds) on every single call. In exchange, the
design is simple and crash-safe — a wedged or crashed FreeCAD process can
never corrupt cross-call adapter state, because there is no cross-call state
to corrupt. A persistent-connection optimization (keep one `freecadcmd`
process alive and talk to it via a small RPC loop) is a reasonable future
improvement once this narrow read/inspect/save boundary is trusted — not
attempted in Phase 12.

## The protocol

`freecad-runtime.ts` sends exactly one argument to `runner.py`: a
base64-encoded JSON object `{"operation": "...", "params": {...}}`.
`runner.py` dispatches to a **fixed, named table** of operations
(`OPERATIONS` in `runner.py`) and prints exactly one line to stdout:

```
@@NAQSH_RESULT@@{"status":"success","data":...}
```

or

```
@@NAQSH_RESULT@@{"status":"error","kind":"environment_failure","message":"..."}
```

The sentinel prefix exists because FreeCAD itself prints its own startup
banner and `Recompute`/`Importing`/`Postprocessing` progress noise to stdout
around the runner's own output — `freecad-runtime.ts` scans stdout
line-by-line for the one line starting with `@@NAQSH_RESULT@@` rather than
assuming stdout is clean JSON.

**Quirk worth knowing if you touch `runner.py`:** under `freecadcmd
runner.py <arg>`, `sys.argv` is `[freecadcmd's own path, runner.py's path,
<arg>, ...]` — `freecadcmd` keeps itself as `argv[0]` rather than replacing
it with the script, unlike a plain `python runner.py <arg>` invocation.
`runner.py` reads the encoded request from `sys.argv[2]`, not `sys.argv[1]`.
Also: `freecadcmd` imports the script as a regular module (its `__name__` is
its own filename, never `"__main__"`) — a `if __name__ == "__main__":` guard
would silently never fire, so `runner.py` calls `main()` unconditionally.
Both were confirmed empirically against a real FreeCAD 1.1.3 install.

## Security boundary

`runner.py` dispatches to a **fixed set of named functions**
(`health`/`connect`/`list_objects`/`inspect_object`/`inspect_document`/
`modify_object`/`save`). There is no
`eval`/`exec` on request data anywhere in this directory, no operation that
accepts caller-supplied code, and no generic "run this Python" primitive.
Adding a new capability means adding a new named function to `OPERATIONS` —
there is no path for an agent or a model to reach an arbitrary-execution
surface through this boundary. `modify_object` (Phase 14) is NOT a generic
property-write primitive either: the only `setattr()` call site in this
entire script is inside `op_modify_object`'s own validated loop, gated by
an explicit `SUPPORTED_MUTATIONS` allowlist — verified structurally by
`repo-boundaries.test.ts`'s P14 guard block (counts `setattr(obj, ...)`
call sites in the actual source, not comments).

## Scope (Phase 12)

Implemented: `health`, `connect` (open + validate a `.FCStd` document),
`list_objects`, `inspect_object`, `save`. The adapter's declared
`capabilities` is exactly `["save"]` — `create`/`modify`/`delete`/
`checkpoint` are real, present `EnvironmentAdapter` methods (the interface
requires them unconditionally) but every one returns a structured
`unsupported_capability` result in this phase. No rollback/checkpoint
capability is claimed — FreeCAD document `save()` is a real, working
operation, but it is not a transactional checkpoint with restore.

## Scope (Phase 13): deep document/object/parameter/relationship inspection

Phase 13 makes `list_objects`/`inspect_object` genuinely rich, and adds one
new operation, `inspect_document` — the cheapest inspection tier (document
identity, object count/ids, hierarchy roots, no per-object payload). It does
**not** add or change any mutation capability: `capabilities` is still
exactly `["save"]`, verified structurally by
`repo-boundaries.test.ts`'s P13 guard block.

**Every `EnvironmentObject` now additionally carries:**

- `genericType` — a small, normalized category (`"solid"`, `"sketch"`,
  `"container"`, `"datum"`, `"link"`, `"unknown"`), derived from a reliable
  `obj.isDerivedFrom(...)` check, never a guess. `"unknown"` is the honest
  answer whenever no rule reliably applies — deliberately not a giant
  universal CAD ontology (see `get_generic_type()` in `runner.py`).
- `parentId` — the id of the containing object (an `App::Part` or
  `App::DocumentObjectGroup`), found via that container's own `.Group`
  list, or `null` if none. Never inferred from position/naming.
- `visible` — FreeCAD's own `.Visibility`, or `null` if unavailable.
- `geometry` — bounded, best-effort metadata from `obj.Shape` (bounding
  box, volume, surface area, center of mass, solid/face/edge/vertex
  counts, shape validity) computed defensively PER METRIC (`get_geometry()`
  in `runner.py`) — one unreadable metric (e.g. a Sketch's `Shape` exists
  but raises on `.Volume`) never blanks out the rest or aborts the object.
  `geometry.available` is `false` (with a `reason`) whenever no shape
  exists or the shape is invalid — never a fabricated/garbage value.
  **Cost-tiered, not computed everywhere** (audit finding): `list_objects`
  (the object INVENTORY tier) deliberately skips geometry entirely
  (`geometry.available: false`, `reason: "not_requested_in_listing"`) —
  computing bounding box/volume/area/topology for every object on every
  listing call is real, repeated, uncached cost for a real assembly with
  hundreds of solids (each call reopens the document fresh; there is no
  cross-call state to memoize against). `inspect_object` (exactly one
  object) always computes it — that cost is bounded by definition. See
  `object_to_dict()`'s `include_geometry` parameter in `runner.py`.

**Relationships are now differentiated** (`get_relationships()` in
`runner.py`), not collapsed into one blanket type:

- `"contains"` — from a container's own `.Group` list.
- `"links_to"` — from `App::Link`'s own `.LinkedObject` property.
- `"references"` — the residual generic dependency from `obj.OutList`
  (unchanged from Phase 12 — e.g. `Part::Cut`'s `Base`/`Tool`), for any
  target not already classified above.

Every relationship type above is derived from a genuine, distinct FreeCAD
mechanism — never inferred merely because two objects seem related.

**Object identity (read this before assuming anything about ids):**
`EnvironmentObjectId` is FreeCAD's own `obj.Name` — stable *within one open
document session*, but **NOT** globally unique across documents/
environments, and **NOT** preserved across a save/reopen cycle for the
*document itself*. Confirmed empirically: reopening a document via
`FreeCAD.openDocument(path)` assigns the DOCUMENT its own new internal
`.Name` derived from the file's basename, even though it was created under
a different name — `EnvironmentDocumentInspection.documentId` reflects
whatever FreeCAD actually reports at inspection time, never a value this
adapter assumes or remembers from creation. Individual OBJECT names within
a document are not observed to change across save/reopen, but this adapter
makes no persistence guarantee beyond what FreeCAD itself provides — do not
build logic elsewhere in NAQSH that assumes a FreeCAD id survives outside
the FreeCAD environment.

**Partial success:** `list_objects` now continues past a single object it
cannot describe (`op_list_objects` in `runner.py` wraps each object
individually), returning every object it COULD build plus an
`inspectionErrors` list for the ones it couldn't — never an all-or-nothing
failure over one bad object in an otherwise-healthy document. On the
TypeScript side, `FreeCadAdapter.listObjects` mirrors this: a malformed raw
object is skipped with a warning (`result.metadata.warnings`), never
aborting the whole call. The same discipline applies one level deeper: a
single RELATIONSHIP candidate that `get_relationships()` cannot safely
describe (e.g. `.Name` raising on an object reference obtained from
`.Group`/`.OutList`/`.LinkedObject`) is reported as a
`relationship_inspection_failed` entry in `inspectionErrors` rather than
silently vanishing — an earlier version of this script `continue`d past
such a failure with no trace anywhere, an audit finding fixed by threading
a mutable `errors` collector through `get_relationships()`/`object_to_dict()`.
`inspect_object` surfaces the same list via
`EnvironmentOperationResult.metadata.inspectionErrors` when non-empty.

**Determinism:** object listings are sorted by `.Name` (FreeCAD's own
iteration order is not a documented contract); relationships are sorted by
`(type, targetId)`. Two `listObjects()`/`inspectDocument()` calls against an
unmutated document return byte-for-byte identical `data` — including
`metadata.provenance`, which deliberately carries no per-call timestamp
(the surrounding `EnvironmentOperationResult.completedAt` already carries
"when"; see `tryBuildObject` in `freecad-adapter.ts` for why an earlier
version of this got that wrong).

**Deliberately NOT implemented (Phase 14+ territory):** creating objects,
modifying parameters, deleting objects, geometry generation/editing,
feature-tree rewriting, and reconciling an observation back into NAQSH's
`WorldModelState` (mapping a FreeCAD `EnvironmentObjectId` to a World Model
`EngineeringObject.id` and interpreting properties as World Model facts is
genuine adapter-specific interpretation work — see
`packages/schemas/src/environment-types.ts`'s own header comment on why
that reconciliation stays a separate, later concern).

**Agent-facing tools** (`packages/core/src`, all `mutation: "observe"`,
`target: "environment"`): `inspect_environment_document`,
`inspect_environment_objects`, `inspect_environment_object`,
`inspect_environment_relationships` — thin wrappers around
`EnvironmentAdapter.inspectDocument`/`listObjects`/`inspectObject`, the last
one a lighter relationship-only reshaping of `listObjects`'s own result.
None of them import a concrete adapter package or FreeCAD-specific code —
enforced structurally, not just by convention.

## Scope (Phase 14): safe real CAD modification

Phase 14 adds exactly one new operation, `modify_object`, and grants the
adapter one new capability: `capabilities` is now `["save", "modify"]` —
`create`/`delete`/`checkpoint` remain unimplemented, verified structurally
by `repo-boundaries.test.ts`'s P14 guard block. This is **not** a general
CAD-editing capability; it is a single, narrow, explicitly-typed mutation
path with the same shape as every other Phase 14 read/write operation:
validate, mutate, re-observe, report — never "run this code."

**The allowlist.** `SUPPORTED_MUTATIONS` in `runner.py` is a module-level
dict keyed by FreeCAD `TypeId`, and today contains exactly one entry:
`Part::Box` with its `Length`/`Width`/`Height` properties, each with an
explicit `{min, max}` range. This is deliberately narrow — "If FreeCAD
contains 500 writable properties, Phase 14 might intentionally expose only
1–5. That is a feature, not a limitation." `get_properties()`'s `readOnly`
flag is computed from this allowlist (not from FreeCAD's own editor mode),
so an inspection response honestly reflects what Phase 14 can actually
mutate, not what FreeCAD's UI would merely permit. Structurally enforced:
`repo-boundaries.test.ts` counts real `setattr(obj, ...)` call sites in
`runner.py` and asserts there is exactly one, inside `op_modify_object`'s
own validated loop — there is no other path to a property write anywhere
in this directory.

**Validation order in `op_modify_object`:** target exists → target's
`TypeId` is in `SUPPORTED_MUTATIONS` (`unsupported_target_type` otherwise)
→ each requested property is both allowlisted and writable
(`unsupported_property` / `read_only_property`) → current values are read
(`property_read_failed` on a read exception) → **stale-state check**: if
the caller supplied `expectedBefore` and the current value no longer
matches, reject as `conflict` and mutate nothing → **idempotency check**:
if every requested value already equals the current value, skip the
mutation entirely and return `alreadySatisfied: true` with `propertyChanges`
showing `before === requested === after` → value-type validation (rejects
`NaN`/non-finite/wrong-typed values as `invalid_value`) → range validation
against the allowlist's `{min, max}` (`value_out_of_range`) → the single
`setattr()` loop → `doc.recompute()` → `shape.isValid()` check (rejects as
`invalid_resulting_geometry` **without** saving if recompute produced an
invalid shape) → `doc.save()` → a defensive, three-tier post-save re-read
(full object rebuild → object rebuild without geometry → a minimal literal
built from already-known identifiers) that can never turn an
already-persisted mutation into a reported failure — read failures at this
stage are appended to a `warnings` list instead.

**Persistence.** Because every call is a fresh `freecadcmd` subprocess (see
"Why a separate Python runtime" above), a mutation is only durable once
`doc.save()` has run; `modifyObject` always saves on a successful mutation
before returning, and Phase 14's integration tests confirm the change
survives a genuinely new `connect()` call in a separate subprocess.

**Empirically confirmed real-FreeCAD mutation semantics** (probed directly
against FreeCAD 1.1.3 before writing any production code): a negative
`Length` is silently clamped to `0.0` by FreeCAD itself, not rejected —
Phase 14's own range validation rejects it first, before it ever reaches
`setattr()`. `NaN` is accepted by `setattr()` and only surfaces as an
invalid shape after recompute — Phase 14's `_is_finite_number()` check
rejects it before that point too. Writing a nonexistent property raises
`AttributeError` (never reached, since the allowlist check runs first).

**Before/after/requested semantics.** `EnvironmentAdapter.modifyObject`'s
result carries `metadata.propertyChanges: EnvironmentPropertyChange[]`
(`{key, before, requested, after}`) and `metadata.alreadySatisfied`. This
rides on the existing `EnvironmentOperationResult` metadata bag rather than
creating a second Change/History architecture — P2's `Change` model stays
bound to `WorldModelTransition` as it always was, and Phase 14 does not
force environment-only mutations into it. `requested` and `after` are
tracked separately and are **not** assumed equal: a real environment may
clamp or normalize a value, and callers (including P10/P11's proposal/
approval/execution audit trail) need to see what actually happened.

**Explicitly NOT implemented in Phase 14** (left for later phases, named
here so the boundary is unambiguous): checkpoint/rollback/undo (P15),
a deterministic verification engine distinguishing "command succeeded"
from "engineering objective satisfied" beyond the raw before/after values
(P16), unit-string parsing/conversion (values are plain numbers in the
document's existing units), arbitrary property writes or arbitrary object
creation/deletion, and any form of `eval`/`exec`/arbitrary Python or shell
execution.

## Scope (Phase 15): checkpoint/restore via real file copy

`capabilities` gains `"checkpoint"` (now `["save", "modify",
"checkpoint"]`). FreeCAD documents are already files on disk, so a
"snapshot" is a real, honest concept here — no fabricated pointer, no
in-memory diff engine.

**`op_checkpoint`** opens the live document once and immediately closes
it (rejecting a genuinely corrupt/unopenable file as a normal exception
here, rather than "snapshotting" garbage), generates an opaque id
(`uuid.uuid4().hex`), and `shutil.copy2`s the live `.FCStd` file into a
hidden sibling directory, `.naqsh_checkpoints/`, next to the document
itself (not a separately configured location — copy the project folder,
get its checkpoints too). Returns `{checkpointId}`.

**`op_restore`** looks up the snapshot file by id under
`.naqsh_checkpoints/`; a missing id returns `{"found": false}` (the same
shape `op_modify_object`/`op_inspect_object` already use for "no such
record"), never a generic exception. `shutil.copy2` either completes
wholesale or raises — there is no code path that leaves the live document
partially overwritten.

**Core never sees any of this.** `FreeCadAdapter.checkpoint()`/`.restore()`
call `runOperation("checkpoint"/"restore", ...)` and pass the returned
`checkpointId` straight through as an opaque string — the adapter (and
everything above it) never opens `.naqsh_checkpoints/`, never knows it's a
directory of `.FCStd` copies, never knows the word "FreeCAD" is involved
at all beyond `descriptor.kind`. `create`/`delete` remain unsupported —
Phase 15 adds recoverability, not object lifecycle management.

**Empirically confirmed against real FreeCAD 1.1.3:** a checkpoint/restore
round-trip genuinely reverts a real property mutation (`Length` set, then
checkpointed, mutated again, restored — the ORIGINAL value survives a
fresh `connect()` in a brand-new subprocess, proving persistence is real,
not an in-process artifact); restoring an unknown checkpoint id fails
deterministically with `object_not_found`.

**Deliberately NOT implemented in Phase 15:** any UI; automatic/background
checkpointing; a distributed content-addressed store (a plain SHA-256 hash
computed at the core layer is the whole integrity mechanism — this
directory has no hashing of its own); pruning/garbage-collecting old
checkpoint files (left for a future phase if it becomes a real problem);
`create`/`delete` capabilities.

## Testing

**Level 1** (`packages/adapters/test/freecad-adapter.test.ts`) — fully
deterministic, no FreeCAD required. `FreeCadAdapter`'s `runOperation` option
is injected with a fake implementation, so every test exercises the real
adapter logic (session tracking, capability gating, error mapping, object
validation) without ever spawning a process. Runs as part of the normal
`npm test`. Its `describe("createFreeCadAdapter: modifyObject (Phase 14)"
...)` block covers a genuine success (asserting the exact runtime call
made), a read-only/unsupported property rejection, and a stale-`expectedBefore`
rejection — against a fake runtime that mirrors FreeCAD's Quantity
read/write shape asymmetry but deliberately does **not** reimplement
FreeCAD's own range/NaN validation, since that behavior is only proven for
real in Level 2. Its `describe("createFreeCadAdapter: checkpoint/restore
(Phase 15)" ...)` block covers a genuine `checkpoint()` invocation and a
full checkpoint → mutate → restore round-trip against the fake runtime.

**Level 2**
(`packages/adapters/test/freecad-adapter.integration.test.ts`) — runs
against a **real** FreeCAD install. Resolves `freecadcmd` from
`NAQSH_FREECAD_CMD` (falls back to the bare `freecadcmd` command on `PATH`),
probes it once at test-file load time, and registers every test in the file
as `{ skip: <reason> }` if unavailable — this shows up as **skipped**, not
failed, in `node --test`'s own output, and the process exits `0`. Building
FreeCAD from source or installing it is NOT required to run the rest of the
test suite.

To run Level 2 for real:

```bash
NAQSH_FREECAD_CMD="/path/to/freecadcmd" \
  node --import tsx --test test/freecad-adapter.integration.test.ts
```

(On Windows, a typical path is
`C:\Program Files\FreeCAD 1.1\bin\freecadcmd.exe`.)

Level 2 builds several small, disposable fixture documents in the OS temp
directory per run and cleans them up afterward:
`fixtures/build_fixture.py` (one `Part::Box`),
`fixtures/build_relationship_fixture.py` (a `Part::Cut` with real
Base/Tool dependencies), `fixtures/build_inspection_fixture.py` (Phase
13's richer document: a `Group` and an `App::Part` each containing a
`Part::Box`, a `Part::Cut`, a `Sketcher::SketchObject`, and an `App::Link`
— exercises hierarchy, all three differentiated relationship types, generic
type classification, and geometry availability/unavailability against
real FreeCAD), and `fixtures/build_empty_fixture.py` (a genuinely empty
document, proving Phase 13 Step 18: an empty document is a valid,
non-crashing inspection target). It also runs the exact same reusable
`EnvironmentAdapter` contract-test suite
(`packages/core/src/environment-adapter-contract.ts`, already used by every
mock adapter, including its Phase 13 `inspectDocument()` block and Phase
14's stale-state/idempotency/`propertyChanges` mutation tests) against the
real adapter — the same call, unmodified, that already runs against
`createMockCadEnvironment`/`createMockSimulationEnvironment`/
`createMockEnvironment`.

Phase 14 adds three dedicated real-FreeCAD tests to this file: a genuine
`Length` mutation that is verified to persist across a fresh `connect()`
call in a new subprocess (and confirms a non-allowlisted `Placement` write
is rejected as `invalid_operation`, not `unsupported_capability`); a
value-validation test proving `NaN`, a negative length, an out-of-range
length, and a string-with-unit are all rejected as `invalid_operation`
**before** the document is touched (confirmed by re-inspecting and finding
`Length` unchanged); and an unsupported-target-type test against a real
`Sketcher::SketchObject`. `packages/core/test/modify-environment-object-tool.test.ts`
separately proves the P4 permission boundary end-to-end using the real,
unmodified `createApprovalStore`/`createAutonomyGrantStore`/
`createExecuteToolAuthorizer` machinery against the real
`modify_environment_object` tool: no approval, a wrong-scope approval, and
an explicitly rejected approval are each `policy_rejected` with no
mutation, while a genuine approval succeeds.

## Mock vs. real

`packages/adapters/src/mock-cad-environment.ts` (and its siblings) remain
the primary environment for unit tests, CI, and deterministic agent
evaluation — nothing about Phase 12 replaces or weakens them.
`FreeCadAdapter`'s `describe().kind` is `"freecad"` (vs. `"mock_cad"` /
`"mock"` / `"mock_simulation"`), so a caller can always tell which one it is
actually talking to. `health()` only ever reports `"healthy"` when it
genuinely reached a real FreeCAD process and parsed a real version string
back — there is no code path that fabricates a successful connection.
