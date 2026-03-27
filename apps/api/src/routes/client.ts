import { Router } from "express";

const router = Router();

// GET /client/latest -- returns latest daemon version + download URLs per platform
router.get("/latest", (_req, res) => {
  res.json({
    version: "0.1.0",
    platforms: {
      macos: "https://get.tnp.network/releases/0.1.0/tnp-macos",
      linux: "https://get.tnp.network/releases/0.1.0/tnp-linux",
      windows: "coming soon",
    },
  });
});

export default router;
