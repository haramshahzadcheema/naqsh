import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createEnvironmentDescriptor,
  createEnvironmentDocumentInspection,
  createEnvironmentHealth,
  createEnvironmentInspectionError,
  createEnvironmentObject,
  createEnvironmentOperationResult,
  createEnvironmentPropertyChange,
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
  type EnvironmentPropertyChange,
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
 * Scope: `capabilities` is `["save", "modify", "create", "checkpoint"]`.
 * `delete` remains a real, present method (the `EnvironmentAdapter`
 * interface requires it unconditionally, see environment-adapter.ts) but
 * is still capability-gated to `unsupported_capability` -- no destructive
 * operation is implemented yet. `modify` (Phase 14) and `create` (AUDIT
 * FIX) are BOTH deliberately narrow allowlisted paths restricted to the
 * exact same single TypeId, `Part::Box` (see runner.py's
 * `SUPPORTED_MUTATIONS`) -- creating an object of any other type is
 * rejected honestly rather than silently coerced. `checkpoint` (Phase 15)
 * is a real file-copy snapshot/restore of the live `.FCStd` document (see
 * runner.py's `op_checkpoint`/`op_restore`) -- never a fabricated pointer.
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

interface RawFreecadPropertyChange {
  key?: unknown;
  before?: unknown;
  requested?: unknown;
  after?: unknown;
}

/** Every distinct way runner.py's `op_modify_object` rejects a request
 * BEFORE mutating anything (Phase 14 Step 9/13) -- each maps onto the
 * existing, small `EnvironmentErrorKind` vocabulary rather than growing a
 * FreeCAD-specific one: "stale_state" is exactly what "conflict" already
 * means ("the requested change can't apply given current state" --
 * `in-memory-environment.ts`'s own precedent for `create_object` id
 * collision); every other reason is "the requested change doesn't apply
 * as specified", which is exactly "invalid_operation" already means. */
/** Translates the GENERIC type vocabulary every `createObject` caller in
 * this codebase actually uses (`EnvironmentObjectGenericType`, or a loose
 * `type` string like "part"/"box") into the one concrete FreeCAD TypeId
 * this adapter knows how to create safely: `Part::Box`. Returns `null`
 * for anything it cannot confidently map -- a caller asking for a sketch,
 * datum, or link gets an honest rejection, never a silently-wrong box. */
/** Ordinary engineering words for the three primitives this adapter can
 * genuinely build. Ordered most-specific first: a "wheel rim" must resolve
 * to a cylinder, not fall through to the generic solid default. */
const TYPE_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  // A tyre IS a torus: the ring/donut primitive, not a box or a disc.
  [/\b(torus|tyre|tire|donut|doughnut|ring|o-ring|annulus)\b/, "Part::Torus"],
  [/\b(cylinder|disc|disk|wheel|rim|hub|shaft|rod|pin|boss|axle|spool|roller)\b/, "Part::Cylinder"],
  [/\b(box|block|plate|bracket|slab|bar|cube|panel|envelope)\b/, "Part::Box"]
];

function resolveFreecadTypeId(type: string, genericType?: string): string | null {
  // An exact FreeCAD TypeId always wins -- never re-interpret a caller who
  // already knows precisely what they want.
  if (Object.prototype.hasOwnProperty.call(SUPPORTED_CREATE_TYPES, type)) return type;

  const haystack = `${type} ${genericType ?? ""}`.toLowerCase();
  for (const [pattern, typeId] of TYPE_KEYWORDS) {
    if (pattern.test(haystack)) return typeId;
  }

  // Nothing named a shape. Fall back to a box ONLY for the generic
  // "some solid thing" labels, which is what a design specification says
  // when it is describing an envelope rather than a specific primitive.
  if (genericType === "solid" || genericType === "container") return "Part::Box";
  const normalizedType = type.toLowerCase();
  if ((normalizedType === "part" || normalizedType === "solid") && (genericType === undefined || genericType === "unknown")) return "Part::Box";
  return null;
}

/**
 * The properties this adapter can genuinely write, per FreeCAD type, and
 * the ordinary engineering words that mean each one.
 *
 * This MUST stay in lockstep with runner.py's own SUPPORTED_MUTATIONS --
 * that allowlist is the real enforcement boundary; this table only
 * translates vocabulary before a request reaches it, and can never widen
 * what the runner accepts.
 *
 * Synonyms are deliberately type-scoped rather than global. "Thickness"
 * means Height on a box, but a torus has no Height at all, and mapping it
 * there would turn a merely-imprecise request into a rejected one. Only
 * genuine synonyms for the SAME physical dimension appear here -- notably
 * "diameter" is absent everywhere, because silently treating a diameter
 * as a radius would build the part at half size while reporting success.
 */
const SUPPORTED_CREATE_TYPES: Record<string, { properties: readonly string[]; synonyms: Record<string, string> }> = {
  "Part::Box": {
    properties: ["Length", "Width", "Height"],
    synonyms: { length: "Length", long: "Length", width: "Width", wide: "Width", depth: "Width", height: "Height", tall: "Height", thickness: "Height", thick: "Height" }
  },
  "Part::Cylinder": {
    properties: ["Radius", "Height"],
    synonyms: { radius: "Radius", height: "Height", tall: "Height", length: "Height", thickness: "Height", thick: "Height", depth: "Height" }
  },
  "Part::Torus": {
    // Radius1 is the ring radius (how big the wheel is); Radius2 is the
    // tube radius (how fat the tyre is).
    properties: ["Radius1", "Radius2"],
    synonyms: { radius1: "Radius1", radius2: "Radius2", ringradius: "Radius1", tuberadius: "Radius2", thickness: "Radius2", thick: "Radius2", width: "Radius2", radius: "Radius1" }
  }
};

/** Translates one caller-supplied property name into the real FreeCAD
 * property for that type, leaving anything unrecognised untouched so the
 * runner rejects it honestly rather than this layer guessing. */
function resolvePropertyKey(typeId: string, key: string): string {
  const spec = SUPPORTED_CREATE_TYPES[typeId];
  if (!spec) return key;
  if (spec.properties.includes(key)) return key;
  return spec.synonyms[key.toLowerCase().replace(/[\s_-]/g, "")] ?? key;
}

const REJECTION_REASON_TO_ERROR_KIND: Record<string, EnvironmentErrorKind> = {
  unsupported_target_type: "invalid_operation",
  unsupported_property: "invalid_operation",
  read_only_property: "invalid_operation",
  invalid_value: "invalid_operation",
  value_out_of_range: "invalid_operation",
  invalid_resulting_geometry: "invalid_operation",
  property_read_failed: "environment_failure",
  stale_state: "conflict"
};

/**
 * Shape-combining operations that are real in FreeCAD but have no place
 * in the shared `EnvironmentAdapter` contract, because they are not
 * meaningful for every environment (a simulation has no solids to
 * subtract). Exposed on the FreeCAD adapter specifically rather than
 * widened into the core interface, so no other adapter is forced to
 * pretend it can do this.
 */
export interface FreeCadAdapter extends EnvironmentAdapter {
  /** Subtracts, unions or intersects two existing solids. FreeCAD
   * consumes both operands into the result -- that is its own model. */
  booleanObject(
    session: EnvironmentSession,
    input: { kind: "cut" | "fuse" | "common"; baseId: string; toolId: string; name?: string }
  ): Promise<EnvironmentOperationResult>;
  /** Rounds EVERY edge of one solid by a single radius. */
  filletObject(session: EnvironmentSession, input: { objectId: string; radius: number; name?: string }): Promise<EnvironmentOperationResult>;
}

export function createFreeCadAdapter(options: FreeCadAdapterOptions = {}): FreeCadAdapter {
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
  //
  // "modify" (Phase 14): real, but deliberately NARROW -- see runner.py's
  // SUPPORTED_MUTATIONS. This is not "FreeCAD can now be edited" in
  // general; it is "exactly the properties in that allowlist can be set,
  // through the same validated, permission-gated path every other mutate
  // tool in this repository already goes through." create/delete/
  // checkpoint remain unsupported in this phase.
  const descriptor = createEnvironmentDescriptor({
    kind: "freecad",
    name: "FreeCAD",
    version: "1.0.0",
    capabilities: ["save", "modify", "create", "checkpoint"]
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

  /** Best-effort, same discipline as tryBuildInspectionErrors: a malformed
   * propertyChanges entry from runner.py is diagnostic metadata about a
   * successful mutation, not the mutation's own core result -- skipped
   * rather than turning an otherwise-successful modifyObject into a
   * failure. */
  function tryBuildPropertyChanges(raw: unknown): EnvironmentPropertyChange[] {
    if (!Array.isArray(raw)) return [];
    const changes: EnvironmentPropertyChange[] = [];
    for (const entry of raw) {
      const record = entry as RawFreecadPropertyChange;
      if (typeof record.key !== "string" || record.key.length === 0) continue;
      try {
        changes.push(createEnvironmentPropertyChange({ key: record.key, before: record.before, requested: record.requested, after: record.after }));
      } catch {
        continue;
      }
    }
    return changes;
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

    async createObject(session, input) {
      const guard = requireConnected(session, "create_object");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("create", "create_object", session.id, null);
      if (capabilityGuard) return capabilityGuard;

      // AUDIT FIX: reproduced live -- a real, connected FreeCAD document
      // with no pre-existing geometry could never receive any, because
      // this method always failed with "unsupported_capability" no matter
      // what a caller asked for. Deliberately as narrow as
      // modifyObject/runner.py's SUPPORTED_MUTATIONS: the only type this
      // adapter creates is Part::Box, the one TypeId already fully
      // validated for mutation.
      //
      // `input.type` arrives as a GENERIC label (e.g. "part"/"solid"), the
      // same vocabulary every caller in this codebase already uses (model-
      // generated proposals, `EnvironmentObjectGenericType`) -- never
      // FreeCAD's own internal TypeId string, which no caller outside this
      // adapter has any reason to know. `resolveFreecadTypeId` is the one
      // place that translation happens; runner.py stays keyed on the real
      // "Part::Box" TypeId, exactly like modify_object already is.
      const freecadTypeId = resolveFreecadTypeId(input.type, input.genericType);
      if (!freecadTypeId) {
        return failure(
          "create_object",
          session.id,
          null,
          "invalid_operation",
          `Cannot create an object of type "${input.type}"${input.genericType ? ` (genericType "${input.genericType}")` : ""} -- only a box/solid/container (Part::Box) is supported`
        );
      }

      // `input.properties` arrives as the generic `EnvironmentPropertyInput[]`
      // shape every adapter's createObject receives (see
      // create-environment-object-tool.ts) -- flattened to a plain record
      // here because that is what runner.py's SUPPORTED_MUTATIONS-keyed
      // validation (identical to modify_object's) expects.
      const properties = Object.fromEntries(input.properties?.map((property) => [resolvePropertyKey(freecadTypeId, property.key), property.value]) ?? []);
      const result = await runOperation("create_object", {
        filePath: guard.filePath,
        type: freecadTypeId,
        name: input.name,
        properties
      });
      if (result.status === "error") return failure("create_object", session.id, null, result.kind, result.message);

      const data = result.data as { rejected?: unknown; reason?: unknown; message?: unknown; object?: unknown; inspectionErrors?: unknown; warnings?: unknown };
      if (data.rejected) {
        // runner.py already validated type/property/value BEFORE ever
        // calling doc.addObject() and rejected this request without
        // creating anything -- same rejection vocabulary modifyObject's
        // identical mapping already covers.
        const reason = typeof data.reason === "string" ? data.reason : "invalid_operation";
        const kind = REJECTION_REASON_TO_ERROR_KIND[reason] ?? "invalid_operation";
        const message = typeof data.message === "string" ? data.message : "Object creation was rejected";
        return failure("create_object", session.id, null, kind, message);
      }

      const object = tryBuildObject(data.object);
      if ("message" in object) {
        return failure("create_object", session.id, null, "environment_failure", `Malformed object from FreeCAD: ${object.message}`);
      }
      const inspectionErrors = tryBuildInspectionErrors(data.inspectionErrors);
      const warnings = Array.isArray(data.warnings) ? (data.warnings as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
      return success("create_object", session.id, object.id, object, {
        ...(inspectionErrors.length > 0 ? { inspectionErrors } : {}),
        ...(warnings.length > 0 ? { warnings } : {})
      });
    },

    async booleanObject(session, input) {
      const guard = requireConnected(session, "create_object");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("create", "create_object", session.id, null);
      if (capabilityGuard) return capabilityGuard;

      const result = await runOperation("boolean_object", {
        filePath: guard.filePath,
        kind: input.kind,
        baseId: input.baseId,
        toolId: input.toolId,
        name: input.name ?? "Boolean"
      });
      if (result.status === "error") return failure("create_object", session.id, null, result.kind, result.message);

      const data = result.data as { found?: unknown; missing?: unknown; rejected?: unknown; reason?: unknown; message?: unknown; object?: unknown };
      if (data.found === false) {
        return failure("create_object", session.id, null, "object_not_found", `No object with id "${String(data.missing)}" in the connected document`);
      }
      if (data.rejected === true) {
        const kind = REJECTION_REASON_TO_ERROR_KIND[String(data.reason)] ?? "invalid_operation";
        return failure("create_object", session.id, null, kind, String(data.message ?? "The boolean was rejected"));
      }
      const object = tryBuildObject(data.object);
      if ("message" in object) return failure("create_object", session.id, null, "environment_failure", object.message);
      return success("create_object", session.id, object.id, object, {});
    },

    async filletObject(session, input) {
      const guard = requireConnected(session, "create_object");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("create", "create_object", session.id, null);
      if (capabilityGuard) return capabilityGuard;

      const result = await runOperation("fillet_object", {
        filePath: guard.filePath,
        objectId: input.objectId,
        radius: input.radius,
        name: input.name ?? "Fillet"
      });
      if (result.status === "error") return failure("create_object", session.id, null, result.kind, result.message);

      const data = result.data as { found?: unknown; missing?: unknown; rejected?: unknown; reason?: unknown; message?: unknown; object?: unknown };
      if (data.found === false) {
        return failure("create_object", session.id, null, "object_not_found", `No object with id "${String(data.missing)}" in the connected document`);
      }
      if (data.rejected === true) {
        const kind = REJECTION_REASON_TO_ERROR_KIND[String(data.reason)] ?? "invalid_operation";
        return failure("create_object", session.id, null, kind, String(data.message ?? "The fillet was rejected"));
      }
      const object = tryBuildObject(data.object);
      if ("message" in object) return failure("create_object", session.id, null, "environment_failure", object.message);
      return success("create_object", session.id, object.id, object, {});
    },

    async modifyObject(session, objectId, changes, options) {
      const guard = requireConnected(session, "modify_object", objectId);
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("modify", "modify_object", session.id, objectId);
      if (capabilityGuard) return capabilityGuard;

      const result = await runOperation("modify_object", {
        filePath: guard.filePath,
        objectId,
        // Property-name synonyms are resolved in runner.py, which is the
        // only side that knows this object's real TypeId (see
        // PROPERTY_SYNONYMS there) -- so raw keys are passed through.
        changes,
        expectedBefore: options?.expectedBefore ?? null
      });
      if (result.status === "error") return failure("modify_object", session.id, objectId, result.kind, result.message);

      const data = result.data as {
        found?: unknown;
        rejected?: unknown;
        reason?: unknown;
        message?: unknown;
        alreadySatisfied?: unknown;
        propertyChanges?: unknown;
        object?: unknown;
        inspectionErrors?: unknown;
        warnings?: unknown;
      };
      if (!data.found) {
        return failure("modify_object", session.id, objectId, "object_not_found", `No object with id "${objectId}"`);
      }
      if (data.rejected) {
        // Phase 14 Step 9/13: runner.py already validated target/property/
        // value/state BEFORE touching FreeCAD and rejected this request
        // without mutating anything -- map its specific reason onto this
        // adapter's own error vocabulary rather than collapsing every
        // rejection into one generic "modification failed".
        const reason = typeof data.reason === "string" ? data.reason : "invalid_operation";
        const kind = REJECTION_REASON_TO_ERROR_KIND[reason] ?? "invalid_operation";
        const message = typeof data.message === "string" ? data.message : `Modification of "${objectId}" was rejected`;
        return failure("modify_object", session.id, objectId, kind, message);
      }

      // Phase 14 Step 13/16 audit finding: the mutation already happened
      // and was persisted by this point (runner.py only reaches here after
      // its own doc.save()) -- runner.py's own op_modify_object already
      // degrades through two fallback tiers (full re-inspect -> lighter
      // no-geometry re-inspect -> a minimal literal built from data it
      // already has, no further FreeCAD calls) specifically so `data.object`
      // essentially always builds successfully even if the post-mutation
      // re-read itself had trouble -- see that function's own comment. Any
      // warnings from that degradation are still surfaced here.
      const object = tryBuildObject(data.object);
      if ("message" in object) {
        return failure("modify_object", session.id, objectId, "environment_failure", `Malformed object from FreeCAD: ${object.message}`);
      }
      const propertyChanges = tryBuildPropertyChanges(data.propertyChanges);
      const inspectionErrors = tryBuildInspectionErrors(data.inspectionErrors);
      const warnings = Array.isArray(data.warnings) ? (data.warnings as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
      return success("modify_object", session.id, objectId, object, {
        propertyChanges,
        alreadySatisfied: data.alreadySatisfied === true,
        ...(inspectionErrors.length > 0 ? { inspectionErrors } : {}),
        ...(warnings.length > 0 ? { warnings } : {})
      });
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
      // Phase 15: a REAL snapshot -- runner.py's op_checkpoint copies the
      // live .FCStd file to a sibling ".naqsh_checkpoints" directory and
      // returns its own opaque id. This adapter never inspects or
      // interprets that id -- it is only ever stored and later handed
      // back to `restore()` verbatim (see environment-adapter.ts's own
      // "core must never know FreeCAD file formats" boundary).
      const result = await runOperation("checkpoint", { filePath: guard.filePath });
      if (result.status === "error") return failure("checkpoint", session.id, null, result.kind, result.message);
      const data = result.data as { checkpointId?: unknown };
      if (typeof data.checkpointId !== "string" || data.checkpointId.length === 0) {
        return failure("checkpoint", session.id, null, "environment_failure", "FreeCAD runner reported success but returned no checkpointId");
      }
      return success("checkpoint", session.id, null, { checkpointId: data.checkpointId });
    },

    async restore(session, checkpointId) {
      const guard = requireConnected(session, "restore");
      if (guard.result) return guard.result;
      const capabilityGuard = requireCapability("checkpoint", "restore", session.id, null);
      if (capabilityGuard) return capabilityGuard;
      const result = await runOperation("restore", { filePath: guard.filePath, checkpointId });
      if (result.status === "error") return failure("restore", session.id, null, result.kind, result.message);
      const data = result.data as { found?: unknown };
      if (!data.found) {
        return failure("restore", session.id, null, "object_not_found", `No checkpoint with id "${checkpointId}"`);
      }
      return success("restore", session.id, null, null);
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
