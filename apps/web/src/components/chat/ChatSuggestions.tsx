import { useProjectData } from "../../data/ProjectDataProvider.js";
import { resolveNextStep } from "../../data/resolveNextStep.js";

/**
 * The phrases Naqsh actually responds to, offered instead of guessed.
 *
 * AUDIT FIX. `hasDesignIntent` / `hasExplorationIntent`
 * (apps/api/src/workflowEvents.ts) are deliberately deterministic regexes
 * rather than an LLM classifier -- a good decision, because it makes the
 * trigger predictable and testable. But NOTHING in the UI ever named the
 * phrases they match, so the only way to advance the workflow was to
 * guess the magic words. Observed live: a user asking "just make the best
 * choices and generate", then repeatedly reporting "nothing is
 * happening", because the free-text reply was conversational while the
 * workflow silently never triggered.
 *
 * These are real, verbatim trigger phrases -- clicking one fills the
 * composer so it can be edited or sent as-is, never sending on your
 * behalf.
 */
export function ChatSuggestions({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }): JSX.Element | null {
  const { snapshot, environment, isRealProject } = useProjectData();
  if (snapshot.status !== "ready") return null;

  const step = resolveNextStep(snapshot.data, environment.status === "ready" ? environment.data : null, isRealProject);

  // Only the phrase the CURRENT state actually calls for, plus the one
  // evergreen alternative -- never a wall of every command that exists.
  const suggestions: string[] = [];
  if (step.action.kind === "chat" && step.action.suggestedMessage) suggestions.push(step.action.suggestedMessage);
  if (step.id === "capture_requirements") suggestions.push("The part must be no more than 100mm long.");
  if (!suggestions.includes("explore alternatives") && (step.id === "up_to_date" || step.id === "run_candidates")) suggestions.push("explore alternatives");

  if (suggestions.length === 0) return null;

  return (
    <div className="chat-suggestions">
      <span className="chat-suggestions__label">Try</span>
      {suggestions.map((suggestion) => (
        <button key={suggestion} type="button" className="chat-suggestions__chip" disabled={disabled} onClick={() => onPick(suggestion)}>
          {suggestion}
        </button>
      ))}
    </div>
  );
}
