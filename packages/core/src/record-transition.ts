import {
  createChange,
  type Change,
  type ChangeCauseInput,
  type EntitySource,
  type WorldModelState,
  type WorldModelTransition
} from "@naqsh/schemas";
import type { ChangeHistory } from "./change-history.js";
import { getTransitionEntry, updateWorldModel } from "./transitions.js";

export interface RecordTransitionInput {
  /** Who/what caused this — defaults to "system" (unspecified) rather than
   * presuming a human, matching Change's own default. */
  source?: EntitySource;
  cause?: ChangeCauseInput;
  metadata?: Record<string, unknown>;
}

export interface RecordTransitionResult {
  state: WorldModelState;
  change: Change;
}

/**
 * The audited write path: Command/Transition -> validate + apply reducer
 * -> Change record -> resulting state.
 *
 * `updateWorldModel` is called exactly as-is and does the validating/
 * applying — it is not modified by this file and does not know
 * `ChangeHistory` exists, so it stays pure and independently testable
 * (P1's contract, unchanged). This function is the one place statefulness
 * is allowed to enter: it appends the resulting Change to `history`, which
 * is the sole mutable object in this call.
 *
 * `updateWorldModel(state, transition)` remains directly callable by
 * anyone who genuinely doesn't need an audit trail (e.g. a pure
 * what-if/preview computation) — `recordTransition` is additive, not a
 * replacement.
 */
export function recordTransition(
  history: ChangeHistory,
  state: WorldModelState,
  transition: WorldModelTransition,
  input: RecordTransitionInput = {}
): RecordTransitionResult {
  const beforeProject = state.project;
  const beforeSession = state.session;

  // updateWorldModel validates `transition.kind` and throws
  // WorldModelValidationError for anything unrecognized, so the lookup
  // below is guaranteed to find a registered entry once this line returns.
  const nextState = updateWorldModel(state, transition);

  const entry = getTransitionEntry(transition.kind);
  // Same single, contained cast as updateWorldModel's own dispatch, for the
  // same reason: the registry ties `describeChange`/`resolveForReplay` to
  // its transition kind at construction time, but a runtime keyed lookup
  // can't re-prove that link to the type checker without a manual switch
  // per kind.
  const { entityType, entityId, before, after } =
    entry.target === "project"
      ? entry.describeChange(beforeProject, nextState.project, transition as never)
      : entry.describeChange(beforeSession, nextState.session, transition as never);

  // Store the REPLAYABLE form of the transition, not necessarily the
  // caller's raw one: for kinds where `apply()` can mint a new id (the
  // add_* kinds, replace_session), this pins that id so replaying
  // `change.transition` later reproduces `after` exactly instead of
  // minting a different id each time. See transitions.ts for the full
  // rationale.
  const replayableTransition = entry.resolveForReplay(transition as never, after);

  const change = createChange({
    sequence: history.nextSequence(),
    parentChangeId: history.headId(),
    projectId: nextState.project.id,
    sessionId: nextState.session.id,
    source: input.source ?? "system",
    cause: input.cause ?? {},
    transitionKind: transition.kind,
    transition: replayableTransition,
    target: { entityType, entityId },
    before,
    after,
    resultingProjectVersion: nextState.project.version,
    metadata: input.metadata ?? {}
  });

  history.append(change);

  return { state: nextState, change };
}
