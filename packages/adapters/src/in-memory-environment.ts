import {
  createEnvironmentDescriptor,
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
    data: unknown
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
      completedAt: now()
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
      return success("list_objects", session.id, null, Array.from(objects.values()));
    },

    async inspectObject(session, objectId) {
      const guard = requireConnected(session, "inspect_object", objectId);
      if (guard) return guard;
      const object = objects.get(objectId);
      if (!object) {
        return failure("inspect_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      return success("inspect_object", session.id, objectId, object);
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
      return success("create_object", session.id, built.id, built);
    },

    async modifyObject(session, objectId, changes) {
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
      return success("modify_object", session.id, objectId, built);
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
      const checkpointId = generateId("chkpt");
      checkpoints.set(checkpointId, new Map(objects));
      return success("checkpoint", session.id, null, { checkpointId });
    },

    async restore(session, checkpointId) {
      const guard = requireConnected(session, "restore");
      if (guard) return guard;
      const capabilityGuard = requireCapability("checkpoint", "restore", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      const snapshot = checkpoints.get(checkpointId);
      if (!snapshot) {
        return failure("restore", session.id, null, "object_not_found", `No checkpoint with id "${checkpointId}"`);
      }
      objects = new Map(snapshot);
      return success("restore", session.id, null, null);
    }
  };
}
