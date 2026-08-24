import type { ResearchEvidence, Source } from "@naqsh/schemas";
import { Badge } from "../common/StatusDot.js";
import { EmptyState } from "../common/States.js";

export function ResearchView({ sources, evidence }: { sources: Source[]; evidence: ResearchEvidence[] }): JSX.Element {
  if (sources.length === 0) {
    return <EmptyState title="No research yet" message="When Naqsh needs external information to ground a decision, sources and evidence will appear here." />;
  }
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  return (
    <ul className="research-list">
      {evidence.map((item) => {
        const source = sourceById.get(item.sourceId);
        return (
          <li key={item.id} className="research-card">
            <header className="research-card__header">
              <span className="research-card__source">{source?.title ?? "Unknown source"}</span>
              <Badge tone={item.confidence === "high" ? "success" : item.confidence === "medium" ? "info" : "pending"}>{item.confidence} confidence</Badge>
            </header>
            <p className="research-card__claim">{item.claim}</p>
            {item.excerpt ? <blockquote className="research-card__excerpt">{item.excerpt}</blockquote> : null}
            <footer className="research-card__footer">
              <span>{source?.publisher ?? source?.sourceType}</span>
              {source?.locator ? (
                <a href={source.locator} target="_blank" rel="noreferrer">
                  Source
                </a>
              ) : null}
              <span className="mono">{new Date(item.retrievedAt).toLocaleDateString()}</span>
            </footer>
            {item.relevanceNote ? <p className="research-card__relevance">Relevance: {item.relevanceNote}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
