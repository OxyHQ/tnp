import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { OxyProvider } from "@oxyhq/services";
import { BloomThemeProvider } from "@oxyhq/bloom/theme";
import "./lib/i18n";
import App from "./App";
import "./index.css";

const OXY_API = "https://api.oxy.so";

// TNP's registered Oxy OAuth client (public clientId). Overridable per-env.
const OXY_CLIENT_ID =
  import.meta.env.VITE_OXY_CLIENT_ID ||
  "oxy_dk_0a96126c6cf3e879c3df369b78ccc0471d66b3adeb4ede4d";

/**
 * TNP's brand green, fed to Bloom's colour engine as the theme seed.
 *
 * The whole palette is derived from this one value — surfaces, borders, text
 * and the on-colours that have to stay legible against each of them. The app
 * previously declared seventeen `--color-*` values by hand in `index.css`, of
 * which eleven collided with names Bloom owns, so the rendered palette was
 * partly TNP's and partly Bloom's depending on which names overlapped.
 *
 * `colorPreset="oxy"` is gone with them: a preset and a seed are two ways of
 * saying the same thing, and the seed is the one that carries TNP's identity.
 */
const TNP_SEED = "#22c55e";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found in document");
}

createRoot(rootElement).render(
  <StrictMode>
    <BloomThemeProvider mode="dark" seed={TNP_SEED}>
      <Suspense fallback={<div className="min-h-screen bg-background" />}>
        <OxyProvider baseURL={OXY_API} clientId={OXY_CLIENT_ID}>
          <App />
        </OxyProvider>
      </Suspense>
    </BloomThemeProvider>
  </StrictMode>
);
