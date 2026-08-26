import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { runEnvironmentAdapterContractTests } from "@naqsh/core";
import { createFreeCadAdapter } from "../src/freecad-adapter.js";

/**
 * LEVEL 2 (Phase 12 Step 15/16): real FreeCAD integration tests. Runs ONLY
 * when a real, working `freecadcmd` can actually be invoked -- resolved
 * from `NAQSH_FREECAD_CMD`, then the bare `freecadcmd` command on PATH.
 * Never hardcodes a machine-specific install path (Phase 12 Step 3).
 *
 * If FreeCAD is unavailable, every test in this file is registered with
 * `{ skip: <reason> }` -- SKIPPED, not silently omitted and not failed.
 * This is what Phase 12 Step 15 means by "clearly distinguish skipped
 * integration tests from passing mock tests": `node --test` reports these
 * as skipped in its own summary, distinct from both "passed" (Level 1's
 * fake-runtime suite) and "failed".
 *
 * To run this suite for real:
 *   NAQSH_FREECAD_CMD="C:\Program Files\FreeCAD 1.1\bin\freecadcmd.exe" \
 *     node --import tsx --test test/freecad-adapter.integration.test.ts
 * (or just have `freecadcmd` on PATH). See packages/adapters/freecad/
 * README.md for full setup instructions.
 */

const here = dirname(fileURLToPath(import.meta.url));
const runnerScriptPath = join(here, "..", "freecad", "runner.py");
const fixtureBuilderPath = join(here, "..", "freecad", "fixtures", "build_fixture.py");
const relationshipFixtureBuilderPath = join(here, "..", "freecad", "fixtures", "build_relationship_fixture.py");
const inspectionFixtureBuilderPath = join(here, "..", "freecad", "fixtures", "build_inspection_fixture.py");
const emptyFixtureBuilderPath = join(here, "..", "freecad", "fixtures", "build_empty_fixture.py");

/** AUDIT FIX: this used to be `process.env.NAQSH_FREECAD_CMD ?? "freecadcmd"`
 * -- on a machine with a real FreeCAD install at the standard location but
 * NO `NAQSH_FREECAD_CMD` set (confirmed live on this exact repo's own dev
 * machine), that bare "freecadcmd" PATH-only fallback fails, `available`
 * comes back false, and this ENTIRE suite silently skips -- meaning this
 * LEVEL 2 real-FreeCAD test file never actually ran, even on hardware
 * capable of running it. Mirrors the identical fix in
 * apps/api/src/environmentDiscovery.ts's `candidateCommandPaths()` --
 * duplicated here (not imported) because packages/adapters must never
 * depend on apps/api (the opposite dependency direction from every other
 * import in this monorepo). */
function resolveFreecadCmdPath(): string {
  const candidates: string[] = [];
  const fromEnv = process.env.NAQSH_FREECAD_CMD;
  if (fromEnv) candidates.push(fromEnv);

  if (platform() === "win32") {
    for (const root of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      let entries: string[];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/^freecad\b/i.test(entry)) continue;
        candidates.push(join(root, entry, "bin", "freecadcmd.exe"));
      }
    }
  } else if (platform() === "darwin") {
    candidates.push("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd");
  } else {
    candidates.push("/usr/bin/freecadcmd", "/usr/local/bin/freecadcmd", "/snap/bin/freecad.freecadcmd");
  }

  candidates.push("freecadcmd");
  return candidates.find((candidate) => !/[\\/]/.test(candidate) || existsSync(candidate)) ?? "freecadcmd";
}

function probeFreecadAvailable(freecadCmdPath: string): { available: true } | { available: false; reason: string } {
  try {
    execFileSync(freecadCmdPath, [runnerScriptPath, Buffer.from(JSON.stringify({ operation: "health", params: {} })).toString("base64")], {
      timeout: 30_000,
      windowsHide: true
    });
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { available: false, reason: `FreeCAD is not available in this environment (${message.split("\n")[0]})` };
  }
}

const freecadCmdPath = resolveFreecadCmdPath();
const probe = probeFreecadAvailable(freecadCmdPath);
const skip = probe.available ? false : probe.reason;

if (!probe.available) {
  // A visible, unambiguous console line for whoever runs the suite --
  // distinct from a silent 0-tests-registered file, matching Step 15's
  // "do not make the entire project fail... clearly distinguish skipped".
  console.log(`[freecad-adapter.integration.test.ts] SKIPPED: ${probe.reason}`);
}

describe("FreeCAD adapter: LEVEL 2 real integration", { skip }, () => {
  function buildFixture(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-"));
    try {
      const path = join(dir, "fixture.FCStd");
      execFileSync(freecadCmdPath, [fixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      return { dir, path };
    } catch (error) {
      // RESOURCE LEAK REGRESSION: if fixture creation itself fails, `dir`
      // was already created by mkdtempSync above but this function never
      // returns it to a caller's try/finally -- clean it up here instead
      // of leaking a temp directory on every failed fixture build.
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  it("SMOKE TEST (Phase 12 Step 16): NAQSH -> EnvironmentAdapter -> FreeCAD -> EnvironmentAdapter -> NAQSH, end to end", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });

      const health = await adapter.health();
      assert.equal(health.status, "success");
      assert.match((health.data as { message: string }).message, /reachable/);

      const connectResult = await adapter.connect();
      assert.equal(connectResult.status, "success");
      const session = connectResult.data as EnvironmentSession;
      assert.equal(session.environmentKind, "freecad");
      assert.equal(session.status, "connected");

      const listed = await adapter.listObjects(session);
      assert.equal(listed.status, "success");
      const objects = listed.data as EnvironmentObject[];
      assert.equal(objects.length, 1);
      assert.equal(objects[0]!.id, "Box");
      assert.equal(objects[0]!.type, "Part::Box");
      assert.equal(objects[0]!.name, "Fixture Box");

      const lengthProperty = objects[0]!.properties.find((property) => property.key === "Length");
      assert.ok(lengthProperty, "expected a real Length property from the real FreeCAD object");
      assert.equal(lengthProperty!.readOnly, false);
      assert.deepEqual(lengthProperty!.value, { value: 10, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });

      const inspected = await adapter.inspectObject(session, "Box");
      assert.equal(inspected.status, "success");
      const inspectedObject = inspected.data as EnvironmentObject;
      // Phase 13 audit finding: listObjects() and inspectObject() are no
      // longer expected to be byte-identical -- listObjects() (the object
      // INVENTORY tier) deliberately skips per-object geometry computation
      // to stay cheap for a real, large document (see runner.py's
      // object_to_dict()), while inspectObject() (single-object DETAIL
      // tier) always computes it. Compare everything else field-by-field
      // instead of one blanket deepEqual.
      assert.deepEqual({ ...inspectedObject, geometry: undefined }, { ...objects[0]!, geometry: undefined });
      assert.equal(objects[0]!.geometry.available, false);
      assert.equal(objects[0]!.geometry.reason, "not_requested_in_listing");
      assert.equal(inspectedObject.geometry.available, true);
      assert.ok(inspectedObject.geometry.volume !== null && inspectedObject.geometry.volume > 0);

      const missing = await adapter.inspectObject(session, "DoesNotExist");
      assert.equal(missing.status, "error");
      assert.equal(missing.error?.kind, "object_not_found");

      const saveResult = await adapter.save(session);
      assert.equal(saveResult.status, "success");

      const disconnectResult = await adapter.disconnect(session);
      assert.equal(disconnectResult.status, "success");

      const afterDisconnect = await adapter.listObjects(session);
      assert.equal(afterDisconnect.status, "error");
      assert.equal(afterDisconnect.error?.kind, "not_connected");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("maps a REAL FreeCAD dependency relationship (OutList) into EnvironmentObject.relationships (Phase 12 Step 9)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-rel-"));
    const path = join(dir, "relationship-fixture.FCStd");
    try {
      execFileSync(freecadCmdPath, [relationshipFixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: path });
      const connectResult = await adapter.connect();
      assert.equal(connectResult.status, "success");
      const session = connectResult.data as EnvironmentSession;

      const inspected = await adapter.inspectObject(session, "Cut");
      assert.equal(inspected.status, "success");
      const cut = inspected.data as EnvironmentObject;
      assert.equal(cut.type, "Part::Cut");
      // Real FreeCAD's own OutList -- confirmed empirically, never
      // fabricated by this adapter: a Part::Cut referencing two boxes via
      // Base/Tool always reports both in OutList.
      const targetIds = cut.relationships.map((relationship) => relationship.targetId).sort();
      assert.deepEqual(targetIds, ["Box1", "Box2"]);
      assert.ok(cut.relationships.every((relationship) => relationship.type === "references"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SECURITY/TRUTHFULNESS: connecting to a genuinely nonexistent document fails with a real, structured error", async () => {
    const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath });
    const result = await adapter.connect({ filePath: join(tmpdir(), "naqsh-does-not-exist-xyz.FCStd") });
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "environment_failure");
  });

  it("delete remains genuinely unsupported against the real adapter -- create was fixed live (see createObject tests below), delete is still unimplemented", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.deleteObject(session, "Box");
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "unsupported_capability");

      // Confirm the real document genuinely wasn't touched by the
      // (rejected) attempt above -- re-inspect and compare.
      const stillThere = await adapter.inspectObject(session, "Box");
      assert.equal(stillThere.status, "success");
      const lengthProperty = (stillThere.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.deepEqual(lengthProperty!.value, { value: 10, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("AUDIT FIX: createObject genuinely creates a NEW Part::Box in a real FreeCAD document, saved to disk, subsequently inspectable, and modifiable afterward", async () => {
    // Reproduced live: a real, freshly-connected FreeCAD document with no
    // pre-existing geometry could never receive any -- createObject always
    // failed with unsupported_capability regardless of what was asked.
    // This is the real, end-to-end proof the fix works: no fake runtime,
    // no injected fixture object, a real freecadcmd subprocess creating
    // real geometry in a real .FCStd file on disk.
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const created = await adapter.createObject(session, {
        type: "part",
        name: "Bracket Envelope",
        properties: [
          { key: "Length", value: 100, readOnly: false },
          { key: "Width", value: 60, readOnly: false },
          { key: "Height", value: 20, readOnly: false }
        ]
      });
      assert.equal(created.status, "success", JSON.stringify(created));
      const object = created.data as EnvironmentObject;
      assert.equal(object.name, "Bracket Envelope");
      assert.equal(object.type, "Part::Box");

      // Reconnect (a fresh subprocess, fresh document open) to prove this
      // was genuinely SAVED to disk, not just an in-memory response.
      const reconnected = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const reconnectedSession = (await reconnected.connect()).data as EnvironmentSession;
      const reinspected = await reconnected.inspectObject(reconnectedSession, object.id);
      assert.equal(reinspected.status, "success");
      const lengthProperty = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.equal((lengthProperty!.value as { value: number }).value, 100);

      // The created object is genuinely modifiable afterward -- the exact
      // real-world sequence a demo actually needs: create, then refine.
      const modified = await reconnected.modifyObject(reconnectedSession, object.id, { Length: 90 });
      assert.equal(modified.status, "success", JSON.stringify(modified));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("AUDIT FIX: engineering vocabulary (\"Thickness\") genuinely maps onto Part::Box's own Height -- the real property-name mismatch that failed every live build", async () => {
    // Reproduced live from a real failed build: a generated design
    // specification described the envelope as
    // {Length: 100, Width: 60, Thickness: 20}. "Thickness" is ordinary
    // engineering vocabulary for exactly the dimension Part::Box calls
    // "Height", but the adapter passed the caller's word through
    // unchanged, runner.py's SUPPORTED_MUTATIONS allowlist correctly
    // refused an unknown property, and the whole build failed -- over a
    // naming mismatch, not a real disagreement about the geometry. This
    // proves the translation is real, against a real FreeCAD subprocess,
    // by reading back the resulting solid's actual Height.
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const session = (await adapter.connect()).data as EnvironmentSession;

      const created = await adapter.createObject(session, {
        type: "part",
        name: "Vocabulary Envelope",
        properties: [
          { key: "Length", value: 100, readOnly: false },
          { key: "Width", value: 60, readOnly: false },
          { key: "Thickness", value: 20, readOnly: false }
        ]
      });
      assert.equal(created.status, "success", JSON.stringify(created));

      const object = created.data as EnvironmentObject;
      const height = object.properties.find((property) => property.key === "Height");
      assert.ok(height, "expected the created solid to carry a real Height property");
      assert.equal((height!.value as { value: number }).value, 20, "\"Thickness: 20\" must land on the real Part::Box Height");

      // The same translation must hold on the modify path, not just create.
      const modified = await adapter.modifyObject(session, object.id, { Thickness: 12 });
      assert.equal(modified.status, "success", JSON.stringify(modified));
      const after = (modified.data as EnvironmentObject).properties.find((property) => property.key === "Height");
      assert.equal((after!.value as { value: number }).value, 12);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("builds a real car tyre as a Part::Torus, from ordinary words -- \"tyre\", \"ringRadius\", \"thickness\"", async () => {
    // A tyre is a torus, not a box: Radius1 is the ring radius (how big
    // the wheel is) and Radius2 the tube radius (how fat the tyre is).
    // Dimensions are a real 195/65 R15: ~635 mm overall diameter,
    // ~127 mm section height.
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const session = (await adapter.connect()).data as EnvironmentSession;

      const created = await adapter.createObject(session, {
        type: "tyre",
        name: "Front Tyre",
        properties: [
          { key: "ringRadius", value: 253, readOnly: false },
          { key: "thickness", value: 64, readOnly: false }
        ]
      });
      assert.equal(created.status, "success", JSON.stringify(created));
      const object = created.data as EnvironmentObject;
      assert.equal(object.type, "Part::Torus", "\"tyre\" must resolve to a torus, never fall through to the box default");

      const ring = object.properties.find((property) => property.key === "Radius1");
      const tube = object.properties.find((property) => property.key === "Radius2");
      assert.equal((ring!.value as { value: number }).value, 253);
      assert.equal((tube!.value as { value: number }).value, 64);

      // Genuinely persisted, not just echoed back.
      const reconnected = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const reconnectedSession = (await reconnected.connect()).data as EnvironmentSession;
      const reinspected = await reconnected.inspectObject(reconnectedSession, object.id);
      assert.equal(reinspected.status, "success");
      assert.equal((reinspected.data as EnvironmentObject).type, "Part::Torus");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("builds a real wheel rim as a Part::Cylinder, and refuses the genuinely ambiguous \"width\"", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const session = (await adapter.connect()).data as EnvironmentSession;

      const rim = await adapter.createObject(session, {
        type: "wheel rim",
        name: "Front Rim",
        properties: [
          { key: "radius", value: 190, readOnly: false },
          { key: "height", value: 160, readOnly: false }
        ]
      });
      assert.equal(rim.status, "success", JSON.stringify(rim));
      assert.equal((rim.data as EnvironmentObject).type, "Part::Cylinder");

      // "width" on a cylinder could mean the diameter OR the axial
      // length. Guessing either way would silently build the wrong part
      // and report success, so it is refused instead -- the same reason
      // "diameter" is deliberately not a synonym for "radius" anywhere.
      const ambiguous = await adapter.createObject(session, {
        type: "cylinder",
        name: "Ambiguous",
        properties: [{ key: "width", value: 50, readOnly: false }]
      });
      assert.equal(ambiguous.status, "error");
      assert.equal(ambiguous.error?.kind, "invalid_operation");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("AUDIT FIX: createObject rejects a type it cannot map to a real FreeCAD type -- honest failure, never a silently-wrong object", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.createObject(session, { type: "sketch", name: "x" });
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "invalid_operation");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 14: modifyObject genuinely mutates a real FreeCAD document for an allowlisted property, and persists across reconnect", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.modifyObject(session, "Box", { Length: 42 });
      assert.equal(result.status, "success");
      const updated = result.data as EnvironmentObject;
      const lengthProperty = updated.properties.find((property) => property.key === "Length");
      assert.deepEqual(lengthProperty!.value, { value: 42, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });
      const propertyChanges = result.metadata.propertyChanges as Array<{ key: string; before: unknown; requested: unknown; after: unknown }>;
      assert.deepEqual(propertyChanges, [{ key: "Length", before: 10, requested: 42, after: 42 }]);
      assert.equal(result.metadata.alreadySatisfied, false);

      // Persistence (Phase 14 Step 10): a genuinely NEW connect() (fresh
      // subprocess) still sees 42 -- op_modify_object's own doc.save()
      // actually happened, this isn't just an in-memory artifact of the
      // single call above.
      const reconnected = await adapter.connect({ filePath: fixture.path });
      const reconnectedSession = reconnected.data as EnvironmentSession;
      const reinspected = await adapter.inspectObject(reconnectedSession, "Box");
      const reinspectedLength = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.deepEqual(reinspectedLength!.value, { value: 42, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });

      // A non-allowlisted property is rejected as invalid_operation, NOT
      // unsupported_capability -- the capability itself is genuinely
      // supported; this specific property simply isn't in Phase 14 Step
      // 8's narrow allowlist.
      const rejected = await adapter.modifyObject(reconnectedSession, "Box", { Placement: "somewhere" });
      assert.equal(rejected.status, "error");
      assert.equal(rejected.error?.kind, "invalid_operation");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 14: value validation happens BEFORE anything reaches FreeCAD -- NaN, negative/out-of-range, and non-numeric values are all rejected, never silently clamped or invalidated by FreeCAD itself", async () => {
    // FreeCAD itself does NOT reject these the way a naive implementation
    // might assume: a negative Part::Box.Length is silently CLAMPED to 0
    // (confirmed empirically), and a NaN Length is accepted outright, only
    // surfacing as an invalid Shape after recompute. Permanent regression
    // coverage for exactly the class of bug Phase 14 Step 9 warns about --
    // this was previously only checked via a throwaway probe script during
    // development, never a durable test.
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const nanResult = await adapter.modifyObject(session, "Box", { Length: Number.NaN });
      assert.equal(nanResult.status, "error");
      assert.equal(nanResult.error?.kind, "invalid_operation");

      const negativeResult = await adapter.modifyObject(session, "Box", { Length: -5 });
      assert.equal(negativeResult.status, "error");
      assert.equal(negativeResult.error?.kind, "invalid_operation");

      const tooLargeResult = await adapter.modifyObject(session, "Box", { Length: 999_999_999 });
      assert.equal(tooLargeResult.status, "error");
      assert.equal(tooLargeResult.error?.kind, "invalid_operation");

      // A unit-bearing STRING (the read-side shape for a Quantity
      // property) is not accepted on write -- Phase 14 Step 1's own
      // documented scope decision: a caller supplies a bare number in the
      // property's current unit, never a unit string to parse/convert.
      const stringWithUnitResult = await adapter.modifyObject(session, "Box", { Length: "25 mm" as unknown as number });
      assert.equal(stringWithUnitResult.status, "error");
      assert.equal(stringWithUnitResult.error?.kind, "invalid_operation");

      // None of the rejected attempts above actually touched the document.
      const stillOriginal = await adapter.inspectObject(session, "Box");
      const lengthProperty = (stillOriginal.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.deepEqual(lengthProperty!.value, { value: 10, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 14 AUDIT FIX: modifyObject with an empty changes object is a genuine no-op -- it must never fall through to an unconditional doc.save() with nothing actually requested", async () => {
    // Regression for a real bug found during the Phase 14 audit:
    // op_modify_object's idempotency short-circuit was originally guarded
    // by `if changes and all(...)`, so an EMPTY `changes` dict (falsy in
    // Python) skipped that safe early-return entirely and fell through to
    // an unconditional doc.recompute()/doc.save() -- a real, needless disk
    // write reported as a "successful" mutation despite changing nothing.
    // `all()` of an empty generator is `True`, so the fix makes an empty
    // request take the SAME safe, no-mutation path as any other
    // already-satisfied request (matching in-memory-environment.ts's own
    // `[].every(...) === true` behavior for zero requested changes).
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.modifyObject(session, "Box", {});
      assert.equal(result.status, "success");
      assert.equal(result.metadata.alreadySatisfied, true);
      assert.deepEqual(result.metadata.propertyChanges, []);

      const reinspected = await adapter.inspectObject(session, "Box");
      const lengthProperty = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.deepEqual(lengthProperty!.value, { value: 10, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 14: an unsupported target type (a real Sketch, not just an unknown id) is rejected as invalid_operation, never unsupported_capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-p14-target-"));
    const path = join(dir, "inspection-fixture.FCStd");
    try {
      execFileSync(freecadCmdPath, [inspectionFixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.modifyObject(session, "Sketch", { Length: 5 });
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "invalid_operation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PHASE 15: checkpoint()/restore() are a REAL file-copy snapshot -- the on-disk document genuinely reverts, surviving a fresh reconnect", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const checkpointResult = await adapter.checkpoint(session);
      assert.equal(checkpointResult.status, "success");
      const { checkpointId } = checkpointResult.data as { checkpointId: string };
      assert.ok(checkpointId.length > 0);

      const mutateResult = await adapter.modifyObject(session, "Box", { Length: 77 });
      assert.equal(mutateResult.status, "success");
      const afterMutate = await adapter.inspectObject(session, "Box");
      assert.deepEqual((afterMutate.data as EnvironmentObject).properties.find((p) => p.key === "Length")!.value, {
        value: 77,
        unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]"
      });

      const restoreResult = await adapter.restore(session, checkpointId);
      assert.equal(restoreResult.status, "success");

      // A genuinely NEW connect() (fresh subprocess) still sees the
      // reverted value -- proves the restore is a real, persisted file
      // operation, not an in-memory artifact of this one call.
      const reconnected = await adapter.connect({ filePath: fixture.path });
      const reconnectedSession = reconnected.data as EnvironmentSession;
      const afterRestore = await adapter.inspectObject(reconnectedSession, "Box");
      assert.deepEqual((afterRestore.data as EnvironmentObject).properties.find((p) => p.key === "Length")!.value, {
        value: 10,
        unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]"
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 15: restoring an unknown checkpoint id fails deterministically with object_not_found, never a false success", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;
      const result = await adapter.restore(session, "not_a_real_checkpoint_id");
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "object_not_found");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 15 AUDIT FIX: a path-traversal checkpointId is rejected as object_not_found, never used to construct a filesystem path -- the live document is untouched", async () => {
    // Regression for a real vulnerability found during the Phase 15 audit:
    // runner.py's op_restore originally joined `checkpointId` directly
    // into a filesystem path with no validation. A real
    // `EnvironmentAdapter.restore()` caller is trusted to only ever pass
    // a server-generated id, but the runner script itself must not rely
    // on that -- this proves a `../`-laden id is safely rejected, not
    // used to read/overwrite an arbitrary file on disk.
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const beforeContent = readFileSync(fixture.path);

      for (const maliciousId of ["../../../../etc/passwd", "..\\..\\..\\Windows\\System32\\config\\SAM", "a/b", "not-hex-but-32-characters-long!!", ""]) {
        const result = await adapter.restore(session, maliciousId);
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "object_not_found");
      }

      // The live document must be byte-for-byte untouched by every
      // rejected attempt above.
      const afterContent = readFileSync(fixture.path);
      assert.ok(beforeContent.equals(afterContent), "the live document must not be modified by a rejected restore() call");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PHASE 13: hierarchy, differentiated relationships, generic types, and geometry all reflect what a real FreeCAD document actually reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-inspect-"));
    const path = join(dir, "inspection-fixture.FCStd");
    try {
      execFileSync(freecadCmdPath, [inspectionFixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const listed = await adapter.listObjects(session);
      assert.equal(listed.status, "success");
      const objects = listed.data as EnvironmentObject[];
      const byId = new Map(objects.map((object) => [object.id, object]));

      // Hierarchy (Step 5/10): Box1 is contained by Group, Box2 by Assembly
      // -- confirmed via FreeCAD's own `.Group` property, never inferred.
      assert.equal(byId.get("Box1")!.parentId, "Group");
      assert.equal(byId.get("Box2")!.parentId, "Assembly");
      assert.equal(byId.get("Cut")!.parentId, null);

      // Relationship differentiation (Step 9/11): containment, link, and
      // generic dependency are all distinct types, not collapsed into one.
      const groupRelationships = byId.get("Group")!.relationships;
      assert.ok(groupRelationships.some((relationship) => relationship.type === "contains" && relationship.targetId === "Box1"));

      const linkRelationships = byId.get("MyLink")!.relationships;
      assert.deepEqual(
        linkRelationships.map((relationship) => relationship.type),
        ["links_to"]
      );
      assert.equal(linkRelationships[0]!.targetId, "Box1");

      const cutRelationships = byId.get("Cut")!.relationships;
      assert.deepEqual(
        cutRelationships.map((relationship) => relationship.targetId).sort(),
        ["Box1", "Box2"]
      );
      assert.ok(cutRelationships.every((relationship) => relationship.type === "references"));

      // Generic type classification (Step 6): reliable, mechanism-based.
      assert.equal(byId.get("Box1")!.genericType, "solid");
      assert.equal(byId.get("Cut")!.genericType, "solid");
      assert.equal(byId.get("Sketch")!.genericType, "sketch");
      assert.equal(byId.get("Group")!.genericType, "container");
      assert.equal(byId.get("Assembly")!.genericType, "container");
      assert.equal(byId.get("MyLink")!.genericType, "link");

      // Geometry via listObjects (Step 22 audit finding): the object
      // INVENTORY tier deliberately does NOT compute per-object geometry
      // -- a real document could have hundreds of complex solids, and
      // recomputing bounding box/volume/area/topology for every one of
      // them on every listing call would not "degrade predictably". Every
      // object reports available:false with an honest, distinct reason
      // (never confused with "this object genuinely has no shape").
      for (const object of objects) {
        assert.equal(object.geometry.available, false);
        assert.equal(object.geometry.reason, "not_requested_in_listing");
      }

      // Geometry via inspectObject (Step 12): the single-object DETAIL
      // tier always computes it -- a real solid reports real bounded
      // metrics; a Sketch's Shape exists but is invalid, so geometry is
      // honestly unavailable rather than a fabricated/garbage value.
      const box1Detail = (await adapter.inspectObject(session, "Box1")).data as EnvironmentObject;
      assert.equal(box1Detail.geometry.available, true);
      assert.ok(box1Detail.geometry.volume !== null && box1Detail.geometry.volume > 0);
      assert.equal(box1Detail.geometry.solidCount, 1);
      const sketchDetail = (await adapter.inspectObject(session, "Sketch")).data as EnvironmentObject;
      assert.equal(sketchDetail.geometry.available, false);
      assert.equal(sketchDetail.geometry.reason, "invalid_shape");

      // Object-level provenance (Step 17): every object is identifiable as
      // FreeCAD-observed data, stamped by the adapter, not fabricated by
      // runner.py.
      const provenance = byId.get("Box1")!.metadata.provenance as { environmentKind: string };
      assert.equal(provenance.environmentKind, "freecad");

      // Determinism (Step 14): a second, unmutated listObjects call
      // produces byte-for-byte identical data, not just identical ordering
      // -- proves provenance carries no live per-call timestamp either.
      const listedAgain = await adapter.listObjects(session);
      assert.deepEqual(listedAgain.data, objects);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PHASE 13: inspectDocument reports real document identity, object count/ids, and hierarchy roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-inspectdoc-"));
    const path = join(dir, "inspection-fixture.FCStd");
    try {
      execFileSync(freecadCmdPath, [inspectionFixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const result = await adapter.inspectDocument(session);
      assert.equal(result.status, "success");
      const inspection = result.data as {
        environmentKind: string;
        documentId: string | null;
        objectCount: number;
        objectIds: string[];
        rootObjectIds: string[];
        environmentVersion: string | null;
      };
      assert.equal(inspection.environmentKind, "freecad");
      // DISCOVERED, DOCUMENTED LIMITATION (Phase 13 Step 5): FreeCAD does
      // NOT preserve a document's internal `.Name` across a save/reopen
      // cycle -- confirmed empirically. This fixture was created as
      // `FreeCAD.newDocument("NaqshInspectionFixture")` but `_open()`
      // reopens it via `FreeCAD.openDocument(path)`, and FreeCAD assigns a
      // NEW internal Name derived from the file's own basename at that
      // point ("inspection-fixture.FCStd" -> "inspection_fixture"). This
      // adapter must not claim (and this test must not assume) a stronger
      // document-identity guarantee than FreeCAD actually provides -- only
      // that `documentId` is a real, non-empty, adapter-truthful value.
      assert.ok(typeof inspection.documentId === "string" && inspection.documentId.length > 0);
      // objectCount/objectIds intentionally NOT asserted as an exact closed
      // list: App::Part (Assembly) auto-creates its own Origin sub-tree
      // (Origin + 3 axes + 3 planes + 1 point) as real, separate document
      // objects -- confirmed empirically. Asserting our 7 explicit objects
      // are a SUBSET is the honest, version-resilient check.
      assert.equal(inspection.objectCount, inspection.objectIds.length);
      const explicitObjects = ["Assembly", "Box1", "Box2", "Cut", "Group", "MyLink", "Sketch"];
      for (const id of explicitObjects) {
        assert.ok(inspection.objectIds.includes(id), `expected objectIds to include "${id}"`);
      }
      // Box1/Box2 are contained (not roots); Group/Assembly/Cut/Sketch/MyLink are.
      for (const id of ["Group", "Assembly", "Cut", "Sketch", "MyLink"]) {
        assert.ok(inspection.rootObjectIds.includes(id), `expected rootObjectIds to include "${id}"`);
      }
      assert.ok(!inspection.rootObjectIds.includes("Box1"));
      assert.ok(!inspection.rootObjectIds.includes("Box2"));
      assert.match(inspection.environmentVersion ?? "", /^1\.1\.3/);

      // Determinism: a second call reflects the same, unmutated document.
      const again = await adapter.inspectDocument(session);
      assert.deepEqual((again.data as { objectIds: string[] }).objectIds, inspection.objectIds);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PHASE 13: an empty document is a valid, non-crashing inspection target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-empty-"));
    const path = join(dir, "empty.FCStd");
    try {
      execFileSync(freecadCmdPath, [emptyFixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: path });
      const connectResult = await adapter.connect();
      assert.equal(connectResult.status, "success");
      const session = connectResult.data as EnvironmentSession;

      const listed = await adapter.listObjects(session);
      assert.equal(listed.status, "success");
      assert.deepEqual(listed.data, []);

      const inspection = await adapter.inspectDocument(session);
      assert.equal(inspection.status, "success");
      const data = inspection.data as { objectCount: number; objectIds: string[]; rootObjectIds: string[] };
      assert.equal(data.objectCount, 0);
      assert.deepEqual(data.objectIds, []);
      assert.deepEqual(data.rootObjectIds, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `runEnvironmentAdapterContractTests` calls `describe`/`it` itself to
  // register its own nested suite -- this MUST happen at this file's
  // collection time (sibling to the `it(...)` calls above), never from
  // inside an `it()` callback, since node:test registers all tests before
  // running any of them. The fixture it needs is built once, synchronously,
  // right here (only when FreeCAD is genuinely available -- `skip` being
  // set means this whole `describe` body still runs during collection, but
  // every registered test underneath is marked skipped rather than
  // executed, so building a fixture here when unavailable would be wasted
  // work at best; guarded below).
  if (probe.available) {
    const contractFixture = buildFixture();
    after(() => rmSync(contractFixture.dir, { recursive: true, force: true }));
    runEnvironmentAdapterContractTests("freecad (real FreeCAD)", () =>
      createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: contractFixture.path })
    );
  }
});
