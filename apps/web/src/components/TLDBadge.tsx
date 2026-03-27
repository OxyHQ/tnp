interface TLDBadgeProps {
  name: string;
  status?: "active" | "proposed" | "pending";
}

export default function TLDBadge({ name, status = "active" }: TLDBadgeProps) {
  const statusColors = {
    active: "border-primary/30 text-primary",
    proposed: "border-yellow-500/30 text-yellow-500",
    pending: "border-muted text-muted",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-mono ${statusColors[status]}`}
    >
      .{name}
    </span>
  );
}
