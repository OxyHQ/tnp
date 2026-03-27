import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { config } from "./config.js";

import authRouter from "./routes/auth.js";
import tldsRouter from "./routes/tlds.js";
import domainsRouter from "./routes/domains.js";
import clientRouter from "./routes/client.js";

const app = express();

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);
app.use(express.json());

app.use("/auth", authRouter);
app.use("/tlds", tldsRouter);
app.use("/domains", domainsRouter);
app.use("/client", clientRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tnp-api" });
});

async function start() {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  console.log(`Connected to MongoDB (${config.dbName})`);

  app.listen(config.port, () => {
    console.log(`TNP API running on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error("Failed to start TNP API:", err);
  process.exit(1);
});
