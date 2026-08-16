import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCheck, type EnvironmentObject, type EnvironmentSession } from "@naqsh/schemas";
import { buildEvidenceFromEnvironmentObject, evaluateCheck } from "@naqsh/core";
import { createFreeCadAdapter } from "../src/freecad-adapter.js";

/**
 * LEVEL 2 (Phase 16): real FreeCAD integration for deterministic
 * verification. Mirrors freecad-adapter.integration.test.ts's own
 * skip-if-unavailable discipline exactly -- runs ONLY when a real,
 * working `freecadcmd` can be invoked; otherwise every test is registered
 * `{ skip: <reason> }`, never silently omitted and never faked.
 *
 * This exercises the REAL pipeline: EnvironmentAdapter.inspectObject
 * (already-implemented P13 observation) -> buildEvidenceFromEnvironmentObject
 * (Phase 16 evidence) -> evaluateCheck (Phase 16's pure verifier) ->
 * VerificationResult -- against an actual FreeCAD document, not a mock.
 *
 * HONEST FINDING, not hidden: real FreeCAD reports a Quantity property's
 * value as a structured `{ value, unit }` object (see
 * freecad-adapter.integration.test.ts's own Length assertions), not a bare
 * number. Phase 16's numeric_comparison/bounds_check checks only
 * understand a plain finite number (see verify.ts) -- so verifying such a
 * property against real FreeCAD data correctly reports `inconclusive`/
 * `invalid_evidence_value`, never a fabricated PASS or FAIL. This is
 * exactly the "do not guess when evidence is in an unrecognized shape"
 * behavior Phase 16 requires, demonstrated against a REAL adapter, not
 * asserted in the abstract.
 */

const here = dirname(fileURLToPath(import.meta.url));
const runnerScriptPath = join(here, "..", "freecad", "runner.py");
const fixtureBuilderPath = join(here, "..", "freecad", "fixtures", "build_fixture.py");

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
  console.log(`[verification.integration.test.ts] SKIPPED: ${probe.reason}`);
}

describe("Phase 16 deterministic verification: LEVEL 2 real FreeCAD integration", { skip }, () => {
  function buildFixture(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "naqsh-freecad-verify-"));
    try {
      const path = join(dir, "fixture.FCStd");
      execFileSync(freecadCmdPath, [fixtureBuilderPath, path], { timeout: 30_000, windowsHide: true });
      return { dir, path };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  it("PASS/FAIL: object_exists against a real FreeCAD document, using genuinely observed evidence", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const existsCheck = createCheck({ kind: "object_exists", description: "Box must exist", objectId: "Box" });
      const boxInspection = await adapter.inspectObject(session, "Box");
      assert.equal(boxInspection.status, "success");
      const boxEvidence = buildEvidenceFromEnvironmentObject("Box", null, boxInspection.data as EnvironmentObject, {
        stateVersion: 1,
        environmentKind: session.environmentKind
      });
      const passResult = evaluateCheck(existsCheck, boxEvidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      assert.equal(passResult.status, "pass");

      const missingCheck = createCheck({ kind: "object_exists", description: "DoesNotExist must exist", objectId: "DoesNotExist" });
      const missingInspection = await adapter.inspectObject(session, "DoesNotExist");
      assert.equal(missingInspection.status, "error");
      assert.equal(missingInspection.error?.kind, "object_not_found");
      const missingEvidence = buildEvidenceFromEnvironmentObject("DoesNotExist", null, null, { stateVersion: 1, environmentKind: session.environmentKind });
      const failResult = evaluateCheck(missingCheck, missingEvidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      assert.equal(failResult.status, "fail");
      assert.equal(failResult.reasonKind, "object_not_found");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PASS: object_type and property_required against real, observed FreeCAD data", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;
      const inspected = await adapter.inspectObject(session, "Box");
      const object = inspected.data as EnvironmentObject;
      assert.equal(object.genericType, "solid"); // sanity check on the real adapter's own classification

      const typeCheck = createCheck({ kind: "object_type", description: "Box must be a solid", objectId: "Box", expectedGenericType: "solid" });
      const typeEvidence = buildEvidenceFromEnvironmentObject("Box", null, object, { stateVersion: 1, environmentKind: session.environmentKind });
      const typeResult = evaluateCheck(typeCheck, typeEvidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      assert.equal(typeResult.status, "pass");

      const propertyCheck = createCheck({ kind: "property_required", description: "Length must be present", objectId: "Box", property: "Length" });
      const propertyEvidence = buildEvidenceFromEnvironmentObject("Box", "Length", object, { stateVersion: 1, environmentKind: session.environmentKind });
      const propertyResult = evaluateCheck(propertyCheck, propertyEvidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      assert.equal(propertyResult.status, "pass");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("INCONCLUSIVE (honest, not fabricated): a numeric check against a real FreeCAD Quantity property, which is reported as a structured {value,unit} object, not a plain number", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;
      const inspected = await adapter.inspectObject(session, "Box");
      const object = inspected.data as EnvironmentObject;
      const lengthProperty = object.properties.find((property) => property.key === "Length");
      // Confirms the real shape this test is honestly demonstrating --
      // NOT a bare number.
      assert.equal(typeof lengthProperty!.value, "object");

      const check = createCheck({ kind: "numeric_comparison", description: "Length must equal 10mm", objectId: "Box", property: "Length", operator: "eq", expectedValue: 10 });
      const evidence = buildEvidenceFromEnvironmentObject("Box", "Length", object, { stateVersion: 1, environmentKind: session.environmentKind });
      const result = evaluateCheck(check, evidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      assert.equal(result.status, "inconclusive");
      assert.equal(result.reasonKind, "invalid_evidence_value");
      // Never silently promoted to pass/fail just because a number LOOKS
      // like it might be findable inside the structured value.
      assert.notEqual(result.status, "pass");
      assert.notEqual(result.status, "fail");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("PURITY: running verification never mutates the real FreeCAD document -- Length is byte-for-byte unchanged after several verify calls", async () => {
    const fixture = buildFixture();
    try {
      const adapter = createFreeCadAdapter({ freecadCmdPath, runnerScriptPath, defaultDocumentPath: fixture.path });
      const connectResult = await adapter.connect();
      const session = connectResult.data as EnvironmentSession;

      const before = await adapter.inspectObject(session, "Box");
      const beforeLength = (before.data as EnvironmentObject).properties.find((p) => p.key === "Length")!.value;

      for (const check of [
        createCheck({ kind: "object_exists", description: "x", objectId: "Box" }),
        createCheck({ kind: "object_type", description: "x", objectId: "Box", expectedGenericType: "solid" }),
        createCheck({ kind: "property_required", description: "x", objectId: "Box", property: "Length" }),
        createCheck({ kind: "numeric_comparison", description: "x", objectId: "Box", property: "Length", operator: "eq", expectedValue: 10 })
      ]) {
        const inspected = await adapter.inspectObject(session, "Box");
        const object = inspected.data as EnvironmentObject;
        const property = "property" in check ? check.property : null;
        const evidence = buildEvidenceFromEnvironmentObject("Box", property, object, { stateVersion: 1, environmentKind: session.environmentKind });
        evaluateCheck(check, evidence, { projectId: "proj_1", projectVersion: 1, environmentKind: session.environmentKind });
      }

      const after = await adapter.inspectObject(session, "Box");
      const afterLength = (after.data as EnvironmentObject).properties.find((p) => p.key === "Length")!.value;
      assert.deepEqual(afterLength, beforeLength);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
