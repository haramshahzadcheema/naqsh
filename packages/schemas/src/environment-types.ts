/**
 * The Universal Environment Adapter contract's DATA half (P5).
 *
 * These types describe what an EXTERNAL engineering environment (CAD,
 * simulation, manufacturing, robotics, EDA, ...) reports and allows NAQSH
 * to do — NOT NAQSH's own understanding of the project. That is
 * `EngineeringObject`/`Project` in types.ts (the World Model), which stays
 * completely separate on purpose: an `EnvironmentObject` is a raw,
 * adapter-reported fact ("the environment currently has an object shaped
 * like this"), while an `EngineeringObject` is NAQSH's interpreted domain
 * belief. Reconciling one into the other (Environment → observation →
 * interpretation → World Model update) is a later phase's job (P8) — P5
 * must not, and does not, auto-write into WorldModelState. Nothing in this
 * file imports from transitions.ts, and nothing in transitions.ts
 * references anything here; that separation is enforced as a regression
 * test in packages/core/test/repo-boundaries.test.ts.
 *
 * The behavioral half — the `EnvironmentAdapter` interface itself, which
 * has methods, not just data — lives in @naqsh/core (environment-
 * adapter.ts), exactly like `ToolRegistry`'s interface lives in core while
 * `Tool` (data) lives here.
 */

/**
 * What an environment CAN do beyond the baseline every adapter supports
 * (describe/health/connect/disconnect/listObjects/inspectObject — reading
 * is always assumed possible, since an adapter you can't even observe
 * would be useless). Everything else is optional and must be declared
 * explicitly via `EnvironmentDescriptor.capabilities` — an adapter that
 * doesn't declare "create" must still HAVE a `createObject` method (see
 * EnvironmentAdapter in core), but calling it returns a structured
 * "unsupported_capability" error result rather than throwing or silently
 * no-op'ing. This is what lets one reusable contract-test suite run
 * against adapters with entirely different capability profiles.
 */
export type EnvironmentCapability = "create" | "modify" | "delete" | "save" | "checkpoint";

export const ENVIRONMENT_CAPABILITIES: readonly EnvironmentCapability[] = [
  "create",
  "modify",
  "delete",
  "save",
  "checkpoint"
];

/** Environment-level identity — analogous to `Tool`'s identity fields.
 * `kind` is the stable, code-referenced identifier (e.g. "mock_cad",
 * "freecad" later); `capabilities` is what a caller should check via
 * `supportsCapability()` (core) before assuming an optional operation will
 * succeed, though every method still fails deterministically either way. */
export interface EnvironmentDescriptor {
  kind: string;
  name: string;
  version: string;
  capabilities: EnvironmentCapability[];
  metadata: Record<string, unknown>;
}

export interface EnvironmentDescriptorInput {
  kind: string;
  name: string;
  version?: string;
  capabilities?: EnvironmentCapability[];
  metadata?: Record<string, unknown>;
}

export type EnvironmentSessionStatus = "connected" | "disconnected";

export const ENVIRONMENT_SESSION_STATUSES: readonly EnvironmentSessionStatus[] = ["connected", "disconnected"];

/** An open connection to one environment instance/document. Covers the
 * "inspect document/project" tier (distinct from environment-level
 * `EnvironmentDescriptor` and object-level `EnvironmentObject` inspection)
 * via `documentName`, rather than a dedicated inspection method — a
 * session already carries the project-level identity a caller needs. */
export interface EnvironmentSession {
  id: string;
  environmentKind: string;
  status: EnvironmentSessionStatus;
  documentName: string | null;
  openedAt: string;
  metadata: Record<string, unknown>;
}

export interface EnvironmentSessionInput {
  id?: string;
  environmentKind: string;
  status?: EnvironmentSessionStatus;
  documentName?: string | null;
  openedAt?: string;
  metadata?: Record<string, unknown>;
}

/** A plain string on purpose, matching every other entity id in this
 * package — not branded, not opaque. It is meaningful only within the
 * environment that issued it (never assumed to correlate with any World
 * Model id). */
export type EnvironmentObjectId = string;

export interface EnvironmentProperty {
  key: string;
  value: unknown;
  /** Whether THIS property can be modified, independent of whether the
   * environment as a whole declares the "modify" capability — an object
   * can have some computed/derived read-only properties even in a fully
   * writable environment. */
  readOnly: boolean;
}

export interface EnvironmentPropertyInput {
  key: string;
  value: unknown;
  readOnly?: boolean;
}

export interface EnvironmentRelationship {
  type: string;
  targetId: EnvironmentObjectId;
  metadata: Record<string, unknown>;
}

export interface EnvironmentRelationshipInput {
  type: string;
  targetId: EnvironmentObjectId;
  metadata?: Record<string, unknown>;
}

/**
 * A NORMALIZED, small, extensible object category (Phase 13 Step 6) — every
 * adapter maps its own environment-specific type string (still carried
 * verbatim in `EnvironmentObject.type`, e.g. FreeCAD's `"Part::Box"`) onto
 * one of these. Deliberately NOT a giant universal engineering ontology:
 * only categories a real adapter can classify RELIABLY (via an explicit,
 * documented mechanism, never a guess) are included. `"unknown"` is the
 * correct, honest answer whenever an object doesn't match a reliable rule —
 * a false-but-specific classification is worse than an honest "unknown".
 * Closed-but-additive, matching `ToolTarget`/`EntitySource`'s convention:
 * extend only when a real adapter can reliably produce a new value, never
 * speculatively.
 */
export type EnvironmentObjectGenericType = "solid" | "sketch" | "container" | "datum" | "link" | "unknown";

export const ENVIRONMENT_OBJECT_GENERIC_TYPES: readonly EnvironmentObjectGenericType[] = [
  "solid",
  "sketch",
  "container",
  "datum",
  "link",
  "unknown"
];

/** A plain 3-component vector — reused by bounding box corners and center
 * of mass. Not `EnvironmentProperty`'s normalized `{x,y,z}` Vector shape
 * (that one is a property VALUE); this is a fixed geometry field shape. */
export interface EnvironmentVector3 {
  x: number;
  y: number;
  z: number;
}

export interface EnvironmentBoundingBox {
  min: EnvironmentVector3;
  max: EnvironmentVector3;
}

/**
 * BOUNDED, best-effort geometry metadata (Phase 13 Step 12) — never a full
 * geometry kernel abstraction and never a BREP/topology dump. `available`
 * is false whenever no shape exists or the shape is invalid/unreadable;
 * `reason` explains why in that case (e.g. `"no_shape"`, `"invalid_shape"`).
 * When `available` is true, every OTHER field is still independently
 * nullable — a single metric an adapter could not safely compute (Phase 13
 * Step 7's "one bad property must not destroy the whole inspection", applied
 * to geometry) becomes `null` for just that field, never a reason to blank
 * out the rest or fail the object.
 */
export interface EnvironmentObjectGeometry {
  available: boolean;
  reason: string | null;
  valid: boolean | null;
  boundingBox: EnvironmentBoundingBox | null;
  volume: number | null;
  surfaceArea: number | null;
  centerOfMass: EnvironmentVector3 | null;
  solidCount: number | null;
  faceCount: number | null;
  edgeCount: number | null;
  vertexCount: number | null;
  shapeType: string | null;
}

export interface EnvironmentObjectGeometryInput {
  available?: boolean;
  reason?: string | null;
  valid?: boolean | null;
  boundingBox?: EnvironmentBoundingBox | null;
  volume?: number | null;
  surfaceArea?: number | null;
  centerOfMass?: EnvironmentVector3 | null;
  solidCount?: number | null;
  faceCount?: number | null;
  edgeCount?: number | null;
  vertexCount?: number | null;
  shapeType?: string | null;
}

/** The canonical "nothing computed" geometry value — what an adapter that
 * never attempts geometry inspection (e.g. a non-CAD mock) should report,
 * and the default `createEnvironmentObject` applies when a caller supplies
 * no `geometry` input at all. */
export const UNAVAILABLE_ENVIRONMENT_GEOMETRY: EnvironmentObjectGeometry = Object.freeze({
  available: false,
  reason: null,
  valid: null,
  boundingBox: null,
  volume: null,
  surfaceArea: null,
  centerOfMass: null,
  solidCount: null,
  faceCount: null,
  edgeCount: null,
  vertexCount: null,
  shapeType: null
});

/** A raw, adapter-reported object — deliberately NOT `EngineeringObject`.
 * See this file's header comment for why the two stay separate.
 *
 * Object identity (Phase 13 Step 5): `id` is only as stable as the
 * ADAPTER that issued it documents it to be — this generic type makes no
 * universal promise beyond "stable enough to re-identify this object
 * across calls within the SAME connected session". A real adapter (see
 * FreeCADAdapter) must document its own, possibly weaker, guarantee (e.g.
 * "document-stable, not globally unique, not persistence-guaranteed")
 * rather than letting a caller assume more than the environment actually
 * provides. */
export interface EnvironmentObject {
  id: EnvironmentObjectId;
  type: string;
  name: string;
  /** Normalized category — see `EnvironmentObjectGenericType`. `type`
   * above remains the environment-specific type string; this is the
   * additional, generic classification derived from it. */
  genericType: EnvironmentObjectGenericType;
  /** The `id` of this object's containing object (a group/assembly/part),
   * or `null` if this object has no known container (top-level, or the
   * environment doesn't expose containment). Only ever set from a
   * RELIABLE, environment-reported containment mechanism — never inferred
   * from position, naming, or proximity (Phase 13 Step 9/10). */
  parentId: EnvironmentObjectId | null;
  /** Whether the object is currently shown/hidden in the environment, or
   * `null` if the environment doesn't expose this for this object. */
  visible: boolean | null;
  /** Bounded, best-effort geometry metadata — see
   * `EnvironmentObjectGeometry`. Always present (never a separate optional
   * field) so every caller can check `.available` uniformly; defaults to
   * `UNAVAILABLE_ENVIRONMENT_GEOMETRY` when an adapter/mock never attempts
   * geometry inspection. */
  geometry: EnvironmentObjectGeometry;
  properties: EnvironmentProperty[];
  relationships: EnvironmentRelationship[];
  metadata: Record<string, unknown>;
}

/** Input for creating one. Properties are a flat, caller-supplied list
 * (no `readOnly` — that's an adapter-determined trait reported back on
 * the resulting `EnvironmentObject`, not something a caller declares).
 * `genericType`/`parentId`/`visible`/`geometry` are all optional and
 * default to "nothing known" — existing callers (mock seed data, the
 * `create_object` capability) do not need to supply Phase 13's richer
 * inspection fields to keep constructing valid objects. */
export interface EnvironmentObjectInput {
  id?: EnvironmentObjectId;
  type: string;
  name: string;
  genericType?: EnvironmentObjectGenericType;
  parentId?: EnvironmentObjectId | null;
  visible?: boolean | null;
  geometry?: EnvironmentObjectGeometryInput;
  properties?: EnvironmentPropertyInput[];
  relationships?: EnvironmentRelationshipInput[];
  metadata?: Record<string, unknown>;
}

export type EnvironmentHealthStatus = "healthy" | "degraded" | "unavailable";

export const ENVIRONMENT_HEALTH_STATUSES: readonly EnvironmentHealthStatus[] = [
  "healthy",
  "degraded",
  "unavailable"
];

/** The DATA a health check reports. Checking health is itself an
 * operation that can succeed (you got an answer, even if the answer is
 * "unavailable") or fail (environment_failure — you couldn't even
 * determine health) — see EnvironmentOperationResult; this type is what
 * fills `data` when it succeeds. */
export interface EnvironmentHealth {
  status: EnvironmentHealthStatus;
  message: string;
  checkedAt: string;
}

export interface EnvironmentHealthInput {
  status: EnvironmentHealthStatus;
  message?: string;
  checkedAt?: string;
}

/** Every operation `EnvironmentAdapter` (core) exposes — used to tag
 * `EnvironmentOperationResult` so a caller/auditor always knows what
 * happened without re-deriving it from context. */
export type EnvironmentOperationKind =
  | "health"
  | "connect"
  | "disconnect"
  | "list_objects"
  | "inspect_object"
  | "inspect_document"
  | "create_object"
  | "modify_object"
  | "delete_object"
  | "save"
  | "checkpoint"
  | "restore";

export const ENVIRONMENT_OPERATION_KINDS: readonly EnvironmentOperationKind[] = [
  "health",
  "connect",
  "disconnect",
  "list_objects",
  "inspect_object",
  "inspect_document",
  "create_object",
  "modify_object",
  "delete_object",
  "save",
  "checkpoint",
  "restore"
];

/**
 * Every distinct way an environment operation can fail, named specifically
 * enough that a caller can branch on `.kind` instead of parsing a message —
 * matching every failure mode the P5 brief names, no more.
 */
export type EnvironmentErrorKind =
  | "not_connected"
  | "object_not_found"
  | "unsupported_capability"
  | "invalid_operation"
  | "environment_failure"
  | "conflict";

export const ENVIRONMENT_ERROR_KINDS: readonly EnvironmentErrorKind[] = [
  "not_connected",
  "object_not_found",
  "unsupported_capability",
  "invalid_operation",
  "environment_failure",
  "conflict"
];

export interface EnvironmentOperationError {
  kind: EnvironmentErrorKind;
  message: string;
}

export type EnvironmentOperationStatus = "success" | "error";

/**
 * The one result shape every `EnvironmentAdapter` method resolves to
 * (`describe()` excepted — it is synchronous, static, and cannot fail).
 * Mirrors `ToolResult` (P3) deliberately: same never-throw-for-expected-
 * failures discipline, same self-describing identifiers for auditability
 * (what operation, what session, what object, when). `InspectionResult`/
 * `ModificationResult` below are named aliases of this ONE validated shape
 * — the P5 brief asks for both names, but a read result and a write
 * result don't need two different runtime contracts to be independently
 * maintained; only the `operation`/`data` values differ by call site.
 */
export interface EnvironmentOperationResult {
  id: string;
  operation: EnvironmentOperationKind;
  /** Null only for `connect` (no session exists until it succeeds) and a
   * pre-connection `health` check. */
  sessionId: string | null;
  /** Null for operations that don't target one specific object. */
  objectId: EnvironmentObjectId | null;
  status: EnvironmentOperationStatus;
  /** Present (non-null) iff status is "success". JSON-safe. */
  data: unknown;
  /** Present (non-null) iff status is "error". */
  error: EnvironmentOperationError | null;
  startedAt: string;
  completedAt: string;
  metadata: Record<string, unknown>;
}

export interface EnvironmentOperationResultInput {
  id?: string;
  operation: EnvironmentOperationKind;
  sessionId?: string | null;
  objectId?: EnvironmentObjectId | null;
  status: EnvironmentOperationStatus;
  data?: unknown;
  error?: EnvironmentOperationError | null;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Named per the P5 brief's explicit request — both are exactly
 * `EnvironmentOperationResult`; see that type's doc comment for why they
 * are aliases rather than separate validated shapes. */
export type InspectionResult = EnvironmentOperationResult;
export type ModificationResult = EnvironmentOperationResult;

/**
 * Every distinct way inspecting ONE PART of a document/object can fail
 * without failing the inspection as a whole (Phase 13 Step 15/16) — a
 * strictly finer-grained vocabulary than `EnvironmentErrorKind`, which
 * describes why an entire OPERATION failed. An `EnvironmentInspectionError`
 * never appears as `EnvironmentOperationResult.error` (that field is still
 * exactly the whole-operation outcome); it appears inside
 * `EnvironmentDocumentInspection.inspectionErrors` and inside a
 * successful `list_objects` result's `metadata.inspectionErrors`,
 * alongside objects that DID succeed — "one bad object/property must not
 * destroy the whole result" applies to inspection specifically.
 */
export type EnvironmentInspectionErrorKind =
  | "object_unavailable"
  | "unsupported_object_type"
  | "property_inspection_failed"
  | "relationship_inspection_failed"
  | "geometry_inspection_failed"
  | "serialization_failed";

export const ENVIRONMENT_INSPECTION_ERROR_KINDS: readonly EnvironmentInspectionErrorKind[] = [
  "object_unavailable",
  "unsupported_object_type",
  "property_inspection_failed",
  "relationship_inspection_failed",
  "geometry_inspection_failed",
  "serialization_failed"
];

export interface EnvironmentInspectionError {
  kind: EnvironmentInspectionErrorKind;
  /** Which object this failure concerns, or `null` for a document-wide
   * failure not attributable to one object. */
  objectId: EnvironmentObjectId | null;
  message: string;
}

export interface EnvironmentInspectionErrorInput {
  kind: EnvironmentInspectionErrorKind;
  objectId?: EnvironmentObjectId | null;
  message: string;
}

/**
 * Document-level inspection summary (Phase 13 Step 3/4) — the CHEAPEST
 * inspection tier: identity, object count/ids, and hierarchy roots, with
 * NO per-object properties/relationships/geometry (those come from
 * `listObjects`/`inspectObject`). Deliberately separate from
 * `EnvironmentSession`: a session is "what NAQSH has open"; this is "what
 * the environment reports the open document CURRENTLY contains", captured
 * at one point in time (`inspectedAt`) — calling `inspectDocument()` again
 * after a mutation can report a different value, exactly like every other
 * inspection call.
 *
 * FreeCAD document ≠ World Model (Phase 13 Step 17): this type is exactly
 * as far as the EnvironmentAdapter boundary goes. Reconciling it into
 * `WorldModelState` remains a separate, later concern, same as every other
 * `EnvironmentOperationResult.data` shape.
 */
export interface EnvironmentDocumentInspection {
  environmentKind: string;
  /** The environment's own internal document identifier (e.g. FreeCAD's
   * `doc.Name`), or `null` if the environment has none distinct from
   * `documentName`. */
  documentId: string | null;
  /** Human-facing document name/label, or `null` if unavailable. */
  documentName: string | null;
  /** Where the document is stored, if the environment exposes one (e.g. a
   * file path), or `null` for an in-memory-only/unsaved document. */
  filePath: string | null;
  objectCount: number;
  /** Every object id currently in the document, in a deterministic
   * (sorted) order — see Phase 13 Step 14. */
  objectIds: EnvironmentObjectId[];
  /** Object ids with no known containing object (top-level) — a
   * deterministic subset of `objectIds`. */
  rootObjectIds: EnvironmentObjectId[];
  /** When this inspection was performed. */
  inspectedAt: string;
  /** The environment's own reported version (e.g. "1.1.3"), or `null` if
   * genuinely unavailable — never fabricated (Phase 13 Step 3). */
  environmentVersion: string | null;
  warnings: string[];
  /** Environment features this adapter knows it cannot inspect (e.g. a
   * workbench-specific object kind), reported honestly rather than
   * silently ignored. */
  unsupportedFeatures: string[];
  inspectionErrors: EnvironmentInspectionError[];
  metadata: Record<string, unknown>;
}

export interface EnvironmentDocumentInspectionInput {
  environmentKind: string;
  documentId?: string | null;
  documentName?: string | null;
  filePath?: string | null;
  objectCount: number;
  objectIds?: EnvironmentObjectId[];
  rootObjectIds?: EnvironmentObjectId[];
  inspectedAt?: string;
  environmentVersion?: string | null;
  warnings?: string[];
  unsupportedFeatures?: string[];
  inspectionErrors?: EnvironmentInspectionErrorInput[];
  metadata?: Record<string, unknown>;
}

/**
 * ONE property's before/requested/after values for a single `modifyObject`
 * call (Phase 14 Step 5) — the "actual resulting state" record every real
 * mutation must produce, deliberately NOT a second Change/History
 * architecture: this rides inside `EnvironmentOperationResult.metadata.
 * propertyChanges` (see `FreeCadAdapter`/`createInMemoryEnvironmentAdapter`'s
 * `modifyObject`), which the existing P10/P11 audit trail
 * (`Proposal`/`Approval`/`ExecutionResult`/`AgentLoopRun`) already carries
 * end to end — it does not need its own storage/history/query layer.
 *
 * `requested` and `after` are NOT guaranteed equal: an environment may
 * clamp, round, or otherwise normalize a value (confirmed empirically
 * against real FreeCAD — an out-of-range value is silently clamped rather
 * than rejected by FreeCAD itself, which is exactly why an adapter must
 * report what ACTUALLY happened, not assume the setter's own "success"
 * means the requested value took effect verbatim).
 */
export interface EnvironmentPropertyChange {
  key: string;
  before: unknown;
  requested: unknown;
  after: unknown;
}

export interface EnvironmentPropertyChangeInput {
  key: string;
  before?: unknown;
  requested: unknown;
  after?: unknown;
}

/**
 * Optional per-call guards for `EnvironmentAdapter.modifyObject` (Phase 14
 * Step 14) — additive to the existing `(session, objectId, changes)`
 * signature established in P5, so every existing caller/adapter/mock that
 * omits this argument keeps working unchanged.
 *
 * `expectedBefore` protects against a STALE observation: if the caller
 * last observed a property's value as X and wants to change it only if it
 * is STILL X (nobody/nothing else changed it in between), it supplies
 * `{[key]: X}` here. An adapter that receives a mismatching current value
 * must reject the call with kind `"conflict"` and mutate nothing — never
 * blindly overwrite a environment that has moved on since it was last
 * observed. This is deliberately narrow: an equality guard per property,
 * not a general optimistic-concurrency/versioning system (that scope
 * belongs to a much later phase, if ever).
 */
export interface EnvironmentModifyObjectOptions {
  expectedBefore?: Record<string, unknown>;
}
