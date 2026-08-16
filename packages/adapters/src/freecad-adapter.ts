import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createEnvironmentDescriptor,
  createEnvironmentDocumentInspection,
  createEnvironmentHealth,
  createEnvironmentInspectionError,
  createEnvironmentObject,
  createEnvironmentOperationResult,
  createEnvironmentSession,
  createId,
  toIsoTimestamp,
  type EnvironmentCapability,
  type EnvironmentErrorKind,
  type EnvironmentInspectionError,
  type EnvironmentInspectionErrorKind,
  type EnvironmentObject,
  type EnvironmentObjectGenericType,
  type EnvironmentObjectGeometryInput,
  type EnvironmentObjectId,
  type EnvironmentOperationKind,
  type EnvironmentOperationResult,
  type EnvironmentPropertyInput,
  type EnvironmentRelationshipInput,
  type EnvironmentSession
} from "@naqsh/schemas";
import type { EnvironmentAdapter } from "@naqsh/core";
import { runFreecadOperation, type FreeCadRuntimeConfig, type FreeCadRuntimeResult } from "./freecad-runtime.js";

/**
 * The real FreeCAD environment adapter (Phase 12): the first
 * `EnvironmentAdapter` implementation (P5) backed by an actual external
 * engineering environment rather than an in-memory mock.
 *
 * FreeCAD IS NOT the World Model. This file returns generic
 * `EnvironmentObject`/`EnvironmentOperationResult` values (P5's own
 * contract), never a raw FreeCAD Python object -- a caller cannot get a
 * FreeCAD document/object reference through this boundary even if it
 * wanted to. Reconciling an observation into `WorldModelState` remains a
 * separate, later concern (see README's P5/P12 notes) -- this file's job
 * ends at producing a trustworthy `EnvironmentOperationResult`.
 *
 * Scope (Phase 12, extended by Phase 13's much deeper read boundary --
 * see `inspectDocument()` and the richer `EnvironmentObject` fields):
 * read/inspect/save only. `capabilities` is exactly `["save"]` --
 * `create`/`modify`/`delete`/`checkpoint` are all real, present methods
 * (the `EnvironmentAdapter` interface requires them unconditionally, see
 * environment-adapter.ts) but every one of them is capability-gated to
 * `unsupported_capability` through Phase 13, deliberately: Phase 12/13's
 * own briefs list inspection/discovery/save as the priority, never
 * modification, and repeatedly warn against turning this into full CAD
 * manipulation. A minimal `modifyObject` is a natural, well-scoped Phase
 * 14 starting point once this read boundary is trusted -- not implemented
 * here.
 *
 * Stateless-per-call design: each operation spawns a fresh
 * `freecadcmd` process (via freecad-runtime.ts) that opens the target
 * document, performs exactly one read (or save), and closes it again --
 * there is no persistent FreeCAD process this adapter keeps alive between
 * calls. `connect()` validates the document is openable and returns a
 * session that remembers the file path (`EnvironmentSession.metadata.
 * filePath`) for subsequent calls to reuse; it does not keep the document
 * open. This trades a few hundred ms of FreeCAD startup latency per call
 * for a simpler, crash-safe design with no cross-call session state that
 * could desync from the real file on disk -- an explicit, documented
 * tradeoff (see packages/adapters/freecad/README.md), not an oversight.
 */

export interface FreeCadAdapterOptions {
  /** Path to the FreeCAD headless CLI (`freecadcmd`/`freecadcmd.exe`).
   * Defaults to `process.env.NAQSH_FREECAD_CMD`, then the bare command
   * `"freecadcmd"` (resolved via PATH). Never hardcoded to a specific
   * machine's install location -- see Phase 12 Step 3: this adapter must
   * fail clearly when FreeCAD is unavailable, not assume a path. */
  freecadCmdPath?: string;
  /** Path to runner.py. Defaults to the copy shipped alongside this
   * package (packages/adapters/freecad/runner.py), resolved relative to
   * this module's own location so it works whether running from src/ (via
   * tsx) or dist/ (after build) -- both sit one directory level under
   * packages/adapters/. */
  runnerScriptPath?: string;
  /** Per-operation subprocess timeout. FreeCAD's own startup is the
   * dominant cost of every call; defaults to 30s to comfortably cover a
   * cold start on a typical machine without hanging indefinitely on a
   * genuinely wedged process. */
  timeoutMs?: number;
  /** The FreeCAD document (.FCStd) `connect()` opens when the caller does
   * not supply its own `documentPath`/`filePath` option -- lets this
   * adapter satisfy the generic `EnvironmentAdapter` contract-test suite
   * (which calls `connect()` with no options) the same way the mock
   * adapters' seed data does. */
  defaultDocumentPath?: string;
  generateId?: (prefix: string) => string;
  now?: () => string;
  /** Test-only injection seam: replaces the actual `freecadcmd` subprocess
   * call with a caller-supplied function. Defaults to the real
   * `runFreecadOperation` (freecad-runtime.ts) wired against this
   * adapter's own resolved `freecadCmdPath`/`runnerScriptPath`/`timeoutMs`
   * -- production code never sets this. This is what lets Level 1
   * contract tests (freecad-adapter.test.ts) exercise every branch of
   * THIS file deterministically without spawning any process at all,
   * while Level 2 integration tests (freecad-adapter.integration.test.ts)
   * leave it unset and exercise the real subprocess boundary. */
  runOperation?: (operation: string, params: Record<string, unknown>) => Promise<FreeCadRuntimeResult>;
}

function defaultRunnerScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "freecad", "runner.py");
}

interface RawFreecadObject {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  genericType?: unknown;
  parentId?: unknown;
  visible?: unknown;
  geometry?: unknown;
  properties?: unknown;
  relationships?: unknown;
  metadata?: unknown;
}

interface RawFreecadInspectionError {
  kind?: unknown;
  objectId?: unknown;
  message?: unknown;
}

export function createFreeCadAdapter(options: FreeCadAdapterOptions = {}): EnvironmentAdapter {
  const generateId = options.generateId ?? ((prefix: string) => createId(prefix));
  const now = options.now ?? (() => toIsoTimestamp());

  const runtimeConfig: FreeCadRuntimeConfig = {
    freecadCmdPath: options.freecadCmdPath ?? process.env.NAQSH_FREECAD_CMD ?? "freecadcmd",
    runnerScriptPath: options.runnerScriptPath ?? defaultRunnerScriptPath(),
    timeoutMs: options.timeoutMs ?? 30_000
  };
  const runOperation = options.runOperation ?? ((operation, params) => runFreecadOperation(runtimeConfig, operation, params));

  // "1.0.0" is THIS ADAPTER's own version, not a claimed FreeCAD version --
  // describe() is synchronous and cannot fail (EnvironmentAdapter's own
  // contract), so it cannot genuinely probe FreeCAD. The REAL, live FreeCAD
  // version (when reachable) is reported by health() instead, which can
  // fail/probe. Never hardcode a fake FreeCAD version here (Phase 12 Step
  // 5's explicit requirement).
  const descriptor = createEnvironmentDescriptor({
    kind: "freecad",
    name: "FreeCAD",
    version: "1.0.0",
    capabilities: ["save"]
  });
  const capabilities = new Set<EnvironmentCapability>(descriptor.capabilities);

  const sessions = new Map<string, { filePath: string }>();

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

  function requireConnected(
    session: EnvironmentSession,
    operation: EnvironmentOperationKind,
    objectId: EnvironmentObjectId | null = null
  ): { result: EnvironmentOperationResult; filePath: null } | { result: null; filePath: string } {
    const entry = sessions.get(session.id);
    if (!entry) {
      return { result: failure(operation, session.id, objectId, "not_connected", `Session "${session.id}" is not connected`), filePath: null };
    }
    return { result: null, filePath: entry.filePath };
  }

  function requireCapability(
    capability: EnvironmentCapability,
    operation: EnvironmentOperationKind,
    sessionId: string,
    objectId: EnvironmentObjectId | null
  ): EnvironmentOperationResult | null {
    if (!capabilities.has(capability)) {
      return failure(operation, sessionId, objectId, "unsupported_capability", `"${descriptor.kind}" does not support "${capability}"`);
    }
    return null;
  }

  /** `createEnvironmentObject` throws for any shape violation -- caught
   * here so a malformed/unexpected value from runner.py (a FreeCAD-side
   * surprise this adapter didn't anticipate) becomes a structured
   * `invalid_operation`/`environment_failure` result, never an uncaught
   * rejection. Mirrors in-memory-environment.ts's identical `tryBuildObject`
   * discipline exactly.
   *
   * `id` is REQUIRED to already be a genuine, non-empty string from
   * runner.py (FreeCAD's own `obj.Name`) -- deliberately NOT defaulted to
   * `undefined` the way `type`/`name` are defaulted to `""` below.
   * `createEnvironmentObject({ id: undefined, ... })` would silently MINT A
   * FRESH RANDOM id via `createId("envobj")` rather than failing, which
   * would make the same real FreeCAD object appear under a DIFFERENT
   * NAQSH-facing id on every single `listObjects`/`inspectObject` call --
   * exactly the "unstable object IDs" failure mode a caller (a future
   * Proposal referencing an object by id, or the P11 loop's before/after
   * discrepancy comparison) must never have to worry about. A missing/
   * non-string id is therefore an explicit, structured failure here, never
   * a silently-fabricated identity. */
  function tryBuildObject(raw: unknown): EnvironmentObject | { message: string } {
    const record = raw as RawFreecadObject;
    if (typeof record.id !== "string" || record.id.length === 0) {
      return { message: "FreeCAD object is missing a valid, non-empty id (expected obj.Name)" };
    }
    const baseMetadata = typeof record.metadata === "object" && record.metadata !== null ? (record.metadata as Record<string, unknown>) : {};
    try {
      return createEnvironmentObject({
        id: record.id,
        type: typeof record.type === "string" ? record.type : "",
        name: typeof record.name === "string" ? record.name : "",
        genericType: record.genericType as EnvironmentObjectGenericType | undefined,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
        visible: typeof record.visible === "boolean" ? record.visible : null,
        geometry: record.geometry as EnvironmentObjectGeometryInput | undefined,
        properties: Array.isArray(record.properties) ? (record.properties as EnvironmentPropertyInput[]) : [],
        relationships: Array.isArray(record.relationships) ? (record.relationships as EnvironmentRelationshipInput[]) : [],
        // Object-level provenance (Phase 13 Step 17): every EnvironmentObject
        // this adapter returns remains identifiable as FreeCAD-observed data
        // -- NOT a claim about WorldModelState (this adapter never touches
        // that), just an honest "where did this come from" stamp on the raw
        // observation. Deliberately excludes a per-object timestamp: WHEN
        // this observation happened is already carried at the OPERATION
        // level (`EnvironmentOperationResult.completedAt`, stamped once per
        // listObjects/inspectObject call) -- duplicating a live clock read
        // into every object's metadata would make `listObjects()` produce a
        // DIFFERENT `data` value on every repeated call even with zero
        // mutation in between, breaking the generic contract-test
        // invariant every adapter must satisfy (discovered via a genuine
        // test failure against real FreeCAD, not by inspection alone).
        metadata: { ...baseMetadata, provenance: { environmentKind: descriptor.kind } }
      });
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Best-effort: a malformed inspection-error entry from runner.py is
   * itself just diagnostic metadata, not core data -- skipped rather than
   * failing the whole (otherwise successful) list_objects/inspect_document
   * call over it. */
  function tryBuildInspectionErrors(raw: unknown): EnvironmentInspectionError[] {
    if (!Array.isArray(raw)) return [];
    const errors: EnvironmentInspectionError[] = [];
    for (const entry of raw) {
      const record = entry as RawFreecadInspectionError;
      try {
        errors.push(
          createEnvironmentInspectionError({
            kind: record.kind as EnvironmentInspectionErrorKind,
            objectId: typeof record.objectId === "string" ? record.objectId : null,
            message: typeof record.message === "string" ? record.message : "unknown inspection error"
          })
        );
      } catch {
        continue;
      }
    }
    return errors;
  }

  return {
    describe: () => descriptor,

    async health() {
      const result = await runOperation("health", {});
      if (result.status === "error") {
        return failure("health", null, null, result.kind, result.message);
      }
      const data = result.data as { version?: unknown };
      const version = typeof data.version === "string" ? data.version : "unknown";
      return success("health", null, null, createEnvironmentHealth({ status: "healthy", message: `FreeCAD ${version} reachable`, checkedAt: now() }));
    },

    async connect(options) {
      // "filePath" is this adapter's own option key; "documentPath" is
      // accepted as an alias since it reads more naturally alongside the
      // generic EnvironmentSession.documentName field a caller sees back.
      const explicitPath =
        (typeof options?.filePath === "string" ? options.filePath : undefined) ??
        (typeof options?.documentPath === "string" ? options.documentPath : undefined);
      return connectToPath(explicitPath);
    },

    async disconnect(session) {
      const { result } = requireConnected(session, "disconnect");
      if (result) return result;
      sessions.delete(session.id);
      return success("disconnect", session.id, null, null);
    },

    async listObjects(session) {
      const guard = requireConnected(session, "list_objects");
      if (guard.result) return guard.result;
      const result = await runOperation("list_objects", { filePath: guard.filePath });
      if (result.status === "error") return failure("list_objects", session.id, null, result.kind, result.message);
      const data = result.data as { objects?: unknown; inspectionErrors?: unknown };
      const rawObjects = Array.isArray(data.objects) ? data.objects : [];
      const built: EnvironmentObject[] = [];
      const warnings: string[] = [];
      // Partial success (Phase 13 Step 16): a single malformed object must
      // never take down an otherwise-successful listing of a real
      // document -- skip it, record why, and keep going. Contrast with
      // inspectObject below, which targets exactly ONE object and has
      // nothing meaningful to return in a "partial" sense if that one
      // object is malformed.
      for (const raw of rawObjects) {
        const object = tryBuildObject(raw);
        if ("message" in object) {
          warnings.push(`Skipped a malformed object from FreeCAD: ${object.message}`);
          continue;
        }
        built.push(object);
      }
      const inspectionErrors = tryBuildInspectionErrors(data.inspectionErrors);
      return success("list_objects", session.id, null, built, { warnings, inspectionErrors });
    },

    async inspectObject(session, objectId) {
      const guard = requireConnected(session, "inspect_object", objectId);
      if (guard.result) return guard.result;
      const result = await runOperation("inspect_object", { filePath: guard.filePath, objectId });
      if (result.status === "error") return failure("inspect_object", session.id, objectId, result.kind, result.message);
      const data = result.data as { found?: unknown; object?: unknown; inspectionErrors?: unknown };
      if (!data.found) {
        return failure("inspect_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      const object = tryBuildObject(data.object);
      if ("message" in object) {
        return failure("inspect_object", session.id, objectId, "environment_failure", `Malformed object from FreeCAD: ${object.message}`);
      }
      // A relationship (or other per-object detail) FreeCAD reported but
      // this adapter could not safely describe for THIS object -- Phase
      // 13 Step 15/16: never silently drop it, surface it alongside the
      // still-successful object (mirrors listObjects' own
      // metadata.inspectionErrors, same partial-success discipline).
      const inspectionErrors = tryBuildInspectionErrors(data.inspectionErrors);
      return success("inspect_object", session.id, objectId, object, inspectionErrors.length > 0 ? { inspectionErrors } : {});
    },

    async inspectDocument(session) {
      const guard = requireConnected(session, "inspect_document");
      if (guard.result) return guard.result;
      const result = await runOperation("inspect_document", { filePath: guard.filePath });
      if (result.status === "error") return failure("inspect_document", session.id, null, result.kind, result.message);
      const data = result.data as {
        documentId?: unknown;
        documentName?: unknown;
        filePath?: unknown;
        objectCount?: unknown;
        objectIds?: unknown;
        rootObjectIds?: unknown;
        environmentVersion?: unknown;
      };
      try {
        const inspection = createEnvironmentDocumentInspection({
          environmentKind: descriptor.kind,
          documentId: typeof data.documentId === "string" ? data.documentId : null,
          documentName: typeof data.documentName === "string" ? data.documentName : null,
          filePath: typeof data.filePath === "string" ? data.filePath : null,
          objectCount: typeof data.objectCount === "number" ? data.objectCount : 0,
          objectIds: Array.isArray(data.objectIds) ? (data.objectIds as string[]) : [],
          rootObjectIds: Array.isArray(data.rootObjectIds) ? (data.rootObjectIds as string[]) : [],
          inspectedAt: now(),
          environmentVersion: typeof data.environmentVersion === "string" ? data.environmentVersion : null
        });
        return success("inspect_document", session.id, null, inspection);
      } catch (error) {
        return failure(
          "inspect_document",
          session.id,
          null,
          "environment_failure",
          `Malformed document inspection from FreeCAD: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },

    async createObject(session) {
      const guard = requireConnected(session, "create_object");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("create", "create_object", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      // Never reached in Phase 12: "create" is never in `capabilities`
      // above, so requireCapability always short-circuits first. This
      // line exists so the method still has a well-formed return if a
      // later phase adds "create" to `capabilities` without also filling
      // in the real logic.
      return failure("create_object", session.id, null, "unsupported_capability", "create is not supported by the FreeCAD adapter in this phase");
    },

    async modifyObject(session, objectId) {
      const guard = requireConnected(session, "modify_object", objectId);
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("modify", "modify_object", session.id, objectId);
      if (capabilityGuard) return capabilityGuard;
      // Never reached this phase -- see createObject's identical comment.
      return failure("modify_object", session.id, objectId, "unsupported_capability", "modify is not supported by the FreeCAD adapter in this phase");
    },

    async deleteObject(session, objectId) {
      const guard = requireConnected(session, "delete_object", objectId);
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("delete", "delete_object", session.id, objectId);
      if (capabilityGuard) return capabilityGuard;
      // Never reached this phase -- see createObject's identical comment.
      return failure("delete_object", session.id, objectId, "unsupported_capability", "delete is not supported by the FreeCAD adapter in this phase");
    },

    async save(session) {
      const guard = requireConnected(session, "save");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("save", "save", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      const result = await runOperation("save", { filePath: guard.filePath });
      if (result.status === "error") return failure("save", session.id, null, result.kind, result.message);
      return success("save", session.id, null, null);
    },

    async checkpoint(session) {
      const guard = requireConnected(session, "checkpoint");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("checkpoint", "checkpoint", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      // Never reached this phase -- no real rollback/snapshot mechanism is
      // implemented (see this file's module doc comment): "checkpoint" is
      // never in `capabilities` above, so requireCapability always
      // short-circuits first.
      return failure("checkpoint", session.id, null, "unsupported_capability", "checkpoint is not supported by the FreeCAD adapter in this phase");
    },

    async restore(session) {
      const guard = requireConnected(session, "restore");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("checkpoint", "restore", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      // Never reached this phase -- see checkpoint's identical comment.
      return failure("restore", session.id, null, "unsupported_capability", "restore is not supported by the FreeCAD adapter in this phase");
    }
  };

  async function connectToPath(explicitPath: string | undefined): Promise<EnvironmentOperationResult> {
    const filePath = explicitPath ?? options.defaultDocumentPath;
    if (!filePath) {
      return failure(
        "connect",
        null,
        null,
        "invalid_operation",
        'connect() requires a "filePath" (or "documentPath") option naming a FreeCAD document to open, or FreeCadAdapterOptions.defaultDocumentPath'
      );
    }
    const result = await runOperation("connect", { filePath });
    if (result.status === "error") {
      return failure("connect", null, null, result.kind, result.message);
    }
    const data = result.data as { documentName?: unknown };
    const documentName = typeof data.documentName === "string" ? data.documentName : filePath;
    const session = createEnvironmentSession({
      id: generateId("envsess"),
      environmentKind: descriptor.kind,
      status: "connected",
      documentName,
      openedAt: now(),
      metadata: { filePath }
    });
    sessions.set(session.id, { filePath });
    return success("connect", session.id, null, session);
  }
}
