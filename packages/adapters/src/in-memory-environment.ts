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
 * Shared, deterministic in-memory engine behind both mock adapters
 * (mock-cad-environment.ts, mock-simulation-environment.ts). Everything
 * genuinely CAD/simulation-specific — capability set, seed data, domain
 * vocabulary — is supplied by the caller; this file owns only the generic
 * mechanics (session tracking, capability gating, error construction,
 * checkpoint/restore) that any deterministic mock adapter needs, so the
 * two mocks stay thin, honest configuration rather than two copies of the
 * same plumbing. Not exported from the package's public index.ts on
 * purpose — a consumer should reach for a NAMED environment
 * (createMockCadEnvironment / createMockSimulationEnvironment), not this
 * generic builder.
 */
export interface InMemoryEnvironmentAdapterOptions {
  descriptor: EnvironmentDescriptorInput;
  /** Called once per adapter instance (i.e. once per `createAdapter()` in
   * the contract-test suite), so every test starts from the same
   * deterministic, isolated seed state. */
  seedObjects?: () => EnvironmentObjectInput[];
}

export function createInMemoryEnvironmentAdapter(options: InMemoryEnvironmentAdapterOptions): EnvironmentAdapter {
  const descriptor = createEnvironmentDescriptor(options.descriptor);
  const capabilities = new Set(descriptor.capabilities);

  let objects = new Map<EnvironmentObjectId, EnvironmentObject>();
  for (const input of (options.seedObjects ?? (() => []))()) {
    const object = createEnvironmentObject(input);
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
    return createEnvironmentOperationResult({
      operation,
      sessionId,
      objectId,
      status: "success",
      data,
      startedAt: toIsoTimestamp()
    });
  }

  function failure(
    operation: EnvironmentOperationKind,
    sessionId: string | null,
    objectId: EnvironmentObjectId | null,
    kind: EnvironmentErrorKind,
    message: string
  ): EnvironmentOperationResult {
    return createEnvironmentOperationResult({
      operation,
      sessionId,
      objectId,
      status: "error",
      error: { kind, message },
      startedAt: toIsoTimestamp()
    });
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
      return success("health", null, null, createEnvironmentHealth({ status: "healthy", message: "mock environment" }));
    },

    async connect(options) {
      const documentName = typeof options?.documentName === "string" ? options.documentName : null;
      const session = createEnvironmentSession({
        environmentKind: descriptor.kind,
        status: "connected",
        documentName
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
      const object = createEnvironmentObject(input);
      objects.set(object.id, object);
      return success("create_object", session.id, object.id, object);
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
      const updated = createEnvironmentObject({
        id: existing.id,
        type: existing.type,
        name: existing.name,
        properties: existing.properties.map((property) =>
          Object.hasOwn(changes, property.key) ? { ...property, value: changes[property.key] } : property
        ),
        relationships: existing.relationships,
        metadata: existing.metadata
      });
      objects.set(objectId, updated);
      return success("modify_object", session.id, objectId, updated);
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
      const checkpointId = createId("chkpt");
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
