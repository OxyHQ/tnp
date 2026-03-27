import { Router } from "express";

const router = Router();

const VERSION = "0.1.0";
const REPO = "OxyHQ/tnp";
const BASE = `https://github.com/${REPO}/releases/download/v${VERSION}`;

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
      windows: "irm https://get.tnp.network | iex",
    },
  });
});

export default router;
