import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

interface TLD {
  _id: string;
  name: string;
}

export default function Register() {
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
    }).catch(() => {});
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
        .catch(() => {
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
      setSuccess(`${name}.${tld} registered successfully!`);
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-24 text-center lg:px-6">
        <Helmet>
          <title>Register a Domain — TNP</title>
          <meta name="description" content="Claim your name on The Network Protocol. Pick a TLD and register your domain instantly with your Oxy account." />
          <link rel="canonical" href="https://tnp.network/register" />
          <meta property="og:title" content="Register a Domain — TNP" />
          <meta property="og:description" content="Claim your name on The Network Protocol. Pick a TLD and register instantly." />
          <meta property="og:url" content="https://tnp.network/register" />
        </Helmet>
        <h1 className="mb-4 font-pixel text-xl text-accent">
          Register a Domain
        </h1>
        <p className="mb-8 font-mono text-sm text-muted">
          Sign in with your Oxy account to register a TNP domain.
        </p>
        <button
          onClick={() => signIn()}
          className="cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
        >
          [sign in with oxy]
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>Register a Domain — TNP</title>
        <meta name="description" content="Register your domain on The Network Protocol." />
      </Helmet>
      <h1 className="mb-8 font-pixel text-xl text-accent">
        Register a Domain
      </h1>

      <form onSubmit={handleRegister} className="space-y-5">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="yourname"
            className="flex-1 rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors"
            required
          />
          <select
            value={tld}
            onChange={(e) => setTld(e.target.value)}
            className="rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary"
          >
            {tlds.map((t) => (
              <option key={t._id} value={t.name}>
                .{t.name}
              </option>
            ))}
          </select>
        </div>

        {name && !checking && available !== null && (
          <p className={`font-mono text-sm ${available ? "text-accent" : "text-red-400"}`}>
            {name}.{tld} is {available ? "available" : "already taken"}
          </p>
        )}
        {checking && (
          <p className="font-mono text-sm text-muted">Checking availability...</p>
        )}

        {error && <p className="font-mono text-sm text-red-400">{error}</p>}
        {success && <p className="font-mono text-sm text-accent">{success}</p>}

        <button
          type="submit"
          disabled={!available || registering}
          className="w-full cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registering ? "Registering..." : `Register ${name || "domain"}.${tld}`}
        </button>
      </form>
    </div>
  );
}
