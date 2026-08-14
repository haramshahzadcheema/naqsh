import { createModelContext, type ModelContext, type WorldModelState } from "@naqsh/schemas";

/**
 * The controlled boundary between `WorldModelState` and what a model
 * actually receives (P7 brief §7). Pure and deterministic: given the same
 * `WorldModelState`, always produces the same `ModelContext` — no id
 * generation, no timestamps, no I/O. Bounded on purpose: counts and
 * identifiers, not full entity bodies, so a large project can never turn
 * into an unbounded prompt. Deep "what's actually relevant to THIS
 * instruction" extraction (which requirements matter, which objects are in
 * scope) is deliberately NOT solved here — that is P8's job (Observation &
 * Understanding), the very next phase. Building that now would mean
 * quietly implementing P8 inside P7's context builder.
 */
export function buildModelContext(state: WorldModelState): ModelContext {
  const { project, session } = state;
  return createModelContext({
    projectId: project.id,
    projectName: project.name,
    projectSummary: project.description.length > 0 ? project.description : null,
    objectiveSummary: project.objective.summary.length > 0 ? project.objective.summary : null,
    requirementCount: project.requirements.length,
    constraintCount: project.constraints.length,
    objectCount: project.objects.length,
    decisionCount: project.decisions.length,
    sessionMode: session.mode,
    focusObjectIds: session.focusObjectIds
  });
}
