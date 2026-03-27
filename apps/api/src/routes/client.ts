import { Router } from "express";

const router = Router();

const VERSION = "0.1.0";
const BASE = "https://get.tnp.network/releases";

// GET /client/latest -- returns latest daemon version + download URLs per platform
router.get("/latest", (_req, res) => {
  res.json({
    version: VERSION,
    platforms: {
      "darwin-arm64": `${BASE}/${VERSION}/tnp-darwin-arm64`,
      "darwin-x64": `${BASE}/${VERSION}/tnp-darwin-x64`,
      "linux-x64": `${BASE}/${VERSION}/tnp-linux-x64`,
      "linux-arm64": `${BASE}/${VERSION}/tnp-linux-arm64`,
      "win32-x64": `${BASE}/${VERSION}/tnp-win32-x64.exe`,
    },
    install: {
      unix: "curl -fsSL https://get.tnp.network | sh",
      windows: "irm https://get.tnp.network/install.ps1 | iex",
    },
  });
});

export default router;
