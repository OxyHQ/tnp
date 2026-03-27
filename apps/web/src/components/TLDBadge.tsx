interface TLDBadgeProps {
  name: string;
  status?: "active" | "proposed" | "pending";
}

export default function TLDBadge({ name, status = "active" }: TLDBadgeProps) {
  const statusColors = {
    active: "border-accent/30 text-accent",
    proposed: "border-amber-400/30 text-amber-400",
    pending: "border-muted/30 text-muted",
  };

  return (
    <span
      className={`inline-flex items-center rounded-md border px-3 py-1 font-mono text-xs ${statusColors[status]}`}
    >
      .{name}
    </span>
  );
}
