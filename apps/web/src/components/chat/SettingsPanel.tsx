import { useEffect, useRef, useState } from "react";
import { ENVIRONMENT_OPTIONS, UNAVAILABLE_ENVIRONMENTS } from "../../settings/environments.js";
import { MODEL_OPTIONS } from "../../settings/models.js";
import { STYLE_OPTIONS, type StyleId } from "../../settings/styles.js";
import { useSettings } from "../../settings/SettingsProvider.js";
import { ThemeToggle } from "../shell/ThemeToggle.js";
import { useOnboardingControl } from "../../onboarding/OnboardingControlContext.js";
import { useApiConnection } from "../../api/ApiConnectionProvider.js";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";

/** Three real categories, matching what this app actually has settings
 * for -- deliberately NOT the generic "AI / Engineering / Workspace /
 * Data / Account" five-way split some settings UIs default to: this app
 * has no account system (identity is local-only, see auth.ts) and no
 * data-management settings of its own yet (export lives in the tab bar's
 * own Export menu, scoped to one conversation). Adding empty "Data" and
 * "Account" categories to look complete would be exactly the kind of
 * control that promises something not actually there. */
type SettingsCategory = "ai" | "engineering" | "workspace";

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: "ai", label: "AI" },
  { id: "engineering", label: "Engineering" },
  { id: "workspace", label: "Workspace" }
];

export function SettingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { environment, setEnvironment, modelId, setModelId, styleId, setStyleId } = useSettings();
  const onboardingControl = useOnboardingControl();
  const apiConnection = useApiConnection();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState<SettingsCategory>("ai");

  useFocusTrap(dialogRef);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-panel__header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </header>

        <div className="settings-panel__body">
          <nav className="settings-panel__categories" aria-label="Settings categories">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`settings-panel__category${category === cat.id ? " is-active" : ""}`}
                aria-current={category === cat.id ? "true" : undefined}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel__content">
            {category === "ai" ? (
              <>
                <section className="settings-section">
                  <h3>Reasoning model</h3>
                  <p className="settings-section__hint">
                    {apiConnection.status === "connected"
                      ? apiConnection.geminiConfigured
                        ? "Selecting a Gemini model actually reaches the server on your next message."
                        : "The server is reachable, but GEMINI_API_KEY isn't configured there yet — Gemini models will report that honestly rather than faking a reply."
                      : "The Naqsh API server isn't reachable right now, so this only affects the local offline demo."}
                  </p>
                  <div className="settings-option-list" role="radiogroup" aria-label="Reasoning model">
                    {MODEL_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={modelId === option.id}
                        className={`settings-option${modelId === option.id ? " is-selected" : ""}`}
                        onClick={() => setModelId(option.id)}
                      >
                        <span className="settings-option__name">{option.label}</span>
                        <span className="settings-option__description">{option.note}</span>
                        <span className="settings-option__status">{option.provider}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="settings-section">
                  <h3>AI style</h3>
                  <p className="settings-section__hint">How Naqsh phrases its own replies — separate from which model is selected.</p>
                  <div className="settings-option-list" role="radiogroup" aria-label="AI style">
                    {STYLE_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={styleId === option.id}
                        className={`settings-option${styleId === option.id ? " is-selected" : ""}`}
                        onClick={() => setStyleId(option.id as StyleId)}
                      >
                        <span className="settings-option__name">{option.label}</span>
                        <span className="settings-option__description">{option.description}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {category === "engineering" ? (
              <section className="settings-section">
                <h3>Engineering environment</h3>
                <p className="settings-section__hint">Which environment a NEW project connects to when you create it -- an existing project keeps whatever it was created with.</p>
                <div className="settings-option-list" role="radiogroup" aria-label="Engineering environment">
                  {ENVIRONMENT_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={environment === option.id}
                      className={`settings-option${environment === option.id ? " is-selected" : ""}`}
                      onClick={() => setEnvironment(option.id)}
                    >
                      <span className="settings-option__name">{option.name}</span>
                      <span className="settings-option__description">{option.description}</span>
                      <span className="settings-option__status">{option.status}</span>
                    </button>
                  ))}
                  {UNAVAILABLE_ENVIRONMENTS.map((option) => (
                    <div key={option.id} className="settings-option" aria-disabled="true">
                      <span className="settings-option__name">{option.name}</span>
                      <span className="settings-option__description">{option.description}</span>
                      <span className="settings-option__status settings-option__status--muted">{option.status}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {category === "workspace" ? (
              <>
                <section className="settings-section">
                  <h3>Appearance</h3>
                  <ThemeToggle />
                </section>

                {onboardingControl ? (
                  <section className="settings-section">
                    <h3>Introduction</h3>
                    <p className="settings-section__hint">Replay the opening NAQSH sequence -- the same first-launch moment, on demand.</p>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        onboardingControl.replayIntro();
                        onClose();
                      }}
                    >
                      Replay intro
                    </button>
                  </section>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
