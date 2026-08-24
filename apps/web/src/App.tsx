import { ThemeProvider } from "./theme/ThemeProvider.js";
import { ProjectDataProvider } from "./data/ProjectDataProvider.js";
import { SettingsProvider } from "./settings/SettingsProvider.js";
import { ApiConnectionProvider } from "./api/ApiConnectionProvider.js";
import { OnboardingExperience } from "./onboarding/OnboardingExperience.js";
import { MainShell } from "./components/chat/MainShell.js";

export function App(): JSX.Element {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <ApiConnectionProvider>
          <ProjectDataProvider>
            <a className="skip-link" href="#main-content">
              Skip to main content
            </a>
            <OnboardingExperience>
              <MainShell />
            </OnboardingExperience>
          </ProjectDataProvider>
        </ApiConnectionProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
