import type { Check, ObjectiveSatisfactionResult, VerificationResult } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";

function formatExpected(check: Check): string {
  if (check.kind === "bounds_check") {
    if (check.min !== null && check.max !== null) return `${check.min}–${check.max} ${check.unit ?? ""}`.trim();
    if (check.min !== null) return `≥ ${check.min} ${check.unit ?? ""}`.trim();
    if (check.max !== null) return `≤ ${check.max} ${check.unit ?? ""}`.trim();
  }
  if (check.kind === "numeric_comparison") {
    return `${check.operator} ${check.expectedValue} ${check.expectedUnit ?? ""}`.trim();
  }
  return "—";
}

function VerificationRow({ check, result }: { check: Check | undefined; result: VerificationResult }): JSX.Element {
  const passed = result.status === "pass";
  return (
    <li className={`verification-row verification-row--${result.status}`}>
      <span className="verification-row__icon" aria-hidden="true">
        {passed ? "✓" : result.status === "fail" ? "✕" : "?"}
      </span>
      <div className="verification-row__body">
        <div className="verification-row__name">{check?.description ?? "Check"}</div>
        <div className="verification-row__values mono">
          {check ? <span>Required: {formatExpected(check)}</span> : null}
          <span>Actual: {String(result.actual ?? "—")}</span>
        </div>
      </div>
      <Badge tone={passed ? "success" : result.status === "fail" ? "danger" : "pending"}>{result.status}</Badge>
    </li>
  );
}

/**
 * Deterministic verification results, always rendered separately from
 * agent commentary — this view exists to visually reinforce "Naqsh uses
 * real engineering checks," never "the AI says it looks good."
 */
export function VerificationPanel({
  checks,
  results,
  objectiveSatisfaction
}: {
  checks: Check[];
  results: VerificationResult[];
  objectiveSatisfaction: ObjectiveSatisfactionResult | null;
}): JSX.Element {
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const passCount = results.filter((r) => r.status === "pass").length;

  return (
    <section className="verification-panel" aria-label="Verification">
      <header className="verification-panel__header">
        <span className="verification-panel__title">Verification</span>
        <span className="mono verification-panel__count">{`${passCount} / ${results.length} checks passed`}</span>
      </header>
      <ul className="verification-row-list">
        {results.map((result) => (
          <VerificationRow key={result.id} check={checkById.get(result.checkId)} result={result} />
        ))}
      </ul>
      {objectiveSatisfaction ? (
        <footer className={`verification-panel__objective verification-panel__objective--${objectiveSatisfaction.status}`}>
          <span className="verification-panel__objective-label">Objective</span>
          <span className="verification-panel__objective-value">
            {objectiveSatisfaction.status === "satisfied"
              ? "Objective satisfied."
              : objectiveSatisfaction.status === "not_satisfied"
                ? "Objective not satisfied."
                : "Objective satisfaction inconclusive."}
          </span>
          <p className="verification-panel__objective-reason">{objectiveSatisfaction.reason}</p>
        </footer>
      ) : null}
    </section>
  );
}
