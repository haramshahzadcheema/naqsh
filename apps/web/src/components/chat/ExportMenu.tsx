import { useEffect, useRef, useState } from "react";
import type { ChatThread } from "../../chat/types.js";
import { buildProjectDataJson, buildTranscriptMarkdown, downloadTextFile } from "../../chat/exportThread.js";

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "naqsh-chat";
}

export function ExportMenu({ thread }: { thread: ChatThread }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        Export
      </button>
      {open ? (
        <div className="export-menu__popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className="export-menu__item"
            onClick={() => {
              downloadTextFile(`${slug(thread.title)}-conversation.md`, buildTranscriptMarkdown(thread), "text/markdown");
              setOpen(false);
            }}
          >
            Export conversation (.md)
          </button>
          <button
            type="button"
            role="menuitem"
            className="export-menu__item"
            onClick={() => {
              downloadTextFile(`${slug(thread.title)}-project-data.json`, buildProjectDataJson(thread), "application/json");
              setOpen(false);
            }}
          >
            Export project data (.json)
          </button>
        </div>
      ) : null}
    </div>
  );
}
