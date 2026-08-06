import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

interface TLD {
  _id: string;
  name: string;
}

export default function Register() {
  const { t } = useTranslation(["register", "common"]);
  const { isAuthenticated, signIn } = useAuth();
  const [tlds, setTlds] = useState<TLD[]>([]);
  const [name, setName] = useState("");
  const [tld, setTld] = useState("ox");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    apiFetch<TLD[]>("/tlds").then((data) => {
      if (!ignore) {
        setTlds(data);
        if (data.length > 0) setTld(data[0].name);
      }
    }).catch((err) => console.error("Failed to load TLDs:", err));
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!name.trim()) {
      setAvailable(null);
      return;
    }
    setChecking(true);
    let ignore = false;
    const timer = setTimeout(() => {
      apiFetch<{ available: boolean }>(`/domains/check/${name}.${tld}`)
        .then((data) => {
          if (!ignore) setAvailable(data.available);
        })
        .catch((err) => {
          console.error("Domain availability check failed:", err);
          if (!ignore) setAvailable(null);
        })
        .finally(() => {
          if (!ignore) setChecking(false);
        });
    }, 400);
    return () => { ignore = true; clearTimeout(timer); };
  }, [name, tld]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setRegistering(true);
    try {
      await apiFetch("/domains/register", {
        method: "POST",
        body: JSON.stringify({ name, tld }),
      });
      setSuccess(t("register:registerSuccess", { domain: `${name}.${tld}` }));
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("register:registrationFailed"));
    } finally {
      setRegistering(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-24 text-center lg:px-6">
        <Helmet>
          <title>{t("register:meta.title")} — TNP</title>
          <meta name="description" content={t("register:meta.description")} />
          <link rel="canonical" href="https://tnp.network/register" />
          <meta property="og:title" content={`${t("register:meta.title")} — TNP`} />
          <meta property="og:description" content={t("register:meta.ogDescription")} />
          <meta property="og:url" content="https://tnp.network/register" />
        </Helmet>
        <h1 className="mb-4 font-pixel text-xl text-primary-text">
          {t("register:title")}
        </h1>
        <p className="mb-8 font-mono text-sm text-muted-foreground/70">
          {t("register:signInPrompt")}
        </p>
        <button
          onClick={() => signIn()}
          className="cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-4 py-2.5 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20"
        >
          [{t("common:auth.signInWithOxy")}]
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("register:meta.title")} — TNP</title>
        <meta name="description" content={t("register:meta.descriptionForm")} />
      </Helmet>
      <h1 className="mb-8 font-pixel text-xl text-primary-text">
        {t("register:title")}
      </h1>

      <form onSubmit={handleRegister} className="space-y-5">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder={t("register:placeholder")}
            className="flex-1 rounded-md border border-border bg-surface px-4 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none transition-colors"
            required
          />
          <select
            value={tld}
            onChange={(e) => setTld(e.target.value)}
            className="rounded-md border border-border bg-surface px-4 py-2.5 font-mono text-sm text-foreground"
          >
            {tlds.map((t) => (
              <option key={t._id} value={t.name}>
                .{t.name}
              </option>
            ))}
          </select>
        </div>

        {name && !checking && available !== null && (
          <p className={`font-mono text-sm ${available ? "text-primary-text" : "text-error-text"}`}>
            {available ? t("register:domainAvailable", { domain: `${name}.${tld}` }) : t("register:domainTaken", { domain: `${name}.${tld}` })}
          </p>
        )}
        {checking && (
          <p className="font-mono text-sm text-muted-foreground/70">{t("register:checkingAvailability")}</p>
        )}

        {error && <p className="font-mono text-sm text-error-text">{error}</p>}
        {success && <p className="font-mono text-sm text-primary-text">{success}</p>}

        <button
          type="submit"
          disabled={!available || registering}
          className="w-full cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-4 py-2.5 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registering ? t("register:registering") : t("register:registerButton", { domain: `${name || "domain"}.${tld}` })}
        </button>
      </form>
    </div>
  );
}
