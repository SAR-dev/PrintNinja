import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Onboarding } from "./components/Onboarding";
import { DesignerPage } from "./pages/Designer";
import { PrintPage } from "./pages/Print";
import { PrinterSetupPage } from "./pages/PrinterSetup";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";
import { diagnostics } from "./lib/diagnostics";

export default function App() {
  const [onboardingComplete, setOnboardingComplete] = useState(() => {
    return localStorage.getItem("printninja-onboarding-complete") === "true";
  });

  useEffect(() => {
    diagnostics.info("App started", { platform: navigator.platform });
  }, []);

  // Onboarding persistence: DB is source of truth, localStorage is cache.
  // On reinstall the DB is cleared but localStorage may remain, so we
  // reconcile on mount: if DB says not done, show onboarding regardless.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const v = await invoke<string | null>("get_setting", { key: "onboarding_done" }).catch(() => null);
        if (cancelled) return;
        if (v === "true") {
          localStorage.setItem("printninja-onboarding-complete", "true");
          setOnboardingComplete(true);
        } else {
          // DB says not done (null/false/missing) — respect it even if localStorage says true (reinstall)
          const lsDone = localStorage.getItem("printninja-onboarding-complete") === "true";
          if (lsDone) {
            localStorage.removeItem("printninja-onboarding-complete");
            setOnboardingComplete(false);
          }
          if (!lsDone || v === null) {
            diagnostics.info("First run detected, showing onboarding");
          }
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const handleOnboardingComplete = async () => {
    localStorage.setItem("printninja-onboarding-complete", "true");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_setting", { key: "onboarding_done", value: "true" }).catch(() => {});
    } catch {}
    setOnboardingComplete(true);
    diagnostics.info("Onboarding completed");
  };

  if (!onboardingComplete) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<DesignerPage />} />
          <Route path="/template/:id" element={<DesignerPage />} />
          <Route path="/print" element={<PrintPage />} />
          <Route path="/printers" element={<PrinterSetupPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
