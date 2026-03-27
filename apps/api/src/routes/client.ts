import { Router } from "express";

const router = Router();

// GET /client/latest -- returns latest daemon version + download URLs per platform
router.get("/latest", (_req, res) => {
  res.json({
    version: "0.1.0",
    changelog: "Initial release of the TNP resolver daemon.",
    platforms: {
      macos: {
        url: "https://get.tnp.network/releases/tnp-0.1.0-darwin-amd64.tar.gz",
        sha256: "",
      },
      linux: {
        url: "https://get.tnp.network/releases/tnp-0.1.0-linux-amd64.tar.gz",
        sha256: "",
      },
      windows: null,
    },
  });
});

export default router;
