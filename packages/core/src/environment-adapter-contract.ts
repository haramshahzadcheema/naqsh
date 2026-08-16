import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentDocumentInspection,
  assertEnvironmentOperationResult,
  type EnvironmentDocumentInspection,
  type EnvironmentObject,
  type EnvironmentSession
} from "@naqsh/schemas";
import { supportsCapability, type EnvironmentAdapter } from "./environment-adapter.js";

/** A property's OBSERVED value and the value a caller WRITES back are not
 * always the same shape (Phase 14 audit finding): a real adapter may
 * normalize a dimensional value for reading as `{value, unit}` (see
 * `normalize_value` in FreeCAD's runner.py) while `modifyObject` expects a
 * bare number for that same property (Phase 14's own documented, narrow
 * "no unit-string parsing" scope decision). This contract suite must stay
 * adapter-agnostic across BOTH shapes rather than assuming every writable
 * property accepts an arbitrary string, which is only true for permissive
 * mocks, not a real environment with genuine value-type constraints. */
function isQuantityShaped(value: unknown): value is { value: number; unit: string } {
  return typeof value === "object" && value !== null && "value" in value && typeof (value as { value: unknown }).value === "number";
}

/** A value genuinely different from `current`, in whatever shape a caller
 * is expected to WRITE for a property currently observed in this shape. */
function buildDistinctWriteValue(current: unknown): unknown {
  if (isQuantityShaped(current)) return current.value + 1;
  if (typeof current === "number") return current + 1;
  return `contract-test-${Date.now()}`;
}

/** The comparable core of an observed value -- unwraps a `{value, unit}`
 * shape to its bare number, otherwise returns the value unchanged. */
function comparableValue(value: unknown): unknown {
  return isQuantityShaped(value) ? value.value : value;
}

/**
 * THE reusable contract-test suite (P5 brief §7): call this once with a
 * factory for the adapter under test, and it registers a full
 * `describe`/`it` tree via `node:test` — the SAME tests, unmodified, that
 * a future `packages/adapters/test/freecad-environment.test.ts` will run
 * against `createFreeCADAdapter` once P12 exists. It is capability-aware
 * throughout: every optional operation is tested via "if the descriptor
 * declares this capability, prove it actually works end-to-end; otherwise
 * prove it fails with unsupported_capability" — never assumes a specific
 * capability profile, which is what makes it safe to run against adapters
 * as different as a full CAD mock and a modify-only simulation mock (see
 * packages/adapters).
 *
 * Lives in @naqsh/core's src/ (not test/) specifically so it is
 * importable across packages — @naqsh/adapters' own test files import it
 * the normal way, via `@naqsh/core`. It uses only `node:test`/
 * `node:assert`, the same zero-dependency primitives every test file in
 * this repo already uses; nothing about this file is a testing-framework
 * dependency beyond what the repo already has everywhere.
 */
export function runEnvironmentAdapterContractTests(
  label: string,
  createAdapter: () => EnvironmentAdapter | Promise<EnvironmentAdapter>
): void {
  describe(`EnvironmentAdapter contract: ${label}`, () => {
    it("describe() returns a valid, self-consistent descriptor", async () => {
      const adapter = await createAdapter();
      const descriptor = adapter.describe();
      assertEnvironmentDescriptor(descriptor);
      assert.equal(descriptor.kind.length > 0, true);
    });

    it("health() succeeds and reports EnvironmentHealth data, independent of any session", async () => {
      const adapter = await createAdapter();
      const result = await adapter.health();
      assertEnvironmentOperationResult(result);
      assert.equal(result.operation, "health");
      assert.equal(result.status, "success");
      const health = result.data as { status: string };
      assert.ok(["healthy", "degraded", "unavailable"].includes(health.status));
    });

    it("connect() succeeds and returns a connected session", async () => {
      const adapter = await createAdapter();
      const result = await adapter.connect();
      assertEnvironmentOperationResult(result);
      assert.equal(result.status, "success");
      const session = result.data as EnvironmentSession;
      assert.equal(session.status, "connected");
    });

    it("disconnect() succeeds on a connected session", async () => {
      const adapter = await createAdapter();
      const session = await connectOrThrow(adapter);
      const result = await adapter.disconnect(session);
      assertEnvironmentOperationResult(result);
      assert.equal(result.status, "success");
    });

    it("operating on a disconnected session fails deterministically with not_connected", async () => {
      const adapter = await createAdapter();
      const session = await connectOrThrow(adapter);
      await adapter.disconnect(session);
      const result = await adapter.listObjects(session);
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "not_connected");
    });

    it("listObjects() on a fresh session returns an array", async () => {
      const adapter = await createAdapter();
      const session = await connectOrThrow(adapter);
      const result = await adapter.listObjects(session);
      assertEnvironmentOperationResult(result);
      assert.equal(result.status, "success");
      assert.equal(Array.isArray(result.data), true);
    });

    it("listObjects() is deterministic across repeated calls with no mutation in between", async () => {
      const adapter = await createAdapter();
      const session = await connectOrThrow(adapter);
      const first = await adapter.listObjects(session);
      const second = await adapter.listObjects(session);
      assert.deepEqual(first.data, second.data);
    });

    it("inspectObject() on an unknown id fails deterministically with object_not_found", async () => {
      const adapter = await createAdapter();
      const session = await connectOrThrow(adapter);
      const result = await adapter.inspectObject(session, "does_not_exist");
      assert.equal(result.status, "error");
      assert.equal(result.error?.kind, "object_not_found");
    });

    describe("inspectDocument() (Phase 13)", () => {
      it("succeeds on a connected session and reports a self-consistent EnvironmentDocumentInspection", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const result = await adapter.inspectDocument(session);
        assertEnvironmentOperationResult(result);
        assert.equal(result.operation, "inspect_document");
        assert.equal(result.status, "success");
        const inspection = result.data as EnvironmentDocumentInspection;
        assertEnvironmentDocumentInspection(inspection);
        assert.equal(inspection.objectIds.length, inspection.objectCount);

        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        assert.equal(inspection.objectCount, objects.length);
        assert.deepEqual([...inspection.objectIds].sort(), objects.map((object) => object.id).sort());

        const rootIdSet = new Set(inspection.rootObjectIds);
        const objectIdSet = new Set(inspection.objectIds);
        for (const rootId of rootIdSet) {
          assert.ok(objectIdSet.has(rootId), "every rootObjectId must also be an objectId");
        }
      });

      it("fails deterministically with not_connected on a disconnected session", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        await adapter.disconnect(session);
        const result = await adapter.inspectDocument(session);
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "not_connected");
      });

      it("is deterministic across repeated calls with no mutation in between", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const first = await adapter.inspectDocument(session);
        const second = await adapter.inspectDocument(session);
        const firstData = first.data as EnvironmentDocumentInspection;
        const secondData = second.data as EnvironmentDocumentInspection;
        assert.deepEqual(firstData.objectIds, secondData.objectIds);
        assert.deepEqual(firstData.rootObjectIds, secondData.rootObjectIds);
        assert.equal(firstData.objectCount, secondData.objectCount);
      });
    });

    describe("create capability", () => {
      it("either creates a real, subsequently-inspectable object, or fails with unsupported_capability", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        const result = await adapter.createObject(session, { type: "part", name: "contract-test-object" });
        assertEnvironmentOperationResult(result);

        if (supportsCapability(descriptor, "create")) {
          assert.equal(result.status, "success");
          const created = result.data as EnvironmentObject;
          assert.equal(created.name, "contract-test-object");
          const reinspected = await adapter.inspectObject(session, created.id);
          assert.equal(reinspected.status, "success");
          assert.deepEqual((reinspected.data as EnvironmentObject).id, created.id);
        } else {
          assert.equal(result.status, "error");
          assert.equal(result.error?.kind, "unsupported_capability");
        }
      });
    });

    describe("modify capability", () => {
      it("either modifies a writable property end-to-end, or fails with unsupported_capability", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        assert.ok(objects.length > 0, "fixture adapters must seed at least one object for this test");
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        const newValue = buildDistinctWriteValue(writable.value);
        const result = await adapter.modifyObject(session, target.id, { [writable.key]: newValue });
        assertEnvironmentOperationResult(result);

        if (supportsCapability(descriptor, "modify")) {
          assert.equal(result.status, "success");
          const updated = result.data as EnvironmentObject;
          const changedProperty = updated.properties.find((property) => property.key === writable.key);
          assert.equal(comparableValue(changedProperty?.value), newValue);
        } else {
          assert.equal(result.status, "error");
          assert.equal(result.error?.kind, "unsupported_capability");
        }
      });

      it("modifying an unknown object fails with object_not_found when modify IS supported", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const result = await adapter.modifyObject(session, "does_not_exist", { x: 1 });
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "object_not_found");
      });

      it("a shape-invalid new value (non-JSON-safe) returns a structured error result and never throws/rejects, when modify IS supported", async () => {
        // Every EnvironmentAdapter method's whole contract is "never throw
        // for an expected failure" (see environment-adapter.ts). Malformed
        // input is an expected failure for ANY adapter, not just the
        // in-memory mocks -- this belongs in the reusable suite so a
        // future FreeCADAdapter is held to the same discipline, not just
        // whichever mock happened to get a hand-written test for it.
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        let result: Awaited<ReturnType<typeof adapter.modifyObject>>;
        try {
          result = await adapter.modifyObject(session, target.id, { [writable.key]: Number.NaN });
        } catch {
          assert.fail("modifyObject must return a structured error result for malformed input, not throw/reject");
        }
        assert.equal(result.status, "error");
      });

      it("Phase 14: reports propertyChanges (before/requested/after) in metadata on a successful modification", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        const beforeValue = comparableValue(writable.value);
        const newValue = buildDistinctWriteValue(writable.value);
        const result = await adapter.modifyObject(session, target.id, { [writable.key]: newValue });
        assert.equal(result.status, "success");
        const propertyChanges = result.metadata.propertyChanges as Array<{ key: string; before: unknown; requested: unknown; after: unknown }>;
        assert.ok(Array.isArray(propertyChanges), "successful modifyObject must report metadata.propertyChanges");
        const change = propertyChanges.find((candidate) => candidate.key === writable.key);
        assert.ok(change, `propertyChanges must include an entry for "${writable.key}"`);
        assert.deepEqual(change!.before, beforeValue);
        assert.deepEqual(change!.requested, newValue);
      });

      it("Phase 14 Step 16: a request whose value already matches the current value is reported as alreadySatisfied and still succeeds", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        const result = await adapter.modifyObject(session, target.id, { [writable.key]: comparableValue(writable.value) });
        assert.equal(result.status, "success");
        assert.equal(result.metadata.alreadySatisfied, true);
      });

      it("Phase 14 Step 14: expectedBefore matching the current value allows the mutation", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        const newValue = buildDistinctWriteValue(writable.value);
        const result = await adapter.modifyObject(session, target.id, { [writable.key]: newValue }, { expectedBefore: { [writable.key]: comparableValue(writable.value) } });
        assert.equal(result.status, "success");
      });

      it("Phase 14 Step 14: a stale expectedBefore (no longer matching the current value) rejects with conflict and mutates nothing", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "modify")) return;
        const listed = await adapter.listObjects(session);
        const objects = listed.data as EnvironmentObject[];
        const target = objects[0] as EnvironmentObject;
        const writable = target.properties.find((property) => !property.readOnly);
        assert.ok(writable, "fixture adapters must seed at least one writable property for this test");

        const result = await adapter.modifyObject(
          session,
          target.id,
          { [writable.key]: "this-should-not-apply" },
          { expectedBefore: { [writable.key]: "a-value-this-property-definitely-does-not-currently-have" } }
        );
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "conflict");

        const reinspected = await adapter.inspectObject(session, target.id);
        const unchangedProperty = (reinspected.data as EnvironmentObject).properties.find((property) => property.key === writable.key);
        assert.deepEqual(unchangedProperty?.value, writable.value);
      });
    });

    describe("delete capability", () => {
      it("either deletes an object end-to-end, or fails with unsupported_capability", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        const created = await adapter.createObject(session, { type: "part", name: "to-delete" });

        if (!supportsCapability(descriptor, "create")) {
          // Can't set up a target to delete; only prove delete itself
          // degrades correctly on a nonexistent id.
          const result = await adapter.deleteObject(session, "does_not_exist");
          assert.equal(result.status, "error");
          assert.ok(result.error?.kind === "unsupported_capability" || result.error?.kind === "object_not_found");
          return;
        }

        const objectId = (created.data as EnvironmentObject).id;
        const result = await adapter.deleteObject(session, objectId);
        assertEnvironmentOperationResult(result);

        if (supportsCapability(descriptor, "delete")) {
          assert.equal(result.status, "success");
          const reinspected = await adapter.inspectObject(session, objectId);
          assert.equal(reinspected.status, "error");
          assert.equal(reinspected.error?.kind, "object_not_found");
        } else {
          assert.equal(result.status, "error");
          assert.equal(result.error?.kind, "unsupported_capability");
        }
      });
    });

    describe("save capability", () => {
      it("either saves successfully, or fails with unsupported_capability", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        const result = await adapter.save(session);
        assertEnvironmentOperationResult(result);
        if (supportsCapability(descriptor, "save")) {
          assert.equal(result.status, "success");
        } else {
          assert.equal(result.status, "error");
          assert.equal(result.error?.kind, "unsupported_capability");
        }
      });
    });

    describe("checkpoint capability", () => {
      it("either round-trips a checkpoint/restore that actually reverts a change, or fails with unsupported_capability", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();

        const checkpointResult = await adapter.checkpoint(session);
        assertEnvironmentOperationResult(checkpointResult);

        if (!supportsCapability(descriptor, "checkpoint")) {
          assert.equal(checkpointResult.status, "error");
          assert.equal(checkpointResult.error?.kind, "unsupported_capability");
          return;
        }

        assert.equal(checkpointResult.status, "success");
        const { checkpointId } = checkpointResult.data as { checkpointId: string };

        const before = await adapter.listObjects(session);
        const beforeCount = (before.data as EnvironmentObject[]).length;

        if (supportsCapability(descriptor, "create")) {
          await adapter.createObject(session, { type: "part", name: "will-be-reverted" });
          const afterCreate = await adapter.listObjects(session);
          assert.equal((afterCreate.data as EnvironmentObject[]).length, beforeCount + 1);
        }

        const restoreResult = await adapter.restore(session, checkpointId);
        assert.equal(restoreResult.status, "success");

        const afterRestore = await adapter.listObjects(session);
        assert.equal((afterRestore.data as EnvironmentObject[]).length, beforeCount);
      });

      it("restoring an unknown checkpoint id fails deterministically when checkpoint IS supported", async () => {
        const adapter = await createAdapter();
        const session = await connectOrThrow(adapter);
        const descriptor = adapter.describe();
        if (!supportsCapability(descriptor, "checkpoint")) return;
        const result = await adapter.restore(session, "does_not_exist");
        assert.equal(result.status, "error");
        assert.equal(result.error?.kind, "object_not_found");
      });
    });
  });
}

async function connectOrThrow(adapter: EnvironmentAdapter): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  if (result.status !== "success") {
    throw new Error(`Fixture adapter failed to connect: ${result.error?.message ?? "unknown error"}`);
  }
  return result.data as EnvironmentSession;
}
