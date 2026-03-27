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
      className="w-full cursor-pointer rounded-lg border border-edge bg-surface-card p-4 text-left transition-colors hover:bg-surface-hover"
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm text-primary">
          {name}
          <span className="text-accent">.{tld}</span>
        </span>
        <span
          className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
            status === "active"
              ? "bg-accent/10 text-accent"
              : "bg-surface-hover text-muted"
          }`}
        >
          {status}
        </span>
      </div>
      {oxyUserId && (
        <p className="mt-1 font-mono text-xs text-muted">{oxyUserId}</p>
      )}
    </button>
  );
}
