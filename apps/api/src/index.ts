import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { config } from "./config.js";
import { oxyAuthOptional } from "./middleware/auth.js";
import { runSeed } from "./seed.js";

import tldsRouter from "./routes/tlds.js";
import domainsRouter from "./routes/domains.js";
import clientRouter from "./routes/client.js";
import dnsRouter from "./routes/dns.js";
import nodesRouter from "./routes/nodes.js";
import relaysRouter from "./routes/relays.js";

const app = express();

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json());

// Serve installer scripts when accessed via get.tnp.network
// curl -fsSL https://get.tnp.network | sh  →  serves install.sh
// irm https://get.tnp.network/ps | iex     →  serves install.ps1
app.use((req, res, next) => {
  const host = req.hostname;
  if (host !== "get.tnp.network") return next();

  if (req.path === "/" || req.path === "/install.sh") {
    req.url = "/client/install.sh";
  } else if (req.path === "/ps" || req.path === "/install.ps1") {
    req.url = "/client/install.ps1";
  }
  next();
});

// Public routes -- no auth needed at all
app.use("/dns", dnsRouter);
app.use("/client", clientRouter);
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tnp-api" });
});

// Routes with mixed auth -- oxy.auth() sets req.user if token present,
// individual handlers use requireAuth for write operations.
// Wrapping in optionalAuth so GET requests work without a token.
app.use("/tlds", oxyAuthOptional, tldsRouter);
app.use("/domains", oxyAuthOptional, domainsRouter);
app.use("/nodes", oxyAuthOptional, nodesRouter);
app.use("/relays", oxyAuthOptional, relaysRouter);

// Serve parking page directly for TNP domain Host headers.
// When a user visits "nate.ox" in their browser and the domain has no
// service node, DNS points to this server and we render the parking page
// inline — no redirect, URL stays as "nate.ox".
app.use(async (req, res, next) => {
  const host = req.hostname;
  if (!host || host === "localhost" || host.endsWith("tnp.network") || host.endsWith("oxy.so") || host.endsWith("pages.dev")) {
    return next();
  }
  if (!host.includes(".")) return next();

  const parts = host.split(".");
  const tld = parts[parts.length - 1];
  const name = parts.slice(0, -1).join(".");

  // Check if this is a registered TNP domain
  const Domain = (await import("./models/Domain.js")).default;
  const domain = await Domain.findOne({ name, tld, status: "active" }).catch(() => null);

  const isRegistered = !!domain;
  const hasRecords = domain ? domain.records.length > 0 : false;

  // If domain has a service node, let it pass (overlay handles it)
  if (domain?.serviceNodeId) return next();

  const title = isRegistered
    ? `${host} — Registered on TNP`
    : `${host} — Available on TNP`;
  const subtitle = isRegistered
    ? "This domain is registered on The Network Protocol."
    : "This domain is available. Register it on The Network Protocol.";
  const ctaText = isRegistered ? "View domain details" : "Register this domain";
  const ctaHref = isRegistered
    ? `https://tnp.network/d/${host}`
    : "https://tnp.network/register";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000;color:#e0e0e0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center;padding:2rem}
    h1{font-size:2.5rem;color:#00ffa3;margin-bottom:1rem;letter-spacing:-0.02em}
    p{font-size:0.875rem;color:#888;margin-bottom:2rem}
    a{color:#00ffa3;text-decoration:none;font-size:0.875rem;transition:color .2s}
    a:hover{color:#fff}
    .links{display:flex;flex-direction:column;gap:0.75rem}
    .footer{position:fixed;bottom:2rem;font-size:0.75rem;color:#444}
    .footer a{color:#555;font-size:0.75rem}
  </style>
</head>
<body>
  <h1>${host}</h1>
  <p>${subtitle}</p>
  <div class="links">
    <a href="${ctaHref}">[${ctaText}]</a>
    <a href="https://oxy.so/tnp">[What is TNP?]</a>
  </div>
  <div class="footer">Powered by <a href="https://tnp.network">TNP</a> · <a href="https://oxy.so">Oxy</a></div>
</body>
</html>`);
});

async function start() {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  console.log(`Connected to MongoDB (${config.dbName})`);

  await runSeed();

  app.listen(config.port, () => {
    console.log(`TNP API running on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start TNP API:", err);
  process.exit(1);
});
