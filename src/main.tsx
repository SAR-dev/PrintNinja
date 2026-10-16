import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme/ThemeProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "./components/ui/sonner";
import "./index.css";
import "./lib/i18n";

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
      <ThemeProvider defaultTheme="system" storageKey="printninja-theme">
        <App />
        <Toaster richColors />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
