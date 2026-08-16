import { createEvidence, type EntitySource, type EnvironmentObject, type Evidence } from "@naqsh/schemas";

/**
 * The Evidence half of Phase 16's "Observation Integration" requirement:
 * turns an EXISTING `EnvironmentObject` (the exact same data `adapter.
 * inspectObject`/`listObjects` already return -- see P8/P13) into
 * `Evidence`, and nothing more. A PURE mapping function: no adapter calls,
 * no I/O, no mutation -- the caller (run-verification-tool.ts) is the one
 * that actually talks to the environment; this only interprets what it got
 * back. This is what keeps verification FreeCAD-independent: the mapping
 * is identical whether `object` came from the mock adapter or the real
 * FreeCAD one.
 *
 * `object === null` represents "the object was confirmed NOT to exist"
 * (an `object_not_found` adapter response), which is DIFFERENT from
 * "existence could not be determined at all" (no session connected, or an
 * unrelated observation failure) -- the latter is represented by never
 * calling this function at all and passing `evidence: null` straight to
 * `evaluateCheck`, which is why this function always sets `objectExists`
 * to a definite boolean, never `null`.
 */
export interface BuildEvidenceContext {
  /** `WorldModelState.project.version` at the moment this evidence is
   * being captured -- see `Evidence.stateVersion`'s own doc comment for
   * why this is the freshness signal, not a new one. */
  stateVersion: number | null;
  environmentKind: string | null;
  observationId?: string | null;
  source?: EntitySource;
}

export function buildEvidenceFromEnvironmentObject(
  objectId: string,
  property: string | null,
  object: EnvironmentObject | null,
  context: BuildEvidenceContext
): Evidence {
  if (!object) {
    return createEvidence({
      objectId,
      objectExists: false,
      observedGenericType: null,
      property,
      propertyExists: null,
      observedValue: null,
      unit: null,
      observationId: context.observationId ?? null,
      stateVersion: context.stateVersion,
      environmentKind: context.environmentKind,
      source: context.source ?? "system"
    });
  }

  const matchedProperty = property !== null ? object.properties.find((candidate) => candidate.key === property) : undefined;

  return createEvidence({
    objectId: object.id,
    objectExists: true,
    observedGenericType: object.genericType,
    property,
    propertyExists: property === null ? null : matchedProperty !== undefined,
    observedValue: matchedProperty !== undefined ? matchedProperty.value : null,
    // EnvironmentProperty (P5/P13) does not carry a unit today -- see
    // Evidence.unit's own doc comment for why this stays `null` rather
    // than fabricating one.
    unit: null,
    observationId: context.observationId ?? null,
    stateVersion: context.stateVersion,
    environmentKind: context.environmentKind,
    source: context.source ?? "system"
  });
}
