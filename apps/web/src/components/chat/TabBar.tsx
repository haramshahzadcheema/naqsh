import { useState, type RefObject } from "react";
import { NavLink } from "react-router-dom";
import { Badge } from "../common/StatusDot.js";
import { useProjectData } from "../../data/ProjectDataProvider.js";
import { ExportMenu } from "./ExportMenu.js";
import type { ChatThread } from "../../chat/types.js";
import type { ApiConnectionStatus } from "../../api/ApiConnectionProvider.js";

const TABS: { to: string; label: string }[] = [
  { to: "/overview", label: "Overview" },
  { to: "/requirements", label: "Requirements" },
  { to: "/design", label: "Design" },
  { to: "/artifacts", label: "Artifacts" },
  { to: "/experiments", label: "Experiments" },
  { to: "/research", label: "Research" },
  { to: "/files", label: "Files" },
  { to: "/memory", label: "Memory" },
  { to: "/history", label: "History" },
  { to: "/environment", label: "Environment" }
];

/** `apiStatus` alone answers "is the server reachable," never "is what's
 * currently on screen real." Those are different questions: the API can be
 * fully reachable while the active thread is still the seeded demo project
 * (a fresh visit, or the demo thread deliberately re-selected) -- showing
 * "Connected" in that state would read as "you're looking at live data"
 * when every tab is actually rendering `demoProject.ts`. `isRealProject`
 * (whether the CURRENTLY ACTIVE thread has a real backend project behind
 * it) is checked first for exactly this reason. */
function apiStatusBadge(status: ApiConnectionStatus, isRealProject: boolean): JSX.Element | null {
  if (status === "checking") return <Badge tone="pending">Checking server…</Badge>;
  if (status === "offline") return <Badge tone="warning">Offline demo</Badge>;
  if (!isRealProject) return <Badge tone="pending">Demo project</Badge>;
  return <Badge tone="success">Connected</Badge>;
}

/** Real counts only -- derived from whatever the currently loaded
 * project's snapshot actually contains, never a fabricated "you have
 * updates" ping. `null` (snapshot not ready, or the tab has no counted
 * concept) renders no badge at all. */
function pendingCountFor(tabTo: string, snapshot: ReturnType<typeof useProjectData>["snapshot"]): number | null {
  if (snapshot.status !== "ready") return null;
  if (tabTo === "/design") return snapshot.data.proposals.filter((p) => p.status === "proposed").length || null;
  if (tabTo === "/requirements") return snapshot.data.clarifications.filter((c) => c.status === "pending").length || null;
  if (tabTo === "/artifacts") return snapshot.data.designSpecifications.filter((d) => d.status === "proposed").length || null;
  return null;
}

export function TabBar({
  activeThread,
  showProjectTabs,
  onOpenSettings,
  apiStatus,
  onOpenSidebar,
  sidebarToggleRef
}: {
  activeThread: ChatThread | null;
  showProjectTabs: boolean;
  onOpenSettings: () => void;
  apiStatus: ApiConnectionStatus;
  /** Only rendered as a visible button below the mobile breakpoint (see
   * `.tab-bar__sidebar-toggle` in chat.css) -- on a desktop-width
   * viewport the sidebar is already a permanent column, so a toggle
   * button there would be a control with nothing real to do. */
  onOpenSidebar: () => void;
  /** MainShell restores focus here when the drawer closes -- standard
   * disclosure-widget behavior (focus returns to the control that
   * opened the thing being closed). */
  sidebarToggleRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const { environment, snapshot, isRealProject, connectEnvironment } = useProjectData();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  return (
    <div className="tab-bar">
      <div className="tab-bar__left">
        <button ref={sidebarToggleRef} type="button" className="tab-bar__sidebar-toggle" onClick={onOpenSidebar} aria-label="Open sidebar">
          ☰
        </button>
        <NavLink to="/" end className={({ isActive }) => `tab-bar__link tab-bar__link--chat${isActive ? " is-active" : ""}`}>
          {activeThread?.title ?? "Chat"}
        </NavLink>
        {showProjectTabs
          ? TABS.map((tab) => {
              const pendingCount = pendingCountFor(tab.to, snapshot);
              return (
                <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `tab-bar__link${isActive ? " is-active" : ""}`}>
                  {tab.label}
                  {pendingCount ? (
                    <span className="tab-bar__pending-count" aria-label={`${pendingCount} pending`}>
                      {pendingCount}
                    </span>
                  ) : null}
                </NavLink>
              );
            })
          : null}
      </div>
      <div className="tab-bar__right">
        <span
          title={
            apiStatus !== "connected"
              ? "The Naqsh API isn't reachable -- new chats use the local demo fallback."
              : isRealProject
                ? "The real Naqsh API is reachable, and this thread has a real backend project behind it."
                : "The Naqsh API is reachable, but this thread is the seeded demo project -- nothing here is live backend data."
          }
        >
          {apiStatusBadge(apiStatus, isRealProject)}
        </span>
        {environment.status === "ready" ? (
          <span className="tab-bar__env">
            <Badge tone={environment.data.status === "connected" ? "success" : "danger"}>
              {environment.data.name} · {environment.data.status}
            </Badge>
            {isRealProject && environment.data.status !== "connected" ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={connecting}
                title={connectError ?? undefined}
                onClick={async () => {
                  setConnecting(true);
                  setConnectError(null);
                  try {
                    await connectEnvironment();
                  } catch (error) {
                    setConnectError(error instanceof Error ? error.message : "Could not connect.");
                  } finally {
                    setConnecting(false);
                  }
                }}
              >
                {connecting ? "Connecting…" : connectError ? "Retry connect" : "Connect"}
              </button>
            ) : null}
          </span>
        ) : null}
        {activeThread ? <ExportMenu thread={activeThread} /> : null}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenSettings} aria-label="Open settings">
          ⚙
        </button>
      </div>
    </div>
  );
}
