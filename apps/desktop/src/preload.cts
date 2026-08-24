import { contextBridge, ipcRenderer } from "electron";

/**
 * The ENTIRE surface a loaded page can reach into this process through --
 * three narrow, explicit, IPC-backed functions, nothing else. No raw
 * `ipcRenderer`, no `require`, no Node globals: `contextIsolation: true` +
 * this explicit allowlist is what makes "the renderer cannot get
 * arbitrary native access even if the loaded page were malicious" a real,
 * structural property rather than a convention someone could forget.
 */
export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
}

export interface NaqshDesktopBridge {
  isDesktop: true;
  platform: NodeJS.Platform;
  listCaptureSources(): Promise<CaptureSource[]>;
  selectCaptureSource(sourceId: string): Promise<{ armed: boolean }>;
  cancelCaptureSelection(): Promise<{ cancelled: boolean }>;
}

const bridge: NaqshDesktopBridge = {
  isDesktop: true,
  platform: process.platform,
  listCaptureSources: () => ipcRenderer.invoke("desktop:list-capture-sources"),
  selectCaptureSource: (sourceId: string) => ipcRenderer.invoke("desktop:select-capture-source", sourceId),
  cancelCaptureSelection: () => ipcRenderer.invoke("desktop:cancel-capture-selection")
};

contextBridge.exposeInMainWorld("naqshDesktop", bridge);
