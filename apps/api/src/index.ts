import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { config } from "./config.js";
import { oxyAuth } from "./middleware/auth.js";
import { runSeed } from "./seed.js";

import tldsRouter from "./routes/tlds.js";
import domainsRouter from "./routes/domains.js";
import clientRouter from "./routes/client.js";
import dnsRouter from "./routes/dns.js";

const app = express();

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json());

// Public routes -- no auth needed at all
app.use("/dns", dnsRouter);
app.use("/client", clientRouter);
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tnp-api" });
});

// Routes with mixed auth -- oxy.auth() sets req.user if token present,
// individual handlers use requireAuth for write operations.
// Wrapping in optionalAuth so GET requests work without a token.
const optionalAuth: express.RequestHandler = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return next();
  }
  oxyAuth(req, res, (err?: unknown) => {
    if (err) {
      (req as Record<string, unknown>).user = undefined;
    }
    next();
  });
};

app.use("/tlds", optionalAuth, tldsRouter);
app.use("/domains", optionalAuth, domainsRouter);

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
