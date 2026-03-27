import { Router } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { config } from "../config.js";

const router = Router();

// POST /auth/oxy -- Oxy SSO callback
router.post("/oxy", async (req, res) => {
  try {
    const { oxyUserId } = req.body;

    if (!oxyUserId || typeof oxyUserId !== "string") {
      res.status(400).json({ error: "oxyUserId is required" });
      return;
    }

    let user = await User.findOne({ oxyUserId });

    if (!user) {
      user = await User.create({ oxyUserId });
    }

    const token = jwt.sign(
      { userId: user._id.toString(), oxyUserId: user.oxyUserId },
      config.jwtSecret,
      { expiresIn: "7d" }
    );

    res.json({ token, user: { id: user._id, oxyUserId: user.oxyUserId } });
  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
});

export default router;
