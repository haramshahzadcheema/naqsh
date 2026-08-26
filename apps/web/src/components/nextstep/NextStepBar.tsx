import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectData } from "../../data/ProjectDataProvider.js";
import { resolveNextStep } from "../../data/resolveNextStep.js";

/**
 * One always-visible answer to "what now?", rendered above every workspace
 * tab. See `resolveNextStep` for why the ordering it applies is the real
 * blocking order rather than a cosmetic priority list.
 *
 * Deliberately renders nothing while the snapshot is still loading or
 * failed: a confident "do this next" computed from data that isn't there
 * would be exactly the fabricated guidance this codebase avoids. The
 * surrounding page already shows its own real loading/error state.
 */
export function NextStepBar(): JSX.Element | null {
  const { snapshot, environment, isRealProject, connectEnvironment } = useProjectData();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (snapshot.status !== "ready") return null;

  const step = resolveNextStep(snapshot.data, environment.status === "ready" ? environment.data : null, isRealProject);

  async function run(): Promise<void> {
    setError(null);
    if (step.action.kind === "navigate") {
      navigate(step.action.to);
      return;
    }
    if (step.action.kind === "chat") {
      navigate("/");
      return;
    }
    // connect_environment -- a real network action that can genuinely
    // fail, so it reports the real reason instead of silently no-op-ing.
    setBusy(true);
    try {
      await connectEnvironment();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to the environment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`nextstep nextstep--${step.tone}`} aria-label="Next step">
      <div className="nextstep__body">
        <p className="nextstep__eyebrow">{step.tone === "done" ? "Up to date" : "Next step"}</p>
        <h2 className="nextstep__title">{step.title}</h2>
        <p className="nextstep__detail">{step.detail}</p>
        {step.action.kind === "chat" && step.action.suggestedMessage ? (
          <p className="nextstep__hint">
            In chat, send: <code>{step.action.suggestedMessage}</code>
          </p>
        ) : null}
        {error ? <p className="nextstep__error">{error}</p> : null}
      </div>
      <button type="button" className="btn btn--primary nextstep__action" onClick={run} disabled={busy}>
        {busy ? "Connecting…" : step.actionLabel}
      </button>
    </section>
  );
}
