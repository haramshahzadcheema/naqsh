import { NUMERIC_COMPARISON_OPERATORS, type ClarificationCategory, type ClarificationInput, type NumericComparisonOperator, type RequirementCandidate, type WorldModelState } from "@naqsh/schemas";

function isNumericComparisonOperator(value: unknown): value is NumericComparisonOperator {
  return typeof value === "string" && (NUMERIC_COMPARISON_OPERATORS as readonly string[]).includes(value);
}

/**
 * Phase 19: REQUIREMENT COMPLETENESS / AMBIGUITY ANALYSIS.
 *
 * `analyzeRequirementCandidateCompleteness` is a PURE, SYNCHRONOUS,
 * DETERMINISTIC function -- no Gemini call, no I/O, no module-level state.
 * This is a deliberate architectural choice, not an oversight: P18's
 * `interpretRequirementFromText` ALREADY produces the one signal that
 * actually requires natural-language understanding --
 * `RequirementCandidate.ambiguityReason` -- via Gemini, already validated
 * by `assertRequirementCandidate`. Calling Gemini a SECOND time here to
 * re-derive "is this genuinely missing information" would reintroduce
 * exactly the trust question P18 already resolved, for no new signal.
 * This mirrors `evaluateCheck` (P16) and `evaluateObjectiveSatisfaction`
 * (P17)'s identical "the evaluator is pure; Gemini's contribution already
 * happened one layer up and is not re-solicited" discipline.
 *
 * What this function does NOT do: verify the requirement is physically
 * valid, invent a missing value, or decide the requirement is complete
 * enough for VERIFICATION (P16) -- only whether it is specific enough to
 * become an accepted `Requirement` at all. "The plate must be 200 mm
 * wide." needs no clarification here even though a downstream stress
 * analysis (P20+) might still want material/tolerance/finish -- P19 is
 * requirement completeness, not an exhaustive engineering questionnaire
 * (the brief's own explicit "do not over-clarify" requirement).
 */

export interface ClarificationDraft {
  requirementCandidateId: string;
  candidateSnapshot: RequirementCandidate;
  question: string;
  reason: string;
  category: ClarificationCategory;
  affectedFields: readonly string[];
}

export interface CompletenessAnalysis {
  needsClarification: boolean;
  drafts: ClarificationDraft[];
}

function draftFor(candidate: RequirementCandidate, category: ClarificationCategory, question: string, reason: string, affectedFields: readonly string[]): ClarificationDraft {
  return { requirementCandidateId: candidate.id, candidateSnapshot: candidate, question, reason, category, affectedFields };
}

/**
 * A SMALL, bounded set of topic keyword rules -- deliberately NOT "an
 * enormous engineering ontology" (the brief's own explicit warning).
 * Applied only to an ALREADY-"ambiguous" candidate (P18 already decided
 * something is missing; this only refines WHICH thing and asks a targeted
 * question instead of a generic one). Every rule's `question` asks for
 * exactly the missing criterion, never a value -- nothing here invents an
 * engineering fact.
 */
const AMBIGUITY_TOPIC_RULES: ReadonlyArray<{
  category: ClarificationCategory;
  pattern: RegExp;
  affectedFields: readonly string[];
  question: string;
}> = [
  {
    category: "missing_unit",
    pattern: /\bunit\b/i,
    affectedFields: ["unit"],
    question: "What unit does the stated value correspond to (e.g. mm, kg, N)?"
  },
  {
    category: "missing_threshold",
    pattern: /\b(light(weight)?|heavy|mass|weight)\b/i,
    affectedFields: ["value", "unit"],
    question: "What is the maximum (or minimum) allowable mass?"
  },
  {
    category: "missing_threshold",
    pattern: /\b(strong|strength|load|force|withstand|support|durable|durability)\b/i,
    affectedFields: ["value", "operator", "unit"],
    question: "What load must it withstand, and in which direction?"
  },
  {
    category: "missing_threshold",
    pattern: /\b(cheap|inexpensive|cost|budget|price)\b/i,
    affectedFields: ["value", "unit"],
    question: "What is the maximum acceptable cost?"
  }
];

/** For an `"ambiguous"` candidate: one draft per DISTINCT matched topic
 * (Step 9's "multiple independent missing pieces" -- "make it lightweight
 * and strong" matches BOTH the mass and load rules, producing two
 * independent clarifications, never one merged/generic one and never a
 * randomly-chosen single question). Falls back to exactly ONE generic
 * clarification, built from `ambiguityReason` verbatim (never invented),
 * when no topic rule matches. */
function draftsForAmbiguousCandidate(candidate: RequirementCandidate): ClarificationDraft[] {
  const haystack = `${candidate.statementText} ${candidate.ambiguityReason ?? ""}`;
  const matched = AMBIGUITY_TOPIC_RULES.filter((rule) => rule.pattern.test(haystack));
  if (matched.length === 0) {
    return [
      draftFor(
        candidate,
        "insufficient_context",
        `Regarding "${candidate.statementText}": ${candidate.ambiguityReason ?? "the statement does not give enough information to state a concrete criterion."} Could you provide the missing specific detail?`,
        candidate.ambiguityReason ?? "The statement does not give enough information to state a concrete criterion.",
        ["value", "unit", "operator"]
      )
    ];
  }
  return matched.map((rule) => draftFor(candidate, rule.category, rule.question, candidate.ambiguityReason ?? rule.question, rule.affectedFields));
}

/** A bare pronoun as the statement's own subject, with no way to resolve
 * which engineering object it refers to (zero objects: nothing to point
 * at; two or more: genuinely ambiguous which one). Deliberately narrow --
 * only the LEADING pronoun (the statement's actual subject), not any
 * incidental "that"/"this" appearing elsewhere in the sentence, to avoid
 * false positives on ordinary phrasing ("... such that ...", "given that
 * ..."). When exactly one object exists, the reference is resolved
 * (not invented -- genuinely unambiguous), so no clarification is raised. */
function draftForMissingTarget(candidate: RequirementCandidate, state: WorldModelState): ClarificationDraft | null {
  const startsWithBarePronoun = /^\s*(it|this|that|these|those)\b/i.test(candidate.statementText);
  if (!startsWithBarePronoun) return null;
  if (state.project.objects.length === 1) return null;
  return draftFor(
    candidate,
    "missing_target",
    `The statement "${candidate.statementText}" does not name a specific object. Which object does this requirement apply to?`,
    state.project.objects.length === 0
      ? "No engineering objects exist in the project yet to resolve the reference against."
      : `${state.project.objects.length} engineering objects exist in the project; the statement's reference is ambiguous among them.`,
    ["category"]
  );
}

interface Bound {
  value: number;
  inclusive: boolean;
}

function toInterval(operator: NumericComparisonOperator, value: number): { lo: Bound | null; hi: Bound | null } | null {
  switch (operator) {
    case "eq":
      return { lo: { value, inclusive: true }, hi: { value, inclusive: true } };
    case "lt":
      return { lo: null, hi: { value, inclusive: false } };
    case "lte":
      return { lo: null, hi: { value, inclusive: true } };
    case "gt":
      return { lo: { value, inclusive: false }, hi: null };
    case "gte":
      return { lo: { value, inclusive: true }, hi: null };
    case "neq":
      // Not representable as a single interval -- excluded from conflict
      // detection entirely rather than approximated (never guess).
      return null;
    default: {
      // Unreachable for a properly-typed NumericComparisonOperator --
      // this exists as a compile-time exhaustiveness guard (matching
      // verify.ts's identical `exhaustiveCheck: never` precedent) AND as
      // a runtime backstop: if it's ever hit anyway (e.g. a future
      // operator value added to the union without updating this switch),
      // fail loudly with `null` (never conflict-checkable) rather than
      // silently returning `undefined` and crashing the caller.
      const exhaustiveCheck: never = operator;
      void exhaustiveCheck;
      return null;
    }
  }
}

/** Two closed/open numeric intervals are PROVABLY disjoint (can never both
 * hold for the same value) -- the only case this function ever reports a
 * conflict for. Anything not provably disjoint is left alone: P19 detects
 * OBVIOUS contradictions (the brief's own wording), never a heuristic
 * "probably conflicts" guess. */
function intervalsDisjoint(a: { lo: Bound | null; hi: Bound | null }, b: { lo: Bound | null; hi: Bound | null }): boolean {
  if (a.hi !== null && b.lo !== null) {
    if (a.hi.value < b.lo.value) return true;
    if (a.hi.value === b.lo.value && !(a.hi.inclusive && b.lo.inclusive)) return true;
  }
  if (b.hi !== null && a.lo !== null) {
    if (b.hi.value < a.lo.value) return true;
    if (b.hi.value === a.lo.value && !(b.hi.inclusive && a.lo.inclusive)) return true;
  }
  return false;
}

/** The physical dimension a statement constrains, when it names one.
 *
 * `category` is not enough to compare two numbers safely: the interpreter
 * files "length of 4671mm" and "width of 1877mm" BOTH under
 * `category: "dimension"` with unit `mm`, so an exact-value pair looks
 * numerically disjoint and gets reported as a contradiction. Observed
 * live: stating a car's length and then its width produced
 * "appears to conflict", which is nonsense -- they are different axes and
 * were never comparable in the first place.
 *
 * Returns `null` when no dimension is named, which callers must treat as
 * "cannot confirm", never as "same dimension". */
function namedDimension(...texts: Array<string | null | undefined>): string | null {
  const haystack = texts.filter((text): text is string => typeof text === "string").join(" ").toLowerCase();
  // Ordered longest-first so "wall thickness" is not shadowed by a
  // shorter token appearing later in the same sentence.
  const dimensions: ReadonlyArray<readonly [string, RegExp]> = [
    ["diameter", /\b(diameter|dia)\b/],
    ["radius", /\bradius\b/],
    ["thickness", /\b(thickness|thick)\b/],
    ["length", /\b(length|long)\b/],
    ["width", /\b(width|wide)\b/],
    ["height", /\b(height|tall|high)\b/],
    ["depth", /\b(depth|deep)\b/],
    ["mass", /\b(mass|weight|weighs|weighing)\b/]
  ];
  for (const [name, pattern] of dimensions) {
    if (pattern.test(haystack)) return name;
  }
  return null;
}

/** Detects an OBVIOUS numeric contradiction between this candidate and an
 * ALREADY-ACCEPTED `Requirement` in the current project (same category,
 * both quantitative, comparable units). Never decides which one is
 * "right" -- returns a `conflicting_constraints` draft naming BOTH, for a
 * human to resolve; never silently drops or reinterprets either side. */
function draftForConflict(candidate: RequirementCandidate, state: WorldModelState): ClarificationDraft | null {
  if (candidate.operator === null || candidate.value === null) return null;
  const candidateInterval = toInterval(candidate.operator, candidate.value);
  if (candidateInterval === null) return null;

  for (const requirement of state.project.requirements) {
    if (requirement.category !== candidate.category) continue;
    const requirementOperator = requirement.metadata.operator;
    if (!isNumericComparisonOperator(requirementOperator)) continue;
    if (typeof requirement.value !== "number" || !Number.isFinite(requirement.value)) continue;
    if (requirement.unit !== null && candidate.unit !== null && requirement.unit !== candidate.unit) continue;
    const requirementInterval = toInterval(requirementOperator, requirement.value);
    if (requirementInterval === null) continue;

    // Two numbers are only comparable if they constrain the SAME physical
    // dimension. When both sides name one and they differ, there is
    // nothing to contradict -- a 4671mm length and an 1877mm width are
    // not in tension, they are different axes. When either side names
    // none, fall through to the existing check rather than assuming: this
    // narrows a false positive without silencing genuine contradictions
    // (two load limits, say, name no dimension and are still compared).
    const candidateDimension = namedDimension(candidate.statementText, candidate.description);
    const requirementDimension = namedDimension(requirement.description);
    if (candidateDimension !== null && requirementDimension !== null && candidateDimension !== requirementDimension) continue;

    if (intervalsDisjoint(candidateInterval, requirementInterval)) {
      return draftFor(
        candidate,
        "conflicting_constraints",
        `"${candidate.statementText}" appears to conflict with the existing requirement "${requirement.description}" (${requirement.id}). Which should take precedence, or should one be revised?`,
        `Candidate ${candidate.category} ${candidate.operator} ${candidate.value} is numerically disjoint from existing requirement ${requirement.id} (${requirementOperator} ${requirement.value}).`,
        ["value", "operator"]
      );
    }
  }
  return null;
}

/**
 * Full P19 analysis for one `RequirementCandidate` against the current
 * project state. Returns EVERY independent issue found -- never picks one
 * and discards the rest (Step 9) -- but never manufactures an issue that
 * isn't there (Step 8's "do not over-clarify").
 */
export function analyzeRequirementCandidateCompleteness(candidate: RequirementCandidate, state: WorldModelState): CompletenessAnalysis {
  const drafts: ClarificationDraft[] = [];

  if (candidate.interpretationStatus === "ambiguous") {
    drafts.push(...draftsForAmbiguousCandidate(candidate));
  }

  const targetDraft = draftForMissingTarget(candidate, state);
  if (targetDraft) drafts.push(targetDraft);

  const conflictDraft = draftForConflict(candidate, state);
  if (conflictDraft) drafts.push(conflictDraft);

  return { needsClarification: drafts.length > 0, drafts };
}

/** Converts a `ClarificationDraft` into the `ClarificationInput` shape
 * `createClarification` (schemas) expects -- the tool layer's job, kept
 * here as a small pure helper so both the tool and tests can share it. */
export function draftToClarificationInput(draft: ClarificationDraft, projectId: string): ClarificationInput {
  return {
    projectId,
    requirementCandidateId: draft.requirementCandidateId,
    candidateSnapshot: draft.candidateSnapshot,
    question: draft.question,
    reason: draft.reason,
    category: draft.category,
    affectedFields: draft.affectedFields
  };
}
