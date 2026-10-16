import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DesignerPage } from "./pages/Designer";
import { PrintPage } from "./pages/Print";
import { PrinterSetupPage } from "./pages/PrinterSetup";
import { HistoryPage } from "./pages/History";
import { SettingsPage } from "./pages/Settings";

export default function App() {
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
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
