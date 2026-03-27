interface TLDBadgeProps {
  name: string;
  status?: "active" | "proposed" | "pending";
}

export default function TLDBadge({ name, status = "active" }: TLDBadgeProps) {
  const statusColors = {
    active: "border-primary/30 text-primary",
    proposed: "border-yellow-500/30 text-yellow-400",
    pending: "border-muted-foreground/30 text-muted-foreground",
  };

  return (
    <span
      className={`inline-flex items-center rounded-[10px] border px-3 py-1 text-sm font-mono ${statusColors[status]}`}
    >
      .{name}
    </span>
  );
}
