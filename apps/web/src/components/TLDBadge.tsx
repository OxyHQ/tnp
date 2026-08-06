interface TLDBadgeProps {
  name: string;
  status?: "active" | "proposed" | "pending";
}

export default function TLDBadge({ name, status = "active" }: TLDBadgeProps) {
  const statusColors = {
    active: "border-primary/30 text-primary-text",
    proposed: "border-warning-subtle text-warning-text",
    pending: "border-muted/30 text-muted-foreground/70",
  };

  return (
    <span
      className={`inline-flex items-center rounded-md border px-3 py-1 font-mono text-xs ${statusColors[status]}`}
    >
      .{name}
    </span>
  );
}
