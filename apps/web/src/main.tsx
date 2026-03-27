import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebOxyProvider } from "@oxyhq/auth";
import App from "./App";
import "./index.css";

const OXY_API = "https://api.oxy.so";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebOxyProvider baseURL={OXY_API}>
      <App />
    </WebOxyProvider>
  </StrictMode>
);
