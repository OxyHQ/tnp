import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { WebOxyProvider } from "@oxyhq/auth";
import "./lib/i18n";
import App from "./App";
import "./index.css";

const OXY_API = "https://api.oxy.so";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div className="min-h-screen bg-[#000]" />}>
      <WebOxyProvider baseURL={OXY_API}>
        <App />
      </WebOxyProvider>
    </Suspense>
  </StrictMode>
);
