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

/** A raw, adapter-reported object — deliberately NOT `EngineeringObject`.
 * See this file's header comment for why the two stay separate. */
export interface EnvironmentObject {
  id: EnvironmentObjectId;
  type: string;
  name: string;
  properties: EnvironmentProperty[];
  relationships: EnvironmentRelationship[];
  metadata: Record<string, unknown>;
}

/** Input for creating one. Properties are a flat, caller-supplied list
 * (no `readOnly` — that's an adapter-determined trait reported back on
 * the resulting `EnvironmentObject`, not something a caller declares). */
export interface EnvironmentObjectInput {
  id?: EnvironmentObjectId;
  type: string;
  name: string;
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
