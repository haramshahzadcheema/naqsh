import type { ReactNode } from "react";

export function LoadingState({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" className="state state-loading">
      <span className="state-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ title, message, action }: { title: string; message: string; action?: ReactNode }): JSX.Element {
  return (
    <div role="alert" className="state state-error">
      <div className="state-title">{title}</div>
      <p className="state-message">{message}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="state state-empty">
      <div className="state-title">{title}</div>
      <p className="state-message">{message}</p>
      {action}
    </div>
  );
}
