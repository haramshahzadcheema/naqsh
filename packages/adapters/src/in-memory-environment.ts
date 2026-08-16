import {
  createEnvironmentDescriptor,
  createEnvironmentDocumentInspection,
  createEnvironmentHealth,
  createEnvironmentObject,
  createEnvironmentOperationResult,
  createEnvironmentSession,
  createId,
  toIsoTimestamp,
  type EnvironmentDescriptorInput,
  type EnvironmentObject,
  type EnvironmentObjectId,
  type EnvironmentObjectInput,
  type EnvironmentOperationKind,
  type EnvironmentOperationResult,
  type EnvironmentErrorKind,
  type EnvironmentSession
} from "@naqsh/schemas";
import type { EnvironmentAdapter } from "@naqsh/core";

/**
 * Shared engine behind every mock adapter (mock-cad-environment.ts,
 * mock-simulation-environment.ts, mock-environment.ts). Everything
 * genuinely domain-specific — capability set, seed data, vocabulary — is
 * supplied by the caller; this file owns only the generic mechanics
 * (session tracking, capability gating, error construction,
 * checkpoint/restore, id/timestamp assignment) that any in-memory adapter
 * needs, so the mocks stay thin, honest configuration rather than copies
 * of the same plumbing. Not exported from the package's public index.ts on
 * purpose — a consumer should reach for a NAMED environment
 * (createMockCadEnvironment / createMockSimulationEnvironment /
 * createMockEnvironment), not this generic builder.
 *
 * "Deterministic" is a property of the CALLER's choice of `generateId`/
 * `now`, not of this engine inherently — the engine itself never reaches
 * for `Math.random()`/`Date.now()` directly, it only ever calls whichever
 * generator/clock it was given (defaulting to real randomness/wall-clock
 * so the P5 mocks keep their original behavior unchanged).
 */
export interface InMemoryEnvironmentAdapterOptions {
  descriptor: EnvironmentDescriptorInput;
  /** Called once per adapter instance (i.e. once per `createAdapter()` in
   * the contract-test suite), so every test starts from the same
   * deterministic, isolated seed state. */
  seedObjects?: () => EnvironmentObjectInput[];
  /** Injectable id generator, applied to every id this engine assigns
   * (sessions, created objects, checkpoints, operation results -- seed
   * objects included). Defaults to `createId` from @naqsh/schemas
   * (random UUID per call), matching this engine's original behavior. Pass
   * `createDeterministicIdGenerator()` (./deterministic.js) for a mock
   * whose ids must be reproducible run-to-run. */
  generateId?: (prefix: string) => string;
  /** Injectable clock, applied to every timestamp this engine assigns.
   * Defaults to `toIsoTimestamp()` from @naqsh/schemas (real wall clock),
   * matching this engine's original behavior. Pass
   * `createDeterministicClock()` (./deterministic.js) for a mock whose
   * timestamps must be reproducible run-to-run. */
  now?: () => string;
  /** Test-only fault injection for Phase 15 checkpoint/restore coverage
   * (`checkpoint capability` describes the real, non-fault-injected
   * behavior on its own -- see `checkpoint()`/`restore()` below).
   * Production callers never set this; pass `createCheckpointFaultController()`
   * from a test and flip its flags to deterministically exercise restore
   * failure / mismatched-restore paths without depending on a real
   * environment ever actually failing. */
  checkpointFaults?: CheckpointFaultController;
}

/**
 * A small, explicit, mutable fault-injection handle -- NOT a generic
 * "chaos" framework. Each flag consumes itself (resets to `false`) the
 * first time it fires, so a test's fault injection is precise about which
 * SPECIFIC call it targets rather than leaking into later, unrelated
 * calls in the same test.
 */
export interface CheckpointFaultController {
  /** The next `checkpoint()` call fails with `environment_failure` instead
   * of succeeding. */
  failNextCheckpoint: boolean;
  /** The next `restore()` call fails with `environment_failure` instead of
   * succeeding. */
  failNextRestore: boolean;
  /** The next `restore()` call reports SUCCESS without actually applying
   * the snapshot's content -- simulates an environment that CLAIMS a
   * successful restore without genuinely matching the checkpointed state,
   * which is exactly the class of bug Phase 15's post-restore mismatch
   * detection (re-observe + compare object ids) exists to catch. */
  corruptNextRestore: boolean;
}

export function createCheckpointFaultController(): CheckpointFaultController {
  return { failNextCheckpoint: false, failNextRestore: false, corruptNextRestore: false };
}

/** `createEnvironmentObject` only shallow-`Object.freeze`s its return value
 * (the top-level object itself becomes non-reassignable, but the nested
 * `properties`/`relationships` arrays and `metadata` object are NOT frozen
 * or cloned) -- so handing a caller the exact `EnvironmentObject` this
 * engine has stored in its internal `objects` Map would let
 * `result.data.properties.push(...)` silently corrupt this adapter's own
 * ground truth for every future call, not just the caller's local copy.
 * Applied at every point engine-internal data crosses into a returned
 * `EnvironmentOperationResult.data` -- the same defensive-clone pattern
 * `packages/core/src/observe-project.ts` uses for the identical class of
 * bug on the WorldModelState side. */
function snapshot<T>(value: T): T {
  const clone = structuredClone(value);
  deepFreezeInPlace(clone);
  return clone;
}

function deepFreezeInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeInPlace(item);
    Object.freeze(value);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreezeInPlace(item);
    Object.freeze(value);
  }
}

export function createInMemoryEnvironmentAdapter(options: InMemoryEnvironmentAdapterOptions): EnvironmentAdapter {
  const generateId = options.generateId ?? ((prefix: string) => createId(prefix));
  const now = options.now ?? (() => toIsoTimestamp());

  const descriptor = createEnvironmentDescriptor(options.descriptor);
  const capabilities = new Set(descriptor.capabilities);

  let objects = new Map<EnvironmentObjectId, EnvironmentObject>();
  for (const input of (options.seedObjects ?? (() => []))()) {
    const object = createEnvironmentObject({ ...input, id: input.id ?? generateId("envobj") });
    objects.set(object.id, object);
  }

  const connectedSessionIds = new Set<string>();
  const checkpoints = new Map<string, Map<EnvironmentObjectId, EnvironmentObject>>();

  function success(
    operation: EnvironmentOperationKind,
    sessionId: string | null,
    objectId: EnvironmentObjectId | null,
    data: unknown,
    metadata: Record<string, unknown> = {}
  ): EnvironmentOperationResult {
    const startedAt = now();
    return createEnvironmentOperationResult({
      id: generateId("envop"),
      operation,
      sessionId,
      objectId,
      status: "success",
      data,
      startedAt,
      completedAt: now(),
      metadata
    });
  }

  function failure(
    operation: EnvironmentOperationKind,
    sessionId: string | null,
    objectId: EnvironmentObjectId | null,
    kind: EnvironmentErrorKind,
    message: string
  ): EnvironmentOperationResult {
    const startedAt = now();
    return createEnvironmentOperationResult({
      id: generateId("envop"),
      operation,
      sessionId,
      objectId,
      status: "error",
      error: { kind, message },
      startedAt,
      completedAt: now()
    });
  }

  /**
   * `createEnvironmentObject` THROWS `WorldModelValidationError` for any
   * shape violation (empty type, non-JSON-safe property value, malformed
   * relationship, ...) -- correct for a schemas-layer factory, but an
   * adapter method must never let that escape as a rejected promise: the
   * ENTIRE point of `EnvironmentOperationResult` is that a caller branches
   * on `result.status`/`result.error.kind` and never needs a try/catch
   * around an adapter call (see environment-adapter.ts's own doc comment).
   * Malformed `createObject`/`modifyObject` input is an entirely expected
   * failure mode (a tool or agent can easily construct it), not a truly
   * exceptional one, so it is caught here and turned into the same
   * structured "invalid_operation" result every other input-validation
   * failure in this engine already produces (unknown property, read-only
   * property) -- one consistent bucket for "the requested change doesn't
   * apply as specified," not a second, throw-shaped error channel.
   */
  function tryBuildObject(input: EnvironmentObjectInput): EnvironmentObject | { message: string } {
    try {
      return createEnvironmentObject(input);
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error) };
    }
  }

  function requireConnected(
    session: EnvironmentSession,
    operation: EnvironmentOperationKind,
    objectId: EnvironmentObjectId | null = null
  ): EnvironmentOperationResult | null {
    if (!connectedSessionIds.has(session.id)) {
      return failure(operation, session.id, objectId, "not_connected", `Session "${session.id}" is not connected`);
    }
    return null;
  }

  function requireCapability(
    capability: (typeof descriptor)["capabilities"][number],
    operation: EnvironmentOperationKind,
    sessionId: string,
    objectId: EnvironmentObjectId | null
  ): EnvironmentOperationResult | null {
    if (!capabilities.has(capability)) {
      return failure(
        operation,
        sessionId,
        objectId,
        "unsupported_capability",
        `"${descriptor.kind}" does not support "${capability}"`
      );
    }
    return null;
  }

  return {
    describe: () => descriptor,

    async health() {
      return success(
        "health",
        null,
        null,
        createEnvironmentHealth({ status: "healthy", message: "mock environment", checkedAt: now() })
      );
    },

    async connect(options) {
      const documentName = typeof options?.documentName === "string" ? options.documentName : null;
      const session = createEnvironmentSession({
        id: generateId("envsess"),
        environmentKind: descriptor.kind,
        status: "connected",
        documentName,
        openedAt: now()
      });
      connectedSessionIds.add(session.id);
      return success("connect", session.id, null, session);
    },

    async disconnect(session) {
      const guard = requireConnected(session, "disconnect");
      if (guard) return guard;
      connectedSessionIds.delete(session.id);
      return success("disconnect", session.id, null, null);
    },

    async listObjects(session) {
      const guard = requireConnected(session, "list_objects");
      if (guard) return guard;
      return success("list_objects", session.id, null, snapshot(Array.from(objects.values())));
    },

    async inspectObject(session, objectId) {
      const guard = requireConnected(session, "inspect_object", objectId);
      if (guard) return guard;
      const object = objects.get(objectId);
      if (!object) {
        return failure("inspect_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      return success("inspect_object", session.id, objectId, snapshot(object));
    },

    /** Phase 13: this engine has no richer "document" concept than its own
     * in-memory `objects` map, so `documentId`/`filePath` are honestly
     * `null` rather than fabricated -- `documentName` is passed through
     * from whatever `connect({ documentName })` was given. `rootObjectIds`
     * is every object whose `parentId` is `null`, which for this engine's
     * flat seed data is normally all of them (no mock currently seeds
     * containment) -- correct, not a limitation to work around here. */
    async inspectDocument(session) {
      const guard = requireConnected(session, "inspect_document");
      if (guard) return guard;
      const currentObjects = Array.from(objects.values());
      const objectIds = currentObjects.map((object) => object.id).sort();
      const rootObjectIds = currentObjects
        .filter((object) => object.parentId === null)
        .map((object) => object.id)
        .sort();
      return success(
        "inspect_document",
        session.id,
        null,
        createEnvironmentDocumentInspection({
          environmentKind: descriptor.kind,
          documentId: null,
          documentName: session.documentName,
          filePath: null,
          objectCount: objectIds.length,
          objectIds,
          rootObjectIds,
          inspectedAt: now(),
          environmentVersion: descriptor.version
        })
      );
    },

    async createObject(session, input) {
      const guard = requireConnected(session, "create_object");
      if (guard) return guard;
      const capabilityGuard = requireCapability("create", "create_object", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      const id = input.id ?? generateId("envobj");
      if (objects.has(id)) {
        // A caller-supplied id (EnvironmentObjectInput.id is optional but
        // not forbidden) that collides with an existing object must never
        // silently clobber it -- "conflict" is exactly this engine's
        // existing vocabulary for "the requested change can't apply given
        // current state," not a new error kind invented for this case.
        return failure("create_object", session.id, id, "conflict", `An object with id "${id}" already exists`);
      }
      const built = tryBuildObject({ ...input, id });
      if ("message" in built) {
        return failure("create_object", session.id, null, "invalid_operation", built.message);
      }
      objects.set(built.id, built);
      return success("create_object", session.id, built.id, snapshot(built));
    },

    async modifyObject(session, objectId, changes, options) {
      const guard = requireConnected(session, "modify_object", objectId);
      if (guard) return guard;
      const capabilityGuard = requireCapability("modify", "modify_object", session.id, objectId);
      if (capabilityGuard) return capabilityGuard;
      const existing = objects.get(objectId);
      if (!existing) {
        return failure("modify_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      for (const key of Object.keys(changes)) {
        const property = existing.properties.find((candidate) => candidate.key === key);
        if (!property) {
          return failure("modify_object", session.id, objectId, "invalid_operation", `Unknown property "${key}"`);
        }
        if (property.readOnly) {
          return failure("modify_object", session.id, objectId, "invalid_operation", `Property "${key}" is read-only`);
        }
      }

      // Phase 14 Step 14: stale-state protection. Checked against the
      // CURRENT stored value, before anything else applies -- a mismatch
      // means the caller's observation is stale (something else changed
      // this object since), and the whole call is rejected, mutating
      // nothing, exactly like a real environment must.
      if (options?.expectedBefore) {
        for (const key of Object.keys(options.expectedBefore)) {
          const property = existing.properties.find((candidate) => candidate.key === key);
          const currentValue = property ? property.value : undefined;
          if (JSON.stringify(currentValue) !== JSON.stringify(options.expectedBefore[key])) {
            return failure(
              "modify_object",
              session.id,
              objectId,
              "conflict",
              `expectedBefore mismatch for "${key}": current value has changed since it was last observed`
            );
          }
        }
      }

      // Phase 14 Step 16: idempotency. If every requested value already
      // equals the current one, this call is a no-op -- report success
      // (the desired state already holds) without touching `objects`.
      const requestedKeys = Object.keys(changes);
      const alreadySatisfied = requestedKeys.every((key) => {
        const property = existing.properties.find((candidate) => candidate.key === key);
        return property !== undefined && JSON.stringify(property.value) === JSON.stringify(changes[key]);
      });

      const beforeValues = new Map(existing.properties.map((property) => [property.key, property.value]));

      if (alreadySatisfied) {
        const propertyChanges = requestedKeys.map((key) => ({
          key,
          before: beforeValues.get(key) ?? null,
          requested: changes[key],
          after: beforeValues.get(key) ?? null
        }));
        return success("modify_object", session.id, objectId, snapshot(existing), { propertyChanges, alreadySatisfied: true });
      }

      const built = tryBuildObject({
        id: existing.id,
        type: existing.type,
        name: existing.name,
        properties: existing.properties.map((property) =>
          Object.hasOwn(changes, property.key) ? { ...property, value: changes[property.key] } : property
        ),
        relationships: existing.relationships,
        metadata: existing.metadata
      });
      if ("message" in built) {
        return failure("modify_object", session.id, objectId, "invalid_operation", built.message);
      }
      objects.set(objectId, built);
      const afterValues = new Map(built.properties.map((property) => [property.key, property.value]));
      const propertyChanges = requestedKeys.map((key) => ({
        key,
        before: beforeValues.get(key) ?? null,
        requested: changes[key],
        after: afterValues.get(key) ?? null
      }));
      return success("modify_object", session.id, objectId, snapshot(built), { propertyChanges, alreadySatisfied: false });
    },

    async deleteObject(session, objectId) {
      const guard = requireConnected(session, "delete_object", objectId);
      if (guard) return guard;
      const capabilityGuard = requireCapability("delete", "delete_object", session.id, objectId);
      if (capabilityGuard) return capabilityGuard;
      if (!objects.has(objectId)) {
        return failure("delete_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      objects.delete(objectId);
      return success("delete_object", session.id, objectId, null);
    },

    async save(session) {
      const guard = requireConnected(session, "save");
      if (guard) return guard;
      const capabilityGuard = requireCapability("save", "save", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      return success("save", session.id, null, null);
    },

    async checkpoint(session) {
      const guard = requireConnected(session, "checkpoint");
      if (guard) return guard;
      const capabilityGuard = requireCapability("checkpoint", "checkpoint", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      if (options.checkpointFaults?.failNextCheckpoint) {
        options.checkpointFaults.failNextCheckpoint = false;
        return failure("checkpoint", session.id, null, "environment_failure", "Simulated checkpoint failure (test fault injection)");
      }
      const checkpointId = generateId("chkpt");
      checkpoints.set(checkpointId, new Map(objects));
      return success("checkpoint", session.id, null, { checkpointId });
    },

    async restore(session, checkpointId) {
      const guard = requireConnected(session, "restore");
      if (guard) return guard;
      const capabilityGuard = requireCapability("checkpoint", "restore", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      if (options.checkpointFaults?.failNextRestore) {
        options.checkpointFaults.failNextRestore = false;
        return failure("restore", session.id, null, "environment_failure", "Simulated restore failure (test fault injection)");
      }
      const snapshot = checkpoints.get(checkpointId);
      if (!snapshot) {
        return failure("restore", session.id, null, "object_not_found", `No checkpoint with id "${checkpointId}"`);
      }
      if (options.checkpointFaults?.corruptNextRestore) {
        // Deliberately does NOT apply `snapshot` -- reports success while
        // leaving `objects` exactly as it was, simulating an environment
        // that claims a successful restore without genuinely matching the
        // checkpointed state.
        options.checkpointFaults.corruptNextRestore = false;
        return success("restore", session.id, null, null);
      }
      objects = new Map(snapshot);
      return success("restore", session.id, null, null);
    }
  };
}
