import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { WebOxyProvider } from "@oxyhq/auth";
import { BloomThemeProvider } from "@oxyhq/bloom/theme";
import "./lib/i18n";
import App from "./App";
import "./index.css";

const OXY_API = "https://api.oxy.so";

// TNP's registered Oxy OAuth client (public clientId). Overridable per-env.
const OXY_CLIENT_ID =
  import.meta.env.VITE_OXY_CLIENT_ID ||
  "oxy_dk_0a96126c6cf3e879c3df369b78ccc0471d66b3adeb4ede4d";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in document");
}

createRoot(rootElement).render(
  <StrictMode>
    <BloomThemeProvider mode="dark" colorPreset="oxy">
      <Suspense fallback={<div className="min-h-screen bg-[#000]" />}>
        <WebOxyProvider baseURL={OXY_API} clientId={OXY_CLIENT_ID}>
          <App />
        </WebOxyProvider>
      </Suspense>
    </BloomThemeProvider>
  </StrictMode>
);
