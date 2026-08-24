import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last line of defense against a blank white screen: without this,
 * ANY uncaught render-time exception anywhere in the tree unmounts the
 * whole app with nothing on screen to explain why -- confirmed as a real
 * gap (no Error Boundary existed anywhere in this codebase before this).
 * React requires a class component here; there is no hook equivalent for
 * `getDerivedStateFromError`/`componentDidCatch`.
 *
 * Deliberately minimal: this cannot know WHY something broke, so it
 * never guesses at a helpful-sounding explanation -- only the real error
 * message and a reload action, matching this app's own "never fabricate
 * a story for something you don't actually know" discipline.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("Naqsh crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-crash" role="alert">
        <div className="app-crash__card">
          <p className="app-crash__eyebrow">Naqsh hit an unexpected error</p>
          <p className="app-crash__message">{this.state.error.message}</p>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
