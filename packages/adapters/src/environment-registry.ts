import type { EnvironmentAdapter } from "@naqsh/core";
import { createMockCadEnvironment } from "./mock-cad-environment.js";
import { createMockSimulationEnvironment } from "./mock-simulation-environment.js";
import { createMockEnvironment } from "./mock-environment.js";
import { createFreeCadAdapter } from "./freecad-adapter.js";

/**
 * Phase 26: a typed, explicit environment SELECTOR -- "which adapter do I
 * want for this run" as a small, named lookup, never a giant `if (kind ===
 * "freecad") ... else if (kind === "mock_cad") ...` conditional scattered
 * through application code. Lives in `@naqsh/adapters`, NOT `@naqsh/core`,
 * on purpose: the whole point of this registry is to know about every
 * concrete adapter this repository ships (`mock_cad`/`mock_simulation`/
 * `mock`/`freecad`) -- importing all four into core would be exactly the
 * "core must not know FreeCAD exists" violation the P5/P12 boundary tests
 * already guard against. Core only ever receives an already-constructed
 * `EnvironmentAdapter` value; it never asks "by name" for one.
 *
 * Deliberately NOT a class with hidden module-level state: `createEnvironmentRegistry()`
 * returns a fresh, independent registry every call (mirrors every other
 * store in this repository's "no singleton" discipline -- see
 * `background-job-store.ts`'s (P25) identical reasoning). Two registries
 * never share registrations, and registering into one never affects
 * another -- essential for concurrent tests and for a future caller that
 * legitimately wants two differently-scoped registries (e.g. one exposing
 * only mocks in a sandboxed context, one also exposing `freecad`).
 */

export type EnvironmentRegistryErrorKind = "invalid_kind" | "duplicate_registration" | "unknown_environment" | "identity_mismatch";

/** Mirrors `ObservationError`/`EnvironmentError` (schemas)'s identical
 * `class XError extends Error { kind, message }` shape -- kept local to
 * this package rather than added to schemas because the registry itself is
 * an adapters-layer convenience, not part of the P5 `EnvironmentAdapter`
 * contract every adapter must satisfy. */
export class EnvironmentRegistryError extends Error {
  readonly kind: EnvironmentRegistryErrorKind;

  constructor(kind: EnvironmentRegistryErrorKind, message: string) {
    super(message);
    this.name = "EnvironmentRegistryError";
    this.kind = kind;
  }
}

export interface EnvironmentRegistration {
  /** The stable identifier a caller selects by -- must equal the `kind`
   * the constructed adapter's own `describe().kind` reports (checked at
   * `create()` time, not merely trusted), so a registry lookup and the
   * resulting adapter's self-reported identity can never silently
   * diverge. */
  kind: string;
  /** Human-readable, for `list()` -- never used for identity/lookup. */
  description: string;
  /** Constructs a FRESH adapter instance. Called anew on every `create()`
   * -- the registry never caches or reuses an adapter instance across
   * calls, so two callers requesting the same `kind` always get two
   * independent adapters (no shared mutable environment state, no hidden
   * global "the current environment"). */
  create: () => EnvironmentAdapter;
}

export interface EnvironmentRegistry {
  /** Throws `EnvironmentRegistryError` ("invalid_kind") for an empty/
   * non-string kind, or ("duplicate_registration") if `kind` is already
   * registered -- registration is one-shot per kind, per registry
   * instance; there is no "overwrite" operation. */
  register(registration: EnvironmentRegistration): void;
  /** Constructs and returns a fresh adapter for `kind`. Throws
   * `EnvironmentRegistryError` ("unknown_environment") if nothing is
   * registered under that name, or ("identity_mismatch") if the
   * constructed adapter's own `describe().kind` does not equal `kind` --
   * a registration bug (wiring the wrong factory to a name) fails loudly
   * here rather than silently handing back a mismatched adapter. */
  create(kind: string): EnvironmentAdapter;
  has(kind: string): boolean;
  /** Every registered kind + description, in registration order -- never
   * an adapter instance (constructing one is `create()`'s job, and doing
   * it eagerly here would mean listing has side effects). */
  list(): ReadonlyArray<{ kind: string; description: string }>;
}

export function createEnvironmentRegistry(): EnvironmentRegistry {
  const registrations = new Map<string, EnvironmentRegistration>();

  return {
    register(registration) {
      if (typeof registration.kind !== "string" || registration.kind.trim().length === 0) {
        throw new EnvironmentRegistryError("invalid_kind", "environment registration.kind must be a non-empty string");
      }
      if (registrations.has(registration.kind)) {
        throw new EnvironmentRegistryError("duplicate_registration", `environment "${registration.kind}" is already registered`);
      }
      registrations.set(registration.kind, registration);
    },
    create(kind) {
      const registration = registrations.get(kind);
      if (!registration) {
        throw new EnvironmentRegistryError(
          "unknown_environment",
          `no environment is registered for kind "${kind}" -- known kinds: ${Array.from(registrations.keys()).join(", ") || "(none)"}`
        );
      }
      const adapter = registration.create();
      const descriptor = adapter.describe();
      if (descriptor.kind !== kind) {
        throw new EnvironmentRegistryError(
          "identity_mismatch",
          `environment factory registered under "${kind}" produced an adapter reporting kind "${descriptor.kind}" -- registration key and adapter identity must match`
        );
      }
      return adapter;
    },
    has: (kind) => registrations.has(kind),
    list: () => Array.from(registrations.values()).map(({ kind, description }) => ({ kind, description }))
  };
}

/**
 * Pre-populated with every environment this repository actually ships --
 * a convenience for a caller (tests, a future CLI/API wiring, demos) that
 * wants "the known set" without hand-registering each one. Each entry's
 * `create` is a thin closure over the real factory this package already
 * exports; `freecad` is included even though a real FreeCAD installation
 * may not be present at runtime -- `createFreeCadAdapter()` itself is
 * always constructible (it only spawns a subprocess when a method is
 * actually called), matching how `freecad-adapter.integration.test.ts`
 * already treats "FreeCAD unavailable" as a call-time, not
 * construction-time, condition.
 */
export function createDefaultEnvironmentRegistry(): EnvironmentRegistry {
  const registry = createEnvironmentRegistry();
  registry.register({
    kind: "mock_cad",
    description: "Deterministic in-memory CAD-like environment (full capability set: create/modify/delete/save/checkpoint).",
    create: createMockCadEnvironment
  });
  registry.register({
    kind: "mock_simulation",
    description: "Deterministic in-memory simulation-like environment (fixed topology; modify + checkpoint only).",
    create: createMockSimulationEnvironment
  });
  registry.register({
    kind: "mock",
    description: "General-purpose deterministic mock environment (full capability set) -- the P6 testing harness.",
    create: () => createMockEnvironment()
  });
  registry.register({
    kind: "freecad",
    description: "Real FreeCAD environment via a headless, allowlisted subprocess boundary (save/modify/checkpoint only).",
    create: () => createFreeCadAdapter()
  });
  return registry;
}
