import { useEffect, useState } from "react";
import { apiDiscoverEnvironments, ApiError, type ApiEnvironmentAvailability } from "../api/client.js";
import { Badge } from "../components/common/StatusDot.js";
import { LoadingState, ErrorState } from "../components/common/States.js";
import { LiveViewPanel } from "../components/environment/LiveViewPanel.js";
import { useDesktopBridge } from "../hooks/useDesktopBridge.js";
import { useProjectData } from "../data/ProjectDataProvider.js";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ApiEnvironmentAvailability[] };

const CAPABILITY_LABEL: Record<string, string> = {
  create: "Create",
  modify: "Modify",
  delete: "Delete",
  save: "Save",
  checkpoint: "Save checkpoints"
};

/**
 * The active project's REAL connected-session state -- kind, status, real
 * document name, and real capabilities (the exact closed set
 * `EnvironmentDescriptor.capabilities` can hold: create/modify/delete/
 * save/checkpoint). Deliberately does NOT show "current selection" or
 * "current operation": neither concept exists anywhere in the backend --
 * no adapter (mock or real FreeCAD) tracks what object is selected in a
 * document, and every environment operation is fire-and-forget request/
 * response with no persisted in-progress state to poll. Showing either
 * would be exactly the fabricated UI this codebase's own "never fake it"
 * rule exists to prevent.
 */
function EngineeringContext(): JSX.Element | null {
  const { environment } = useProjectData();
  if (environment.status !== "ready") return null;
  const env = environment.data;

  return (
    <section>
      <h2 className="view-section-title">Engineering context</h2>
      <div className="card engineering-context">
        <div className="engineering-context__row">
          <span className="engineering-context__kind">{env.name}</span>
          <Badge tone={env.status === "connected" ? "success" : "neutral"}>{env.status === "connected" ? "Connected" : "Disconnected"}</Badge>
        </div>
        <dl className="engineering-context__facts">
          <div>
            <dt>Document</dt>
            <dd>{env.documentName ?? "No document open"}</dd>
          </div>
          <div>
            <dt>Naqsh can</dt>
            <dd>
              {["Observe", ...env.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c)].join(" · ")}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

const DESCRIPTIONS: Record<string, string> = {
  mock_cad: "A deterministic, fully in-memory CAD-like environment. Always available -- no external application required.",
  mock_simulation: "A deterministic, fully in-memory simulation-like environment. Always available -- no external application required.",
  freecad: "A real, locally-installed FreeCAD connected through a headless, allowlisted subprocess boundary (see freecadcmd) -- genuine document read/write, never a mock."
};

function statusBadge(status: ApiEnvironmentAvailability["status"]): JSX.Element {
  if (status === "connectable") return <Badge tone="success">Connectable</Badge>;
  return <Badge tone="neutral">Unavailable</Badge>;
}

/** Connecting a FreeCAD document is REAL project creation (Part 12/34's
 * environment platform), not a settings toggle -- it needs a real
 * `documentPath` up front (see `POST /projects`'s own validation) and
 * genuinely creates a new project + conversation, so it lives here as an
 * explicit action rather than folded into the passive Settings picker,
 * which only ever sets a PREFERENCE for a project created some other way. */
function ConnectFreecadForm({ connectFreecadProject, onConnected }: { connectFreecadProject: (name: string, documentPath: string) => Promise<string>; onConnected: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [documentPath, setDocumentPath] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "connecting" } | { kind: "error"; message: string }>({ kind: "idle" });

  return (
    <form
      className="env-connect-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!documentPath.trim()) return;
        setState({ kind: "connecting" });
        try {
          await connectFreecadProject(name.trim(), documentPath.trim());
          onConnected();
        } catch (error) {
          const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Could not connect to that document.";
          setState({ kind: "error", message });
        }
      }}
    >
      <label className="env-connect-form__field">
        <span>Project name (optional)</span>
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Mounting Bracket" />
      </label>
      <label className="env-connect-form__field">
        <span>Document path</span>
        <input
          type="text"
          value={documentPath}
          onChange={(event) => setDocumentPath(event.target.value)}
          placeholder="C:\Users\you\Documents\bracket.FCStd"
          required
        />
        <span className="env-connect-form__hint">An absolute path to a real .FCStd file on the machine running the Naqsh server -- not your browser's machine, if they differ.</span>
      </label>
      <button type="submit" className="btn btn--primary" disabled={state.kind === "connecting" || !documentPath.trim()}>
        {state.kind === "connecting" ? "Connecting…" : "Connect document"}
      </button>
      {state.kind === "error" ? (
        <p className="env-connect-form__error" role="alert">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function EnvironmentPage({ connectFreecadProject, onConnected }: { connectFreecadProject: (name: string, documentPath: string) => Promise<string>; onConnected: () => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  async function load(forceRefresh: boolean): Promise<void> {
    if (forceRefresh) setRefreshing(true);
    else setState({ status: "loading" });
    try {
      const { environments } = await apiDiscoverEnvironments(forceRefresh);
      setState({ status: "ready", data: environments });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Could not reach the Naqsh server to discover environments." });
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === "loading") return <LoadingState label="Detecting engineering environments…" />;
  if (state.status === "error") return <ErrorState title="Could not load environments" message={state.message} action={<button type="button" className="btn btn--ghost btn--sm" onClick={() => load(false)}>Retry</button>} />;

  const freecad = state.data.find((env) => env.kind === "freecad");

  return (
    <div className="view-stack">
      <EngineeringContext />

      <section>
        <div className="env-center__header">
          <h2 className="view-section-title">Engineering environments</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? "Rechecking…" : "Recheck"}
          </button>
        </div>
        <ul className="env-card-list">
          {state.data.map((env) => (
            <li key={env.kind} className="env-card">
              <div className="env-card__header">
                <span className="env-card__name">{env.name}</span>
                {statusBadge(env.status)}
              </div>
              <p className="env-card__description">{DESCRIPTIONS[env.kind] ?? ""}</p>
              <dl className="env-card__facts">
                <div>
                  <dt>Capabilities</dt>
                  <dd className="mono">{env.capabilities.join(", ") || "read-only"}</dd>
                </div>
                {env.version ? (
                  <div>
                    <dt>Version</dt>
                    <dd className="mono">{env.version}</dd>
                  </div>
                ) : null}
                {env.resolvedCommandPath ? (
                  <div>
                    <dt>Resolved at</dt>
                    <dd className="mono">{env.resolvedCommandPath}</dd>
                  </div>
                ) : null}
                {env.reason ? (
                  <div>
                    <dt>Why unavailable</dt>
                    <dd>{env.reason}</dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      </section>

      {freecad?.status === "connectable" ? (
        <section>
          <h2 className="view-section-title">Connect a FreeCAD document</h2>
          <p className="state-message">
            Opens a real project against an existing FreeCAD document -- genuine read/write through the connected adapter (modify, save, checkpoint), never a mock.
          </p>
          <ConnectFreecadForm connectFreecadProject={connectFreecadProject} onConnected={onConnected} />
        </section>
      ) : null}

      <section>
        <div className="env-center__header">
          <h2 className="view-section-title">Live view</h2>
          <DesktopAppBadge />
        </div>
        <p className="state-message">
          A real, live capture of another application's window -- never a static image or a simulated feed. Requires the NAQSH desktop app (a browser tab
          cannot capture another program's window on its own).
        </p>
        <LiveViewPanel />
      </section>
    </div>
  );
}

function DesktopAppBadge(): JSX.Element {
  const bridge = useDesktopBridge();
  return bridge ? <Badge tone="success">Desktop app</Badge> : <Badge tone="neutral">Browser tab</Badge>;
}
