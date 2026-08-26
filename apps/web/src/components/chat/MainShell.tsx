import { useEffect, useRef, useState, type ReactNode } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ChatSidebar } from "./ChatSidebar.js";
import { ChatMainView } from "./ChatMainView.js";
import { TabBar } from "./TabBar.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { AgentPanel } from "../agent/AgentPanel.js";
import { useChatThreads } from "../../chat/useChatThreads.js";
import { useApiConnection } from "../../api/ApiConnectionProvider.js";
import { useProjectData } from "../../data/ProjectDataProvider.js";
import { DEMO_PROJECT } from "../../data/demo/demoProject.js";
import { OverviewPage } from "../../routes/OverviewPage.js";
import { RequirementsPage } from "../../routes/RequirementsPage.js";
import { DesignPage } from "../../routes/DesignPage.js";
import { ArtifactsPage } from "../../routes/ArtifactsPage.js";
import { ExperimentsPage } from "../../routes/ExperimentsPage.js";
import { ResearchPage } from "../../routes/ResearchPage.js";
import { FilesPage } from "../../routes/FilesPage.js";
import { MemoryPage } from "../../routes/MemoryPage.js";
import { HistoryPage } from "../../routes/HistoryPage.js";
import { EnvironmentPage } from "../../routes/EnvironmentPage.js";
import { GlobalSearch } from "../search/GlobalSearch.js";
import { NextStepBar } from "../nextstep/NextStepBar.js";

function RoutePage({ children }: { children: ReactNode }): JSX.Element {
  // NextStepBar sits above every tab, not inside any one of them: the
  // thing blocking you is frequently on a DIFFERENT tab than the one
  // you're looking at (a clarification under Requirements blocking a
  // proposal under Design, a dropped session blocking both), so a
  // per-page banner would hide exactly the cases that matter most.
  return (
    <div className="route-page">
      <div className="route-page__scroll">
        <NextStepBar />
        {children}
      </div>
      <AgentPanel />
    </div>
  );
}

export function MainShell(): JSX.Element {
  const apiConnection = useApiConnection();
  const {
    threads,
    activeThreadId,
    activeThread,
    selectThread,
    createNewThread,
    connectFreecadProject,
    sendMessage,
    confirmUnderstanding,
    dismissUnderstanding,
    seedExistingThreadIntro,
    renameThread,
    deleteThread,
    togglePinThread,
    toggleArchiveThread,
    decideProposal,
    restoreCheckpoint,
    regenerateReply,
    decideExplorationApproval,
    startExploration,
    streamingText,
    stopGeneration
  } = useChatThreads(apiConnection.status === "connected");
  const { snapshot, setActiveProjectId } = useProjectData();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Mobile-only concept (see the `max-width: 640px` block in chat.css) --
  // on a desktop-width viewport the sidebar is always visually present
  // regardless of this flag; CSS only reads it below that breakpoint,
  // where the sidebar becomes an off-canvas drawer instead of a
  // permanent column (a fixed 260px sidebar leaves ~115px for content on
  // a 375px phone otherwise -- genuinely unusable, not just cramped).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // Real focus management for the mobile drawer, not just a visual
  // slide-in: without this, a keyboard user who opens it via the
  // hamburger button (which sits AFTER the drawer in DOM order) would
  // have no way to Tab forward into content that's now visible but
  // earlier in the tab sequence. Closing returns focus to the button
  // that opened it, matching standard disclosure-widget behavior.
  // Skips the very first render (mount) -- `sidebarOpen` starts `false`,
  // and stealing focus to a mobile-only toggle button on initial page
  // load, before anyone opened anything, would be its own real bug.
  const didMountSidebarEffect = useRef(false);
  useEffect(() => {
    if (!didMountSidebarEffect.current) {
      didMountSidebarEffect.current = true;
      return;
    }
    if (sidebarOpen) {
      sidebarRef.current?.querySelector<HTMLElement>("button, a, input")?.focus();
    } else {
      sidebarToggleRef.current?.focus();
    }
  }, [sidebarOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      // Matches SettingsPanel/GlobalSearch's own window-level Escape
      // handling -- the mobile drawer is functionally the same kind of
      // dismissible overlay (backdrop included), so it gets the same
      // keyboard escape hatch, not just a tap-outside one.
      if (event.key === "Escape" && sidebarOpen) {
        setSidebarOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  /** Phase B: the REAL backend project id backing the active thread, or
   * `null` for the seeded demo project or a brand-new thread that hasn't
   * sent a message yet (no backend project created lazily until then, see
   * `useChatThreads.ts`'s own "never litter the server with empty
   * projects" comment). Deliberately never set to `DEMO_PROJECT.id` --
   * `ProjectDataProvider` treats any non-null id as "fetch this from the
   * real API," and the demo project only exists in `demoDataSource`, not
   * on the backend. Passing its id through here would make the provider
   * try (and fail) to fetch it from the real API whenever one happens to
   * be reachable -- exactly the bug this comment now guards against. */
  const realProjectId = activeThread?.apiProjectId ?? null;
  const showProjectTabs = activeThread !== null && (realProjectId !== null || activeThread.projectId === DEMO_PROJECT.id);

  // The ONE place ProjectDataProvider learns which REAL project the
  // workspace is currently looking at -- every tab (Overview/Requirements/
  // ...) reads through that provider, never straight from `activeThread`
  // itself. `null` here always means "show the demo project," never "show
  // nothing" -- ProjectDataProvider owns that fallback.
  useEffect(() => {
    setActiveProjectId(realProjectId);
  }, [realProjectId, setActiveProjectId]);

  function handleSelectThread(id: string): void {
    selectThread(id);
    const thread = threads.find((t) => t.id === id);
    const threadProjectId = thread?.apiProjectId ?? (thread?.projectId === DEMO_PROJECT.id ? DEMO_PROJECT.id : null);
    if (threadProjectId === null && location.pathname !== "/") {
      navigate("/");
    }
    setSidebarOpen(false);
  }

  function handleNewThread(): void {
    createNewThread();
    if (location.pathname !== "/") navigate("/");
    setSidebarOpen(false);
  }

  return (
    <div className="chat-shell">
      <div ref={sidebarRef} className={`chat-sidebar__wrap${sidebarOpen ? " is-open" : ""}`}>
        <ChatSidebar
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onRenameThread={renameThread}
          onDeleteThread={deleteThread}
          onTogglePinThread={togglePinThread}
          onToggleArchiveThread={toggleArchiveThread}
          onOpenSettings={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}
          onOpenSearch={() => {
            setSearchOpen(true);
            setSidebarOpen(false);
          }}
        />
      </div>
      {sidebarOpen ? <div className="chat-sidebar__backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" /> : null}
      <div className="chat-shell__main">
        <TabBar
          activeThread={activeThread}
          showProjectTabs={showProjectTabs}
          onOpenSettings={() => setSettingsOpen(true)}
          apiStatus={apiConnection.status}
          onOpenSidebar={() => setSidebarOpen(true)}
          sidebarToggleRef={sidebarToggleRef}
        />
        <main className="chat-shell__body" id="main-content">
          <Routes>
            <Route
              path="/"
              element={
                activeThread ? (
                  <ChatMainView
                    thread={activeThread}
                    onSend={(text, attachments) => sendMessage(activeThread.id, text, attachments)}
                    onConfirmUnderstanding={() => confirmUnderstanding(activeThread.id)}
                    onDismissUnderstanding={() => dismissUnderstanding(activeThread.id)}
                    onSeedIntro={() => snapshot.status === "ready" && seedExistingThreadIntro(activeThread.id, snapshot.data)}
                    onDecideProposal={(proposalId, decision) => decideProposal(activeThread.id, proposalId, decision)}
                    onRestoreCheckpoint={(checkpointId) => restoreCheckpoint(activeThread.id, checkpointId)}
                    onDecideExplorationApproval={(eventId, approvalId, decision) => decideExplorationApproval(activeThread.id, eventId, approvalId, decision)}
                    onStartExploration={(eventId) => startExploration(activeThread.id, eventId)}
                    onRegenerate={() => regenerateReply(activeThread.id)}
                    streamingText={streamingText[activeThread.id]}
                    onStop={() => stopGeneration(activeThread.id)}
                  />
                ) : (
                  <div className="chat-main" />
                )
              }
            />
            <Route path="/overview" element={<RoutePage><OverviewPage /></RoutePage>} />
            <Route path="/requirements" element={<RoutePage><RequirementsPage /></RoutePage>} />
            <Route path="/design" element={<RoutePage><DesignPage /></RoutePage>} />
            <Route path="/artifacts" element={<RoutePage><ArtifactsPage /></RoutePage>} />
            <Route path="/experiments" element={<RoutePage><ExperimentsPage /></RoutePage>} />
            <Route path="/research" element={<RoutePage><ResearchPage /></RoutePage>} />
            <Route path="/files" element={<RoutePage><FilesPage /></RoutePage>} />
            <Route path="/memory" element={<RoutePage><MemoryPage /></RoutePage>} />
            <Route path="/history" element={<RoutePage><HistoryPage /></RoutePage>} />
            <Route path="/environment" element={<RoutePage><EnvironmentPage connectFreecadProject={connectFreecadProject} onConnected={() => navigate("/")} /></RoutePage>} />
          </Routes>
        </main>
      </div>
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      {searchOpen ? (
        <GlobalSearch
          threads={threads}
          snapshot={snapshot}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onOpenSettings={() => setSettingsOpen(true)}
          onNavigate={navigate}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
    </div>
  );
}
