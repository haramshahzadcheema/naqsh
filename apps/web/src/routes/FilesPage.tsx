import { useEffect, useState } from "react";
import { useProjectData } from "../data/ProjectDataProvider.js";
import { LoadingState, ErrorState, EmptyState } from "../components/common/States.js";
import { Badge } from "../components/common/StatusDot.js";
import { formatFileSize } from "../chat/fileImport.js";
import { apiGetFile, apiGetFileRawBlob } from "../api/client.js";
import type { ProjectFile } from "../data/NaqshDataSource.js";

/** A real, on-demand image/PDF preview, backed by the actual uploaded
 * bytes (`GET /files/:id/raw`) -- turned into an object URL rather than a
 * bare `<img src="/files/:id/raw">` because that route's ownership check
 * reads a header only an authenticated HTTP request (via `apiGetFileRawBlob`)
 * can send. Revokes the
 * URL on unmount/collapse so a long Files session doesn't leak blob
 * memory for every image ever expanded. */
function VisualPreview({ file }: { file: ProjectFile }): JSX.Element {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; url: string }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    apiGetFileRawBlob(file.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "Could not load this file's content." });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id]);

  if (state.status === "loading") return <LoadingState label="Loading preview…" />;
  if (state.status === "error") return <p className="file-row__preview-empty">{state.message}</p>;
  if (file.mimeType.startsWith("image/")) return <img className="file-row__preview-image" src={state.url} alt={`Preview of ${file.filename}`} />;
  return <embed className="file-row__preview-pdf" src={state.url} type="application/pdf" title={`Preview of ${file.filename}`} />;
}

function extractionBadge(file: ProjectFile): JSX.Element {
  if (file.mimeType.startsWith("image/")) return <Badge tone="info">image preview</Badge>;
  if (file.mimeType === "application/pdf") return <Badge tone="info">PDF preview</Badge>;
  if (file.extractionStatus === "success") return <Badge tone="success">text extracted</Badge>;
  if (file.extractionStatus === "unsupported") return <Badge tone="neutral">binary -- not inspected</Badge>;
  return <Badge tone="warning">extraction failed</Badge>;
}

type PreviewState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; text: string };

/**
 * A REAL preview: fetches `GET /files/:id` (already returns the exact
 * `extractedText` a chat message that attached this file was interpreted
 * from) on demand, the first time a row expands -- never a fabricated or
 * placeholder rendering. A binary/unsupported file never gets a preview
 * button at all (there is genuinely no text to show); a failed extraction
 * shows the real, already-known error instead of triggering a pointless
 * fetch for text that was never produced.
 */
function FileRow({ file }: { file: ProjectFile }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const isVisual = file.mimeType.startsWith("image/") || file.mimeType === "application/pdf";
  const canPreview = isVisual || file.extractionStatus === "success";

  async function toggle(): Promise<void> {
    const next = !expanded;
    setExpanded(next);
    // Visual previews (images/PDFs) render via VisualPreview -- a real
    // fetch of the original bytes, not the text-extraction path below,
    // which those file types were never expected to have extracted text
    // for in the first place.
    if (next && !isVisual && canPreview && preview.status === "idle") {
      setPreview({ status: "loading" });
      try {
        const full = await apiGetFile(file.id);
        setPreview(full.extractedText !== null ? { status: "ready", text: full.extractedText } : { status: "error", message: "This file has no extracted text after all -- the listing and the file record disagree, which shouldn't happen." });
      } catch (error) {
        setPreview({ status: "error", message: error instanceof Error ? error.message : "Could not load this file's content." });
      }
    }
  }

  return (
    <li className="req-row req-row--stack">
      <button type="button" className="file-row__summary" onClick={toggle} aria-expanded={expanded}>
        <span
          className={`req-row__marker${isVisual || file.extractionStatus === "success" ? " req-row__marker--satisfied" : file.extractionStatus === "failed" ? " req-row__marker--violated" : ""}`}
          aria-hidden="true"
        />
        <div className="req-row__body">
          <div className="req-row__description">{file.filename}</div>
          <div className="req-row__meta">
            <span>{file.mimeType || "application/octet-stream"}</span>
            <span aria-hidden="true">·</span>
            <span>{formatFileSize(file.size)}</span>
            <span aria-hidden="true">·</span>
            <span>{new Date(file.createdAt).toLocaleString()}</span>
          </div>
          {file.extractionStatus === "failed" && file.extractionError ? <p className="req-row__error">{file.extractionError}</p> : null}
        </div>
        {extractionBadge(file)}
        <span className="file-row__chevron" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div className="file-row__preview">
          {isVisual ? (
            <VisualPreview file={file} />
          ) : !canPreview ? (
            <p className="file-row__preview-empty">
              {file.extractionStatus === "unsupported" ? "This is a binary file -- no text content to preview." : "Text extraction failed for this file, so there's nothing to preview."}
            </p>
          ) : preview.status === "loading" ? (
            <LoadingState label="Loading file content…" />
          ) : preview.status === "error" ? (
            <p className="file-row__preview-empty">{preview.message}</p>
          ) : preview.status === "ready" ? (
            <pre className="file-row__preview-text">{preview.text}</pre>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function FilesPage(): JSX.Element {
  const { snapshot, isRealProject } = useProjectData();

  if (snapshot.status === "loading") return <LoadingState label="Loading files…" />;
  if (snapshot.status === "error") return <ErrorState title="Could not load files" message={snapshot.message} />;

  const { data } = snapshot;

  if (data.files.length === 0) {
    return (
      <EmptyState
        title="No files yet"
        message={
          isRealProject
            ? "Attach a file from the chat composer -- text files (.txt/.md/.json/.csv) become part of what Naqsh interprets; other files are kept as a labeled reference."
            : "This demo project doesn't model file uploads. Files attached in a real project will show up here."
        }
      />
    );
  }

  return (
    <div className="view-stack">
      <section>
        <h2 className="view-section-title">Files</h2>
        <ul className="req-list">
          {data.files.map((file) => (
            <FileRow key={file.id} file={file} />
          ))}
        </ul>
      </section>
    </div>
  );
}
