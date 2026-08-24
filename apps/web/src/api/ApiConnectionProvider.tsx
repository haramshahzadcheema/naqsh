import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { checkApiHealth } from "./client.js";

export type ApiConnectionStatus = "checking" | "connected" | "offline";

interface ApiConnectionValue {
  status: ApiConnectionStatus;
  geminiConfigured: boolean;
  recheck: () => void;
}

const ApiConnectionContext = createContext<ApiConnectionValue>({ status: "checking", geminiConfigured: false, recheck: () => {} });

/**
 * Whether the real `@naqsh/api` server is reachable -- checked once via
 * `GET /health` on mount. When it's not (the server isn't running, or
 * this is a static/offline preview), the chat-first workspace falls back
 * to its local, clearly-labeled demo behavior (see `chat/useChatThreads.ts`)
 * rather than breaking outright. This is the ONE place that fallback
 * decision is made.
 */
export function ApiConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<ApiConnectionStatus>("checking");
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("checking");
    checkApiHealth().then((health) => {
      if (cancelled) return;
      setStatus(health ? "connected" : "offline");
      setGeminiConfigured(health?.geminiConfigured ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  return (
    <ApiConnectionContext.Provider value={{ status, geminiConfigured, recheck: () => setGeneration((g) => g + 1) }}>{children}</ApiConnectionContext.Provider>
  );
}

export function useApiConnection(): ApiConnectionValue {
  return useContext(ApiConnectionContext);
}
