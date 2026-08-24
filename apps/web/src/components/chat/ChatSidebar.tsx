import { useState } from "react";
import type { ChatThread } from "../../chat/types.js";
import { groupThreads, archivedThreads } from "../../chat/groupThreads.js";
import { PencilIcon, TrashIcon, PinIcon, ArchiveIcon } from "../common/Icons.js";

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onRename,
  onDelete,
  onTogglePin,
  onToggleArchive
}: {
  thread: ChatThread;
  isActive: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);

  if (editing) {
    return (
      <li>
        <form
          className="chat-sidebar__rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            onRename(draft);
            setEditing(false);
          }}
        >
          <label className="visually-hidden" htmlFor={`rename-${thread.id}`}>
            Rename {thread.title}
          </label>
          <input
            id={`rename-${thread.id}`}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              onRename(draft);
              setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(thread.title);
                setEditing(false);
              }
            }}
          />
        </form>
      </li>
    );
  }

  return (
    <li className="chat-sidebar__item-row">
      <button type="button" className={`chat-sidebar__item${isActive ? " is-active" : ""}`} onClick={onSelect} aria-current={isActive ? "true" : undefined}>
        <span className="chat-sidebar__item-title">{thread.title}</span>
        {thread.kind === "existing" ? (
          <span className="chat-sidebar__item-badge" title="A sample project for exploring Naqsh -- not connected to your real backend data.">
            Demo
          </span>
        ) : null}
      </button>
      <span className="chat-sidebar__item-actions">
        <button
          type="button"
          className={`chat-sidebar__icon-btn${thread.pinned ? " is-active" : ""}`}
          aria-label={thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`}
          aria-pressed={!!thread.pinned}
          title={thread.pinned ? "Unpin" : "Pin"}
          onClick={onTogglePin}
        >
          <PinIcon />
        </button>
        <button
          type="button"
          className="chat-sidebar__icon-btn"
          aria-label={thread.archived ? `Unarchive ${thread.title}` : `Archive ${thread.title}`}
          title={thread.archived ? "Unarchive" : "Archive"}
          onClick={onToggleArchive}
        >
          <ArchiveIcon />
        </button>
        {thread.kind === "new" ? (
          <>
            <button type="button" className="chat-sidebar__icon-btn" aria-label={`Rename ${thread.title}`} title="Rename" onClick={() => setEditing(true)}>
              <PencilIcon />
            </button>
            <button
              type="button"
              className="chat-sidebar__icon-btn"
              aria-label={`Delete ${thread.title}`}
              title="Delete"
              onClick={() => {
                if (window.confirm(`Delete "${thread.title}"? This can't be undone.`)) onDelete();
              }}
            >
              <TrashIcon />
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}

export function ChatSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onDeleteThread,
  onTogglePinThread,
  onToggleArchiveThread,
  onOpenSettings,
  onOpenSearch
}: {
  threads: ChatThread[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (id: string) => void;
  onTogglePinThread: (id: string) => void;
  onToggleArchiveThread: (id: string) => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}): JSX.Element {
  const groups = groupThreads(threads);
  const archived = archivedThreads(threads);
  const [archivedOpen, setArchivedOpen] = useState(false);

  return (
    <nav className="chat-sidebar" aria-label="Projects and conversation history">
      <div className="chat-sidebar__header">
        <span className="chat-sidebar__wordmark">NAQSH</span>
        <button type="button" className="chat-sidebar__new" onClick={onNewThread}>
          <span aria-hidden="true">+</span> New chat
        </button>
      </div>

      <button type="button" className="chat-sidebar__search" onClick={onOpenSearch}>
        <span aria-hidden="true">⌕</span> Search
        <kbd className="chat-sidebar__search-kbd">Ctrl K</kbd>
      </button>

      <div className="chat-sidebar__scroll">
        {groups.map((group) => (
          <div key={group.label} className="chat-sidebar__group">
            <h2 className="chat-sidebar__group-label">{group.label}</h2>
            <ul className="chat-sidebar__list">
              {group.threads.map((thread) => (
                <ThreadItem
                  key={thread.id}
                  thread={thread}
                  isActive={thread.id === activeThreadId}
                  onSelect={() => onSelectThread(thread.id)}
                  onRename={(title) => onRenameThread(thread.id, title)}
                  onDelete={() => onDeleteThread(thread.id)}
                  onTogglePin={() => onTogglePinThread(thread.id)}
                  onToggleArchive={() => onToggleArchiveThread(thread.id)}
                />
              ))}
            </ul>
          </div>
        ))}

        {archived.length > 0 ? (
          <div className="chat-sidebar__group">
            <button type="button" className="chat-sidebar__group-label chat-sidebar__group-label--toggle" onClick={() => setArchivedOpen((v) => !v)} aria-expanded={archivedOpen}>
              Archived ({archived.length})
              <span aria-hidden="true">{archivedOpen ? "▾" : "▸"}</span>
            </button>
            {archivedOpen ? (
              <ul className="chat-sidebar__list">
                {archived.map((thread) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    isActive={thread.id === activeThreadId}
                    onSelect={() => onSelectThread(thread.id)}
                    onRename={(title) => onRenameThread(thread.id, title)}
                    onDelete={() => onDeleteThread(thread.id)}
                    onTogglePin={() => onTogglePinThread(thread.id)}
                    onToggleArchive={() => onToggleArchiveThread(thread.id)}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="chat-sidebar__footer">
        <button type="button" className="chat-sidebar__settings" onClick={onOpenSettings}>
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </div>
    </nav>
  );
}
