import { OxyServices } from "@oxy.so/core";
import { createOptionalOxyAuth } from "@oxy.so/core/server";
import { config } from "../config.js";

const oxy = new OxyServices({ baseURL: config.oxyApiUrl });

// Optional Oxy auth: resolves req.userId / req.user when a valid bearer token
// is present, but never rejects the request. Route handlers enforce auth with
// `requireOxyAuth` from @oxy.so/core/server.
export const oxyAuthOptional = createOptionalOxyAuth(oxy);
