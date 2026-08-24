export type Tone = "success" | "warning" | "danger" | "info" | "pending" | "neutral";

export function StatusDot({ tone, label }: { tone: Tone; label?: string }): JSX.Element {
  return (
    <span className="status-dot">
      <span aria-hidden="true" className={`status-dot__mark status-dot__mark--${tone}`} />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }): JSX.Element {
  return <span className={tone === "neutral" ? "badge" : `badge badge--${tone}`}>{children}</span>;
}
