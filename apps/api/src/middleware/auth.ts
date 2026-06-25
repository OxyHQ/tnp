import { OxyServices } from "@oxyhq/core";
import { createOptionalOxyAuth } from "@oxyhq/core/server";
import { config } from "../config.js";

const oxy = new OxyServices({ baseURL: config.oxyApiUrl });

// Optional Oxy auth: resolves req.userId / req.user when a valid bearer token
// is present, but never rejects the request. Route handlers enforce auth with
// `requireOxyAuth` from @oxyhq/core/server.
export const oxyAuthOptional = createOptionalOxyAuth(oxy);
