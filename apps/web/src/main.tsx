import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { WebOxyProvider } from "@oxyhq/auth";
import { BloomThemeProvider } from "@oxyhq/bloom/theme";
import "./lib/i18n";
import App from "./App";
import "./index.css";

const OXY_API = "https://api.oxy.so";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in document");
}

createRoot(rootElement).render(
  <StrictMode>
    <BloomThemeProvider mode="dark" colorPreset="oxy">
      <Suspense fallback={<div className="min-h-screen bg-[#000]" />}>
        <WebOxyProvider baseURL={OXY_API}>
          <App />
        </WebOxyProvider>
      </Suspense>
    </BloomThemeProvider>
  </StrictMode>
);
