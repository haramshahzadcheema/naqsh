import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function resolveFreecadCmdPath(): string {
  return process.env.NAQSH_FREECAD_CMD ?? "freecadcmd";
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
      assert.deepEqual(inspected.data, objects[0]);

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

  it("create/modify/delete/checkpoint/restore are genuinely unsupported against the real adapter, not just the fake one", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const results = await Promise.all([
        adapter.createObject(session, { type: "Part::Box", name: "x" }),
        adapter.modifyObject(session, "Box", { Length: 99 }),
        adapter.deleteObject(session, "Box"),
        adapter.checkpoint(session),
        adapter.restore(session, "chk_1")
      ]);
      for (const result of results) {
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "unsupported_capability");
      }

      // Confirm the real document genuinely wasn't touched by any of the
      // (rejected) attempts above -- re-inspect and compare.
      const stillThere = await adapter.inspectObject(session, "Box");
      assert.equal(stillThere.status, "success");
      const lengthProperty = (stillThere.data as EnvironmentObject).properties.find((property) => property.key === "Length");
      assert.deepEqual(lengthProperty!.value, { value: 10, unit: "Unit: mm (1,0,0,0,0,0,0,0) [Length]" });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
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
