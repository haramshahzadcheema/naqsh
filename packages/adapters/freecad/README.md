# FreeCAD runtime (Phase 12)

This directory is the **entire** FreeCAD-side surface NAQSH talks to. Nothing
under `packages/core` or `packages/schemas` may import anything here or
anything FreeCAD-related at all — enforced structurally by
`packages/core/test/repo-boundaries.test.ts`'s P12 guard block, not merely by
convention.

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
(`health`/`connect`/`list_objects`/`inspect_object`/`save`). There is no
`eval`/`exec` on request data anywhere in this directory, no operation that
accepts caller-supplied code, and no generic "run this Python" primitive.
Adding a new capability means adding a new named function to `OPERATIONS` —
there is no path for an agent or a model to reach an arbitrary-execution
surface through this boundary.

## Scope (Phase 12)

Implemented: `health`, `connect` (open + validate a `.FCStd` document),
`list_objects`, `inspect_object`, `save`. The adapter's declared
`capabilities` is exactly `["save"]` — `create`/`modify`/`delete`/
`checkpoint` are real, present `EnvironmentAdapter` methods (the interface
requires them unconditionally) but every one returns a structured
`unsupported_capability` result in this phase. No rollback/checkpoint
capability is claimed — FreeCAD document `save()` is a real, working
operation, but it is not a transactional checkpoint with restore.

Deliberately NOT implemented (Phase 13+ territory): creating objects,
modifying parameters, deleting objects, geometry generation, and
reconciling an observation back into NAQSH's `WorldModelState` (mapping a
FreeCAD `EnvironmentObjectId` to a World Model `EngineeringObject.id` and
interpreting properties as World Model facts is genuine adapter-specific
interpretation work — see `packages/schemas/src/environment-types.ts`'s own
header comment on why that reconciliation stays a separate, later concern).

## Testing

**Level 1** (`packages/adapters/test/freecad-adapter.test.ts`) — fully
deterministic, no FreeCAD required. `FreeCadAdapter`'s `runOperation` option
is injected with a fake implementation, so every test exercises the real
adapter logic (session tracking, capability gating, error mapping, object
validation) without ever spawning a process. Runs as part of the normal
`npm test`.

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

Level 2 builds a small, disposable fixture document
(`fixtures/build_fixture.py` — one `Part::Box`, deterministic, no
complicated CAD) in the OS temp directory for each run and cleans it up
afterward. It also runs the exact same reusable `EnvironmentAdapter`
contract-test suite (`packages/core/src/environment-adapter-contract.ts`,
already used by every mock adapter) against the real adapter — the same
call, unmodified, that already runs against `createMockCadEnvironment`/
`createMockSimulationEnvironment`/`createMockEnvironment`.

## Mock vs. real

`packages/adapters/src/mock-cad-environment.ts` (and its siblings) remain
the primary environment for unit tests, CI, and deterministic agent
evaluation — nothing about Phase 12 replaces or weakens them.
`FreeCadAdapter`'s `describe().kind` is `"freecad"` (vs. `"mock_cad"` /
`"mock"` / `"mock_simulation"`), so a caller can always tell which one it is
actually talking to. `health()` only ever reports `"healthy"` when it
genuinely reached a real FreeCAD process and parsed a real version string
back — there is no code path that fabricates a successful connection.
