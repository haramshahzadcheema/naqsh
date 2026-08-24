import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread } from "../../chat/types.js";
import type { ProjectSnapshot } from "../../data/NaqshDataSource.js";
import { useFocusTrap } from "../../hooks/useFocusTrap.js";

type LoadState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

interface SearchResultItem {
  id: string;
  kind: string;
  label: string;
  sublabel?: string;
  go: () => void;
}

const MAX_RESULTS = 30;

/** Static, always-present command entries -- what makes this Ctrl+K
 * overlay a real command palette (section 30) and not only a content
 * search (section 31). Every one is a genuinely reachable action this app
 * already has a real handler for; nothing here is a placeholder waiting
 * on a "coming soon" backend. Ranked to appear ABOVE content matches with
 * the same query relevance (see `results`'s own sort) since "jump to
 * Design" is usually what someone typing "design" actually wants, not a
 * requirement that happens to mention the word. */
function buildCommands(onNewThread: () => void, onOpenSettings: () => void, onNavigate: (path: string) => void): SearchResultItem[] {
  const navCommands: Array<[string, string]> = [
    ["/overview", "Overview"],
    ["/requirements", "Requirements"],
    ["/design", "Design"],
    ["/artifacts", "Artifacts"],
    ["/experiments", "Experiments"],
    ["/research", "Research"],
    ["/files", "Files"],
    ["/memory", "Memory"],
    ["/history", "History"],
    ["/environment", "Environment"]
  ];
  return [
    { id: "cmd-new-chat", kind: "Command", label: "New chat", go: onNewThread },
    { id: "cmd-settings", kind: "Command", label: "Open settings", go: onOpenSettings },
    ...navCommands.map(([path, label]): SearchResultItem => ({ id: `cmd-nav-${path}`, kind: "Command", label: `Go to ${label}`, go: () => onNavigate(path) }))
  ];
}

/** Every result here comes from data this app has already genuinely
 * fetched -- the chat thread list (client-local) and the CURRENTLY
 * loaded project's snapshot. This is deliberately scoped as "search this
 * project and your chats," not "search everywhere" -- there is no
 * backend endpoint to search across every project a user has, and
 * fabricating results outside what's actually loaded would be exactly
 * the kind of fake capability this codebase avoids. */
function buildIndex(threads: ChatThread[], snapshot: LoadState<ProjectSnapshot>, onSelectThread: (id: string) => void, onNavigate: (path: string) => void): SearchResultItem[] {
  const items: SearchResultItem[] = threads.map((thread) => ({
    id: `thread-${thread.id}`,
    kind: "Chat",
    label: thread.title,
    go: () => {
      onSelectThread(thread.id);
      onNavigate("/");
    }
  }));

  if (snapshot.status !== "ready") return items;
  const { data } = snapshot;

  for (const requirement of data.requirements) {
    items.push({ id: `req-${requirement.id}`, kind: "Requirement", label: requirement.description, go: () => onNavigate("/requirements") });
  }
  for (const constraint of data.constraints) {
    items.push({ id: `con-${constraint.id}`, kind: "Constraint", label: constraint.description, go: () => onNavigate("/requirements") });
  }
  for (const proposal of data.proposals) {
    items.push({ id: `prop-${proposal.id}`, kind: "Proposal", label: proposal.objectiveSummary, sublabel: proposal.status, go: () => onNavigate("/design") });
  }
  for (const candidate of data.candidates) {
    items.push({ id: `cand-${candidate.id}`, kind: "Candidate", label: candidate.hypothesis, go: () => onNavigate("/design") });
  }
  for (const spec of data.designSpecifications) {
    items.push({ id: `spec-${spec.id}`, kind: "Artifact", label: spec.description || "Design specification", sublabel: spec.status, go: () => onNavigate("/artifacts") });
  }
  for (const experiment of data.experiments) {
    items.push({ id: `exp-${experiment.id}`, kind: "Experiment", label: experiment.hypothesis, sublabel: experiment.status, go: () => onNavigate("/experiments") });
  }
  for (const source of data.sources) {
    items.push({ id: `src-${source.id}`, kind: "Research", label: source.title, go: () => onNavigate("/research") });
  }
  for (const file of data.files) {
    items.push({ id: `file-${file.id}`, kind: "File", label: file.filename, go: () => onNavigate("/files") });
  }
  for (const memory of data.memoryRecords) {
    items.push({ id: `mem-${memory.id}`, kind: "Memory", label: memory.title, go: () => onNavigate("/memory") });
  }
  return items;
}

export function GlobalSearch({
  threads,
  snapshot,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  onNavigate,
  onClose
}: {
  threads: ChatThread[];
  snapshot: LoadState<ProjectSnapshot>;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onOpenSettings: () => void;
  onNavigate: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef);

  const commands = useMemo(() => buildCommands(onNewThread, onOpenSettings, onNavigate), [onNewThread, onOpenSettings, onNavigate]);
  const contentItems = useMemo(() => buildIndex(threads, snapshot, onSelectThread, onNavigate), [threads, snapshot, onSelectThread, onNavigate]);
  // Commands ranked above content matches -- see `buildCommands`'s own
  // doc comment for why "design" should jump to the Design workspace
  // section before it surfaces a requirement that merely mentions the word.
  const allItems = useMemo(() => [...commands, ...contentItems], [commands, contentItems]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return allItems.slice(0, MAX_RESULTS);
    return allItems.filter((item) => item.label.toLowerCase().includes(trimmed) || item.kind.toLowerCase().includes(trimmed)).slice(0, MAX_RESULTS);
  }, [allItems, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Escape closes regardless of which element inside the panel currently
  // has focus (the input, or a result button reached via Tab/mouse) --
  // matching `SettingsPanel`'s own window-level Escape handling, not
  // scoped to a single element the way Arrow/Enter navigation is.
  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [onClose]);

  function select(item: SearchResultItem): void {
    item.go();
    onClose();
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = results[activeIndex];
      if (item) select(item);
    }
  }

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search" ref={panelRef} onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="search-panel__input"
          placeholder="Search or jump to…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search"
        />
        {snapshot.status !== "ready" ? <p className="search-panel__hint">The active project hasn't finished loading yet -- only your chats are searchable right now.</p> : null}
        {results.length === 0 ? (
          <p className="search-panel__empty">No matches.</p>
        ) : (
          <ul className="search-panel__results" role="listbox">
            {results.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`search-panel__result${index === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(item)}
                >
                  <span className="search-panel__result-kind">{item.kind}</span>
                  <span className="search-panel__result-label">{item.label}</span>
                  {item.sublabel ? <span className="search-panel__result-sublabel">{item.sublabel}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
