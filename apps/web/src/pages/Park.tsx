import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";

interface DomainData {
  _id: string;
  name: string;
  tld: string;
  status: string;
  records: { _id: string }[];
}

type ParkState = "loading" | "parked" | "configured" | "not-found";

export default function Park() {
  const { domain: domainParam } = useParams<{ domain: string }>();
  const { t } = useTranslation("park");
  const [state, setState] = useState<ParkState>("loading");
  const [domainName, setDomainName] = useState("");

  useEffect(() => {
    if (!domainParam) return;
    setDomainName(domainParam);
    let ignore = false;
    apiFetch<DomainData>(`/domains/lookup/${domainParam}`)
      .then((data) => {
        if (ignore) return;
        if (data.records.length > 0) {
          setState("configured");
        } else {
          setState("parked");
        }
      })
      .catch(() => {
        if (!ignore) setState("not-found");
      });
    return () => { ignore = true; };
  }, [domainParam]);

  if (state === "configured") {
    return <Navigate to={`/d/${domainParam}`} replace />;
  }

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <Helmet>
        <title>{t("meta.title", { domain: domainName })}</title>
        <meta name="description" content={t("meta.description", { domain: domainName })} />
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {state === "loading" && (
        <div className="font-mono text-sm text-muted">...</div>
      )}

      {state === "parked" && (
        <>
          <h1 className="mb-4 font-pixel text-3xl text-accent sm:text-4xl">
            {domainName}
          </h1>
          <p className="mb-8 font-mono text-sm text-secondary">
            {t("registeredOn")}
          </p>
          <div className="flex flex-col items-center gap-3">
            <Link
              to={`/d/${domainParam}`}
              className="font-mono text-sm text-accent transition-colors hover:text-primary"
            >
              [{t("viewDetails")}]
            </Link>
            <a
              href="https://oxy.so/tnp"
              className="font-mono text-sm text-muted transition-colors hover:text-secondary"
            >
              [{t("whatIsTnp")}]
            </a>
          </div>
        </>
      )}

      {state === "not-found" && (
        <>
          <h1 className="mb-4 font-pixel text-xl text-muted">
            {domainName}
          </h1>
          <p className="mb-6 font-mono text-sm text-muted">
            {t("notRegistered")}
          </p>
          <Link
            to="/register"
            className="font-mono text-sm text-accent transition-colors hover:text-primary"
          >
            [{t("registerIt")}]
          </Link>
        </>
      )}
    </div>
  );
}
