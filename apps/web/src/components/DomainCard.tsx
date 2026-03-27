interface DomainCardProps {
  name: string;
  tld: string;
  status: string;
  oxyUserId?: string;
  onClick?: () => void;
}

export default function DomainCard({
  name,
  tld,
  status,
  oxyUserId,
  onClick,
}: DomainCardProps) {
  return (
    <button
      onClick={onClick}
      className="w-full cursor-pointer rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-primary/30"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-lg text-foreground">
          {name}
          <span className="text-primary">.{tld}</span>
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status === "active"
              ? "bg-primary/10 text-primary"
              : "bg-muted/10 text-muted"
          }`}
        >
          {status}
        </span>
      </div>
      {oxyUserId && (
        <p className="mt-1 text-sm text-muted">Owner: {oxyUserId}</p>
      )}
    </button>
  );
}
