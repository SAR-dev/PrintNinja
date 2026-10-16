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

    // Check for first run
    if (!onboardingComplete) {
      diagnostics.info("First run detected, showing onboarding");
    }
  }, [onboardingComplete]);

  const handleOnboardingComplete = () => {
    localStorage.setItem("printninja-onboarding-complete", "true");
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
