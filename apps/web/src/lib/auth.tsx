import { useEffect } from "react";
import { useAuth as useOxyAuth } from "@oxyhq/auth";
import { setTokenGetter } from "./api";

export { useOxyAuth as useAuth };

/**
 * Bridges the React auth context to the api module.
 * Place inside WebOxyProvider so apiFetch can access the auth token.
 */
export function AuthBridge() {
  const { oxyServices } = useOxyAuth();

  useEffect(() => {
    setTokenGetter(() => oxyServices.getClient().getAccessToken());
  }, [oxyServices]);

  return null;
}
