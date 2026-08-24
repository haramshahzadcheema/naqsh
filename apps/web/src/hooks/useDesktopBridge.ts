/**
 * Feature-detects the real native bridge `apps/desktop`'s preload script
 * exposes (`window.naqshDesktop`) -- `undefined` in every ordinary browser
 * tab (this exact same UI, unmodified) and a real, narrow object only when
 * this page is genuinely running inside the NAQSH desktop app. Nothing
 * here ever pretends the bridge exists when it doesn't; every caller that
 * wants window-capture must check this first and show the honest "desktop
 * app required" state otherwise (see `LiveViewPanel`).
 */
export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
}

export interface NaqshDesktopBridge {
  isDesktop: true;
  platform: string;
  listCaptureSources(): Promise<CaptureSource[]>;
  selectCaptureSource(sourceId: string): Promise<{ armed: boolean }>;
  cancelCaptureSelection(): Promise<{ cancelled: boolean }>;
}

declare global {
  interface Window {
    naqshDesktop?: NaqshDesktopBridge;
  }
}

export function useDesktopBridge(): NaqshDesktopBridge | null {
  return typeof window !== "undefined" && window.naqshDesktop ? window.naqshDesktop : null;
}
