import { Link } from "react-router-dom";

interface DomainCardProps {
  name: string;
  tld: string;
  status: string;
  oxyUserId?: string;
}

export default function DomainCard({
  name,
  tld,
  status,
  oxyUserId,
}: DomainCardProps) {
  return (
    <Link
      to={`/d/${name}.${tld}`}
      className="block w-full rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-foreground">
          {name}
          <span className="text-primary-text">.{tld}</span>
        </span>
        <span
          className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
            status === "active"
              ? "bg-primary/10 text-primary-text"
              : "bg-accent text-muted-foreground/70"
          }`}
        >
          {status}
        </span>
      </div>
      {oxyUserId && (
        <p className="mt-1 font-mono text-xs text-muted-foreground/70">{oxyUserId}</p>
      )}
    </Link>
  );
}
