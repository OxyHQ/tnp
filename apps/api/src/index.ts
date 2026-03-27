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

// Oxy auth middleware (optional) -- sets req.user.id if token present, doesn't block otherwise
app.use(oxyAuth);

app.use("/tlds", tldsRouter);
app.use("/domains", domainsRouter);
app.use("/client", clientRouter);
app.use("/dns", dnsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tnp-api" });
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
