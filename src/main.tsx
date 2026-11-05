import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "./components/ui/sonner";
import { PrefsProvider } from "./lib/prefs/PrefsProvider";
import {
  SETTING_KEYS,
  parseTheme,
  resolveTheme,
  systemIsDark,
} from "./lib/prefs/prefs";
import { settingsLsKey } from "./lib/settings";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-ext-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-ext-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-ext-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./index.css";
import "./mobile.css";
import "./lib/i18n";

// Apply the cached theme before the first paint so a dark-mode user never
// sees a flash of the light UI. PrefsProvider re-applies after mount.
function applyCachedTheme() {
  try {
    const stored = localStorage.getItem(settingsLsKey(SETTING_KEYS.theme));
    if (resolveTheme(parseTheme(stored), systemIsDark()) === "dark") {
      document.documentElement.dataset.theme = "dark";
    }
  } catch {
    /* storage unavailable: stays light */
  }
}
applyCachedTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PrefsProvider>
        <App />
        <Toaster closeButton />
      </PrefsProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
