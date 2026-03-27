import type { Request, Response, NextFunction } from "express";
import { OxyServices } from "@oxyhq/core";
import { config } from "../config.js";

export interface AuthRequest extends Request {
  user?: {
    id: string;
  };
}

const oxy = new OxyServices({ baseURL: config.oxyApiUrl });

export const oxyAuth = oxy.auth();

export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user?.id) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}
