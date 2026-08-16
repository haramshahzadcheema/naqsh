import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnvironmentObject, EnvironmentSession } from "@naqsh/schemas";
import { createMockEnvironment } from "../src/mock-environment.js";
import { createCheckpointFaultController } from "../src/in-memory-environment.js";

/**
 * Phase 15's deterministic test environment: extends the SAME canonical
 * mock (`createMockEnvironment`, P6) every earlier phase already tests
 * against, via the fault-injection controller Phase 15 adds to
 * `in-memory-environment.ts`. Proves the mock genuinely supports:
 * successful snapshot/restore, restore failure simulation, and
 * mismatched-restore simulation -- "the mock must not be magically more
 * permissive than real FreeCAD" (Phase 15 brief).
 */

async function connect(adapter: ReturnType<typeof createMockEnvironment>): Promise<EnvironmentSession> {
  const result = await adapter.connect();
  return result.data as EnvironmentSession;
}

describe("Mock environment checkpoint/restore: genuine round-trip (Phase 15)", () => {
  it("checkpoint() then restore() reverts a real mutation", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const objects = (await adapter.listObjects(session)).data as EnvironmentObject[];
    const targetId = objects[0]!.id;
    const writableKey = objects[0]!.properties.find((property) => !property.readOnly)!.key;
    const originalValue = objects[0]!.properties.find((property) => property.key === writableKey)!.value;

    const checkpointResult = await adapter.checkpoint(session);
    assert.equal(checkpointResult.status, "success");
    const { checkpointId } = checkpointResult.data as { checkpointId: string };

    await adapter.modifyObject(session, targetId, { [writableKey]: "a genuinely different value" });
    const mutated = await adapter.inspectObject(session, targetId);
    assert.notDeepEqual((mutated.data as EnvironmentObject).properties.find((p) => p.key === writableKey)!.value, originalValue);

    const restoreResult = await adapter.restore(session, checkpointId);
    assert.equal(restoreResult.status, "success");
    const restored = await adapter.inspectObject(session, targetId);
    assert.deepEqual((restored.data as EnvironmentObject).properties.find((p) => p.key === writableKey)!.value, originalValue);
  });
});

describe("Mock environment checkpoint/restore: fault injection (Phase 15)", () => {
  it("failNextCheckpoint: the NEXT checkpoint() call fails, then the flag consumes itself (later calls succeed normally)", async () => {
    const faults = createCheckpointFaultController();
    const adapter = createMockEnvironment({ checkpointFaults: faults });
    const session = await connect(adapter);

    faults.failNextCheckpoint = true;
    const first = await adapter.checkpoint(session);
    assert.equal(first.status, "error");
    assert.equal(first.error?.kind, "environment_failure");
    // The flag consumed itself -- a second attempt succeeds normally.
    assert.equal(faults.failNextCheckpoint, false);
    const second = await adapter.checkpoint(session);
    assert.equal(second.status, "success");
  });

  it("failNextRestore: the NEXT restore() call fails and mutates nothing, then the flag consumes itself", async () => {
    const faults = createCheckpointFaultController();
    const adapter = createMockEnvironment({ checkpointFaults: faults });
    const session = await connect(adapter);
    const checkpointResult = await adapter.checkpoint(session);
    const { checkpointId } = checkpointResult.data as { checkpointId: string };

    faults.failNextRestore = true;
    const failed = await adapter.restore(session, checkpointId);
    assert.equal(failed.status, "error");
    assert.equal(failed.error?.kind, "environment_failure");
    assert.equal(faults.failNextRestore, false);

    const succeeded = await adapter.restore(session, checkpointId);
    assert.equal(succeeded.status, "success");
  });

  it("corruptNextRestore: restore() reports SUCCESS without actually applying the snapshot -- the mismatch a caller-side re-observation must catch", async () => {
    const faults = createCheckpointFaultController();
    const adapter = createMockEnvironment({ checkpointFaults: faults });
    const session = await connect(adapter);
    const objects = (await adapter.listObjects(session)).data as EnvironmentObject[];
    const targetId = objects[0]!.id;
    const writableKey = objects[0]!.properties.find((property) => !property.readOnly)!.key;
    const originalValue = objects[0]!.properties.find((property) => property.key === writableKey)!.value;

    const checkpointResult = await adapter.checkpoint(session);
    const { checkpointId } = checkpointResult.data as { checkpointId: string };
    await adapter.modifyObject(session, targetId, { [writableKey]: "mutated after checkpoint" });

    faults.corruptNextRestore = true;
    const restoreResult = await adapter.restore(session, checkpointId);
    // Reports success structurally...
    assert.equal(restoreResult.status, "success");
    // ...but the content genuinely was NOT reverted -- exactly the
    // "environment claims success but doesn't match" case Phase 15's
    // post-restore mismatch detection exists to catch.
    const stillMutated = await adapter.inspectObject(session, targetId);
    assert.notDeepEqual((stillMutated.data as EnvironmentObject).properties.find((p) => p.key === writableKey)!.value, originalValue);
    assert.equal(faults.corruptNextRestore, false);
  });

  it("restoring an unknown checkpoint id still fails with object_not_found even with fault injection configured but not armed", async () => {
    const faults = createCheckpointFaultController();
    const adapter = createMockEnvironment({ checkpointFaults: faults });
    const session = await connect(adapter);
    const result = await adapter.restore(session, "chkpt_does_not_exist");
    assert.equal(result.status, "error");
    assert.equal(result.error?.kind, "object_not_found");
  });

  it("omitting checkpointFaults entirely behaves exactly like before Phase 15 -- purely additive", async () => {
    const adapter = createMockEnvironment();
    const session = await connect(adapter);
    const result = await adapter.checkpoint(session);
    assert.equal(result.status, "success");
  });
});
