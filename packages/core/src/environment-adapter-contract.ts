import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertEnvironmentDescriptor,
  assertEnvironmentOperationResult,
  type EnvironmentObject,
  type EnvironmentSession
} from "@naqsh/schemas";
import { supportsCapability, type EnvironmentAdapter } from "./environment-adapter.js";

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

        const newValue = `contract-test-${Date.now()}`;
        const result = await adapter.modifyObject(session, target.id, { [writable.key]: newValue });
        assertEnvironmentOperationResult(result);

        if (supportsCapability(descriptor, "modify")) {
          assert.equal(result.status, "success");
          const updated = result.data as EnvironmentObject;
          const changedProperty = updated.properties.find((property) => property.key === writable.key);
          assert.equal(changedProperty?.value, newValue);
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
