import { useEffect, useRef, useState } from "react";
import { useDesktopBridge, type CaptureSource } from "../../hooks/useDesktopBridge.js";
import { Badge } from "../common/StatusDot.js";
import { useProjectData } from "../../data/ProjectDataProvider.js";

type State =
  | { phase: "unavailable" }
  | { phase: "idle" }
  | { phase: "listing" }
  | { phase: "picking"; sources: CaptureSource[] }
  | { phase: "starting"; source: CaptureSource }
  | { phase: "live"; source: CaptureSource; stream: MediaStream }
  | { phase: "error"; message: string };

/**
 * A REAL live window view -- Part 6/7 of the environment-platform brief,
 * "never fake 'live'". This only ever renders actual video frames Chromium
 * itself is capturing from a window the user explicitly picked, through
 * `apps/desktop`'s real `desktopCapturer` + `setDisplayMediaRequestHandler`
 * bridge (see that package's `main.ts`). In an ordinary browser tab --
 * including every dev/test session in this repo that isn't the packaged
 * desktop app -- `useDesktopBridge()` returns `null` and this renders the
 * honest "requires the desktop app" state instead of a static image or any
 * other approximation of "live".
 */
type AskState = { phase: "idle" } | { phase: "asking" } | { phase: "answered"; text: string } | { phase: "error"; message: string };

export function LiveViewPanel(): JSX.Element {
  const bridge = useDesktopBridge();
  const { analyzeFrame, isRealProject } = useProjectData();
  const [state, setState] = useState<State>(bridge ? { phase: "idle" } : { phase: "unavailable" });
  const [question, setQuestion] = useState("");
  const [askState, setAskState] = useState<AskState>({ phase: "idle" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (state.phase === "live" && videoRef.current) {
      videoRef.current.srcObject = state.stream;
    }
  }, [state]);

  // Stop every real track when this panel unmounts or a new capture
  // replaces the old one -- a MediaStream left running is a genuine,
  // continuing capture, never something to just let get garbage collected.
  useEffect(() => {
    return () => {
      if (state.phase === "live") {
        for (const track of state.stream.getTracks()) track.stop();
      }
    };
  }, [state]);

  async function refreshSources(): Promise<void> {
    if (!bridge) return;
    setState({ phase: "listing" });
    try {
      const sources = await bridge.listCaptureSources();
      setState({ phase: "picking", sources });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not list windows." });
    }
  }

  async function startCapture(source: CaptureSource): Promise<void> {
    if (!bridge) return;
    setState({ phase: "starting", source });
    try {
      await bridge.selectCaptureSource(source.id);
      // Resolves through apps/desktop's own setDisplayMediaRequestHandler
      // -- the ONE source just armed above, never anything else, and
      // never anything at all if that arm step didn't happen first.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      setState({ phase: "live", source, stream });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not start capture." });
    }
  }

  function stopCapture(): void {
    if (state.phase === "live") {
      for (const track of state.stream.getTracks()) track.stop();
    }
    setState({ phase: "idle" });
    setAskState({ phase: "idle" });
  }

  /** Draws the CURRENT video frame -- exactly what's on screen right now,
   * nothing buffered/cached -- onto a hidden canvas and reads it back out
   * as a data URL. This is the ONE real frame this feature ever sends
   * anywhere, and only when the user explicitly asks a question about it;
   * the live stream itself never leaves this component on its own. */
  function captureCurrentFrame(): string | null {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  }

  async function askAboutFrame(): Promise<void> {
    const frame = captureCurrentFrame();
    if (!frame) {
      setAskState({ phase: "error", message: "Could not capture the current frame." });
      return;
    }
    setAskState({ phase: "asking" });
    try {
      const text = await analyzeFrame(frame, question);
      setAskState({ phase: "answered", text });
    } catch (error) {
      setAskState({ phase: "error", message: error instanceof Error ? error.message : "Could not analyze that frame." });
    }
  }

  if (state.phase === "unavailable") {
    return (
      <div className="live-view live-view--unavailable">
        <p className="state-message">
          Live view requires the NAQSH desktop app -- an ordinary browser tab has no way to capture another application's window. This session is running in a
          browser, so live view isn't available here.
        </p>
      </div>
    );
  }

  return (
    <div className="live-view">
      {state.phase === "idle" ? (
        <button type="button" className="btn btn--primary" onClick={refreshSources}>
          Show available windows
        </button>
      ) : null}

      {state.phase === "listing" ? <p className="state-message">Listing windows…</p> : null}

      {state.phase === "picking" ? (
        state.sources.length === 0 ? (
          <p className="state-message">No capturable windows were found.</p>
        ) : (
          <ul className="live-view__sources">
            {state.sources.map((source) => (
              <li key={source.id}>
                <button type="button" className="live-view__source" onClick={() => startCapture(source)}>
                  {source.thumbnailDataUrl ? <img src={source.thumbnailDataUrl} alt="" /> : <span className="live-view__source-placeholder" aria-hidden="true" />}
                  <span>{source.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {state.phase === "starting" ? <p className="state-message">Starting capture of "{state.source.name}"…</p> : null}

      {state.phase === "error" ? (
        <p className="state-message" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.phase === "live" ? (
        <div className="live-view__stage">
          <div className="live-view__indicator">
            <Badge tone="danger">● Live</Badge>
            <span>{state.source.name}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={stopCapture}>
              Stop
            </button>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} className="live-view__video" autoPlay muted />
          <canvas ref={canvasRef} className="live-view__capture-canvas" aria-hidden="true" />

          <div className="live-view__ask">
            {isRealProject ? (
              <>
                <label className="live-view__ask-field">
                  <span>Ask about this frame</span>
                  <input
                    type="text"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="What is shown in this view?"
                    disabled={askState.phase === "asking"}
                  />
                </label>
                <button type="button" className="btn btn--primary btn--sm" onClick={askAboutFrame} disabled={askState.phase === "asking"}>
                  {askState.phase === "asking" ? "Analyzing…" : "Capture & ask"}
                </button>
                {askState.phase === "answered" ? <p className="live-view__ask-answer">{askState.text}</p> : null}
                {askState.phase === "error" ? (
                  <p className="live-view__ask-answer live-view__ask-answer--error" role="alert">
                    {askState.message}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="state-message">Asking about a captured frame needs a real connected project -- not available for the offline demo.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
