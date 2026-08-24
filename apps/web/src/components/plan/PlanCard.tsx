import type { Plan } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";

const SEVERITY_TONE = { low: "neutral", medium: "warning", high: "danger" } as const;

/**
 * Part 12's Planning card: Objective / Steps / Dependencies / Risks --
 * the reasoning artifact `generatePlanProposal` (P9) produced, rendered
 * as-is. Never editable here and never itself executable; it exists so a
 * human can see WHAT Naqsh intends before any Proposal (let alone any
 * mutation) exists.
 */
export function PlanCard({ plan }: { plan: Plan }): JSX.Element {
  return (
    <article className="plan-card" aria-labelledby={`${plan.id}-objective`}>
      <header className="plan-card__header">
        <span className="plan-card__eyebrow">Plan</span>
        <Badge tone="info">{plan.status}</Badge>
      </header>

      <h3 id={`${plan.id}-objective`} className="plan-card__objective">
        {plan.objectiveSummary}
      </h3>

      <ol className="plan-card__steps">
        {plan.steps.map((step) => (
          <li key={step.id} className="plan-card__step">
            <div className="plan-card__step-title">{step.title}</div>
            <div className="plan-card__step-desc">{step.description}</div>
            {step.dependsOn.length > 0 ? (
              <div className="plan-card__step-deps mono">Depends on: {step.dependsOn.join(", ")}</div>
            ) : null}
          </li>
        ))}
      </ol>

      {plan.risks.length > 0 ? (
        <div className="plan-card__risks">
          <span className="plan-card__risks-title">Risks</span>
          <ul>
            {plan.risks.map((risk) => (
              <li key={risk.id}>
                <Badge tone={SEVERITY_TONE[risk.severity]}>{risk.severity}</Badge>
                <span>{risk.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
