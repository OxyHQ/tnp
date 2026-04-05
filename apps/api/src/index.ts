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

// Catch-all: if the Host header is a TNP domain (not the API itself),
// redirect to the parking page on the web frontend.
app.use((req, res, next) => {
  const host = req.hostname;
  if (!host || host === "localhost" || host.endsWith("tnp.network") || host.endsWith("oxy.so") || host.endsWith("pages.dev")) {
    return next();
  }
  if (host.includes(".")) {
    res.redirect(302, `https://tnp.network/park/${host}`);
    return;
  }
  next();
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
