import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

interface TLD {
  _id: string;
  name: string;
}

export default function Register() {
  const { isAuthenticated, login } = useAuth();
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
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <h1 className="mb-4 text-3xl font-bold tracking-tight">
          Register a Domain
        </h1>
        <p className="mb-8 text-muted">
          Sign in with your Oxy account to register a TNP domain.
        </p>
        <button
          onClick={() => login("demo-user")}
          className="cursor-pointer rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Sign in with Oxy
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        [ Register ]
      </p>
      <h1 className="mb-8 text-3xl font-bold tracking-tight">
        Register a Domain
      </h1>

      <form onSubmit={handleRegister} className="space-y-6">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="yourname"
            className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 font-mono text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            required
          />
          <select
            value={tld}
            onChange={(e) => setTld(e.target.value)}
            className="rounded-xl border border-border bg-surface px-4 py-3 font-mono text-foreground"
          >
            {tlds.map((t) => (
              <option key={t._id} value={t.name}>
                .{t.name}
              </option>
            ))}
          </select>
        </div>

        {name && !checking && available !== null && (
          <p className={`text-sm ${available ? "text-primary" : "text-red-400"}`}>
            {name}.{tld} is {available ? "available" : "already taken"}
          </p>
        )}
        {checking && (
          <p className="text-sm text-muted">Checking availability...</p>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {success && <p className="text-sm text-primary">{success}</p>}

        <button
          type="submit"
          disabled={!available || registering}
          className="w-full cursor-pointer rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {registering ? "Registering..." : `Register ${name || "domain"}.${tld}`}
        </button>
      </form>
    </div>
  );
}
