import type {
  EnvironmentCapability,
  EnvironmentDescriptor,
  EnvironmentObjectId,
  EnvironmentObjectInput,
  EnvironmentOperationResult,
  EnvironmentSession
} from "@naqsh/schemas";

/**
 * The Universal Environment Adapter contract (P5) — the ONLY way
 * @naqsh/core is allowed to talk to an external engineering environment
 * (CAD, simulation, manufacturing, robotics, EDA, ...). This interface
 * lives in core (not an adapter package) for the same reason
 * `ToolRegistry`'s interface lives in core: core CONSUMES it and must be
 * able to name the type without depending on any concrete implementation.
 * Concrete adapters (the mocks in @naqsh/adapters now, FreeCADAdapter in
 * P12+) live strictly "below" this boundary and depend ON core/schemas,
 * never the reverse — enforced as a regression test in
 * packages/core/test/repo-boundaries.test.ts.
 *
 * Every method returns `Promise<EnvironmentOperationResult>` (never a bare
 * value, never a thrown exception for an EXPECTED failure) — the exact
 * discipline `executeTool` (P3) already established for tools: a caller
 * branches on `result.status`/`result.error.kind`, never wraps every call
 * in try/catch. `describe()` is the one exception: it is synchronous,
 * static, and cannot fail.
 *
 * FIVE methods (`createObject`/`modifyObject`/`deleteObject`/`save`/
 * `checkpoint`/`restore` — six, matching the five `EnvironmentCapability`
 * values with `checkpoint` covering both snapshot and restore) are
 * OPTIONAL in the sense that an adapter may not actually support them —
 * but the METHOD still exists on every adapter (there is no "optional
 * method" in this interface). An adapter that doesn't support "create"
 * still has a `createObject` method; calling it resolves to
 * `{status:"error", error:{kind:"unsupported_capability"}}`. This is what
 * the P5 brief means by "expose capabilities explicitly AND fail
 * deterministically" — both at once, not one instead of the other — and
 * it is what makes ONE reusable contract-test suite
 * (environment-adapter-contract.ts) runnable against every adapter
 * regardless of what it supports.
 *
 * World Model boundary: nothing here ever touches `WorldModelState`,
 * `ChangeHistory`, or `updateWorldModel`. An adapter reports what an
 * environment has; reconciling that into NAQSH's own understanding
 * (Environment → observation → interpretation → World Model update) is a
 * later phase's job (P8), deliberately not this one's — enforced as a
 * regression test alongside the dependency-direction ones.
 *
 * Authorization boundary: this interface has no concept of `AutonomyLevel`,
 * `Approval`, or `AutonomyGrant`, and no implementation of it may import
 * P4's authorization machinery (enforced in repo-boundaries.test.ts) — an
 * adapter is a dumb, uniformly-callable mechanism, never a policy decision
 * point. That is deliberate, not a gap: P6+ orchestration must call an
 * adapter method ONLY from inside a `Tool` handler, so the call is subject
 * to `executeTool`'s `authorize` hook first. Any future code that holds an
 * `EnvironmentAdapter` reference outside of a tool handler and calls it
 * directly bypasses P4 authorization entirely — that is a misuse of this
 * interface, not a supported integration path.
 */
export interface EnvironmentAdapter {
  /** Static identity + capabilities. Cannot fail. */
  describe(): EnvironmentDescriptor;

  /** Whether/how the environment is reachable, independent of any open
   * session. `data` is an `EnvironmentHealth` on success. Checking health
   * and the environment BEING unhealthy are different things: a
   * successfully-performed check that reports "unavailable" is still
   * `status: "success"`; only a check that could not be performed at all
   * is `status: "error"` (kind "environment_failure"). */
  health(): Promise<EnvironmentOperationResult>;

  /** `data` is an `EnvironmentSession` on success. `options` is an
   * environment-specific, JSON-safe bag (e.g. which document/file to open,
   * or a remote endpoint to reach) — optional and ignorable by an adapter
   * that only ever has one implicit target, but required for a real
   * environment to know WHAT to connect to. Unlike every other write
   * parameter on this interface (`input`, `changes`), this one has no
   * fixed shape, because "what identifies a target" is inherently
   * environment-specific (a file path for FreeCAD, a URL for a remote
   * simulator, nothing at all for a fixed in-memory mock). */
  connect(options?: Record<string, unknown>): Promise<EnvironmentOperationResult>;

  /** `data` is null on success. Operating on a disconnected/unknown
   * session afterward resolves to kind "not_connected". */
  disconnect(session: EnvironmentSession): Promise<EnvironmentOperationResult>;

  /** `data` is `EnvironmentObject[]` on success. */
  listObjects(session: EnvironmentSession): Promise<EnvironmentOperationResult>;

  /** `data` is a single `EnvironmentObject` on success; kind
   * "object_not_found" if `objectId` doesn't exist in this session. */
  inspectObject(session: EnvironmentSession, objectId: EnvironmentObjectId): Promise<EnvironmentOperationResult>;

  /** `data` is a single `EnvironmentDocumentInspection` on success (Phase
   * 13) — the CHEAPEST inspection tier: document identity, object
   * count/ids, and hierarchy roots, with no per-object properties,
   * relationships, or geometry (call `listObjects`/`inspectObject` for
   * those). Every adapter MUST implement this the same way it must
   * implement every other method on this interface — an adapter that has
   * no richer document concept than "the current session" still returns a
   * well-formed `EnvironmentDocumentInspection` (e.g. built entirely from
   * `session`/its own seed state), never `unsupported_capability`:
   * inspecting what is currently connected is baseline, not optional,
   * exactly like `listObjects`/`inspectObject` already are. */
  inspectDocument(session: EnvironmentSession): Promise<EnvironmentOperationResult>;

  /** Requires the "create" capability. `data` is the newly created
   * `EnvironmentObject` (with its assigned id) on success. */
  createObject(session: EnvironmentSession, input: EnvironmentObjectInput): Promise<EnvironmentOperationResult>;

  /** Requires the "modify" capability. `changes` is a flat key -> new
   * value map. `data` is the updated `EnvironmentObject` on success;
   * kind "invalid_operation" if a targeted key is `readOnly`. */
  modifyObject(
    session: EnvironmentSession,
    objectId: EnvironmentObjectId,
    changes: Record<string, unknown>
  ): Promise<EnvironmentOperationResult>;

  /** Requires the "delete" capability. `data` is null on success. */
  deleteObject(session: EnvironmentSession, objectId: EnvironmentObjectId): Promise<EnvironmentOperationResult>;

  /** Requires the "save" capability. `data` is null on success. */
  save(session: EnvironmentSession): Promise<EnvironmentOperationResult>;

  /** Requires the "checkpoint" capability. `data` is
   * `{ checkpointId: string }` on success. */
  checkpoint(session: EnvironmentSession): Promise<EnvironmentOperationResult>;

  /** Requires the "checkpoint" capability. `data` is null on success;
   * kind "object_not_found" is reused for an unknown `checkpointId`
   * (it is, structurally, the same "no such record" failure). */
  restore(session: EnvironmentSession, checkpointId: string): Promise<EnvironmentOperationResult>;
}

/** Pure helper: does `descriptor` declare `capability`? A caller SHOULD
 * check this before calling an optional operation (to avoid a pointless
 * round trip), but every adapter method still fails deterministically on
 * its own if called anyway — this is a convenience, not the enforcement
 * mechanism. Deliberately a free function, not a method on the interface:
 * it is derived, stateless logic every adapter would otherwise have to
 * reimplement identically. */
export function supportsCapability(descriptor: EnvironmentDescriptor, capability: EnvironmentCapability): boolean {
  return descriptor.capabilities.includes(capability);
}
