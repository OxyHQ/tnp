import { Router } from "express";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const router = Router();

const VERSION = "0.1.0";
const REPO = "OxyHQ/tnp";
const BASE = `https://github.com/${REPO}/releases/download/v${VERSION}`;

// Resolve the path to installer scripts relative to the monorepo root.
// In production the scripts are at ../../packages/client/ relative to the API src.
// We go from apps/api/src/routes/ -> repo root -> packages/client/.
const SCRIPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "packages", "client"
);

// Cache the script contents at startup so we don't hit disk on every request.
let installShCache: string | null = null;
let installPs1Cache: string | null = null;

function loadScript(filename: string): string | null {
  try {
    return readFileSync(resolve(SCRIPTS_DIR, filename), "utf-8");
  } catch {
    return null;
  }
}

// GET /client/latest -- returns latest daemon version + download URLs per platform
router.get("/latest", (_req, res) => {
  res.json({
    version: VERSION,
    platforms: {
      "darwin-arm64": `${BASE}/tnp-darwin-arm64`,
      "darwin-x64": `${BASE}/tnp-darwin-x64`,
      "linux-x64": `${BASE}/tnp-linux-x64`,
      "linux-arm64": `${BASE}/tnp-linux-arm64`,
      "win32-x64": `${BASE}/tnp-win32-x64.exe`,
    },
    install: {
      unix: "curl -fsSL https://get.tnp.network | sh",
      windows: "irm https://get.tnp.network/ps | iex",
    },
  });
});

// GET /client/install.sh -- serves the Unix installer script
router.get("/install.sh", (_req, res) => {
  if (!installShCache) {
    installShCache = loadScript("install.sh");
  }
  if (!installShCache) {
    res.status(404).type("text/plain").send("install.sh not found");
    return;
  }
  res.type("text/plain").send(installShCache);
});

// GET /client/install.ps1 -- serves the Windows installer script
router.get("/install.ps1", (_req, res) => {
  if (!installPs1Cache) {
    installPs1Cache = loadScript("install.ps1");
  }
  if (!installPs1Cache) {
    res.status(404).type("text/plain").send("install.ps1 not found");
    return;
  }
  res.type("text/plain").send(installPs1Cache);
});

export default router;
