import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_ENVIRONMENT, type EnvironmentChoice } from "./environments.js";
import { DEFAULT_MODEL_ID } from "./models.js";
import { DEFAULT_STYLE, type StyleId } from "./styles.js";

const STORAGE_KEY = "naqsh.settings";

interface StoredSettings {
  environment: EnvironmentChoice;
  modelId: string;
  styleId: StyleId;
}

interface SettingsContextValue extends StoredSettings {
  setEnvironment: (environment: EnvironmentChoice) => void;
  setModelId: (modelId: string) => void;
  setStyleId: (styleId: StyleId) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const DEFAULTS: StoredSettings = { environment: DEFAULT_ENVIRONMENT, modelId: DEFAULT_MODEL_ID, styleId: DEFAULT_STYLE };
const VALID_STYLES: StyleId[] = ["balanced", "concise", "detailed", "technical", "creative"];

function readStored(): StoredSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return {
      environment: parsed.environment === "mock_cad" || parsed.environment === "mock_simulation" ? parsed.environment : DEFAULT_ENVIRONMENT,
      modelId: typeof parsed.modelId === "string" && parsed.modelId.length > 0 ? parsed.modelId : DEFAULT_MODEL_ID,
      styleId: VALID_STYLES.includes(parsed.styleId as StyleId) ? (parsed.styleId as StyleId) : DEFAULT_STYLE
    };
  } catch {
    return DEFAULTS;
  }
}

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<StoredSettings>(readStored);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const setEnvironment = useCallback((environment: EnvironmentChoice) => setSettings((prev) => ({ ...prev, environment })), []);
  const setModelId = useCallback((modelId: string) => setSettings((prev) => ({ ...prev, modelId })), []);
  const setStyleId = useCallback((styleId: StyleId) => setSettings((prev) => ({ ...prev, styleId })), []);

  const value = useMemo(() => ({ ...settings, setEnvironment, setModelId, setStyleId }), [settings, setEnvironment, setModelId, setStyleId]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used within a SettingsProvider");
  return context;
}
