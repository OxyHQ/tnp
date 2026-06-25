import { useEffect } from "react";
import { useAuth as useOxyAuth } from "@oxyhq/auth";
import { setApiClient } from "./api";

export { useOxyAuth as useAuth };

const TNP_API_BASE = import.meta.env.VITE_API_URL || "/api";

/**
 * Bridges the OxyServices session to the TNP API module.
 *
 * Mints a linked backend client off the session owner (see
 * `oxyServices.createLinkedClient`): it targets TNP's own API origin but its
 * bearer token stays in lockstep with the Oxy session and its 401 refresh path
 * delegates back to that session. Place inside WebOxyProvider so the session is
 * available. No app-local token providers, Authorization headers, or refresh
 * retries — the SDK owns all of that.
 */
export function AuthBridge() {
  const { oxyServices } = useOxyAuth();

  useEffect(() => {
    const linked = oxyServices.createLinkedClient({ baseURL: TNP_API_BASE });
    setApiClient(linked.client);
    return () => {
      setApiClient(null);
      linked.dispose();
    };
  }, [oxyServices]);

  return null;
}
