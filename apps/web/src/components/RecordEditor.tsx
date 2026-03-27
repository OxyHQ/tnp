import { useState } from "react";

interface RecordEditorProps {
  onSubmit: (record: {
    type: string;
    name: string;
    value: string;
    ttl: number;
  }) => void;
  initial?: { type: string; name: string; value: string; ttl: number };
  submitLabel?: string;
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"];

export default function RecordEditor({
  onSubmit,
  initial,
  submitLabel = "Add Record",
}: RecordEditorProps) {
  const [type, setType] = useState(initial?.type || "A");
  const [name, setName] = useState(initial?.name || "@");
  const [value, setValue] = useState(initial?.value || "");
  const [ttl, setTtl] = useState(initial?.ttl || 3600);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ type, name, value, ttl });
    if (!initial) {
      setValue("");
      setName("@");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="block rounded-[10px] border border-border bg-background px-3 py-2 text-sm text-foreground"
        >
          {RECORD_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="block rounded-[10px] border border-border bg-background px-3 py-2 text-sm text-foreground"
          placeholder="@"
          required
        />
      </div>
      <div className="flex-1 space-y-1">
        <label className="text-xs text-muted-foreground">Value</label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="block w-full rounded-[10px] border border-border bg-background px-3 py-2 text-sm text-foreground"
          placeholder="192.168.1.1"
          required
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">TTL</label>
        <input
          type="number"
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
          className="block w-24 rounded-[10px] border border-border bg-background px-3 py-2 text-sm text-foreground"
          min={60}
        />
      </div>
      <button
        type="submit"
        className="cursor-pointer rounded-[10px] border border-primary bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {submitLabel}
      </button>
    </form>
  );
}
