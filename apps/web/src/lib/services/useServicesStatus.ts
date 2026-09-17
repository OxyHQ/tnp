import { useCallback, useEffect, useState } from "react";
import type { ServicesStatus } from "@tnp/shared-types";
import { apiRequest } from "../api";
import { errorStatus, isAbort } from "./errors";
import { servicesAvailability, type ServicesAvailability } from "./status";

/**
 * `GET /services/status`, which drives the whole services area.
 *
 * The web deploys before the API that serves `/services`, so a 404 is an
 * expected answer, not an error: it and a disabled catalog both mean the area
 * is not available yet. Nothing about services is shown on a guess.
 */
export function useServicesStatus(): { availability: ServicesAvailability; recheck: () => void } {
  const [availability, setAvailability] = useState<ServicesAvailability>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setAvailability({ kind: "loading" });
    apiRequest<ServicesStatus>("GET", "/services/status", { signal: controller.signal })
      .then((status) => {
        // A 200 that is not the contract (an SPA fallback page, say) is not a status.
        if (status === null || typeof status !== "object" || typeof status.catalog !== "boolean") {
          setAvailability(servicesAvailability({ httpStatus: 404 }));
          return;
        }
        setAvailability(servicesAvailability({ status }));
      })
      .catch((err: unknown) => {
        if (isAbort(err, controller.signal)) return;
        setAvailability(servicesAvailability({ httpStatus: errorStatus(err) }));
      });
    return () => controller.abort();
  }, [attempt]);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);
  return { availability, recheck };
}
