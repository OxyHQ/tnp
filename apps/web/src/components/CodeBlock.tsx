import { useState } from "react";

interface CodeBlockProps {
  code: string;
  className?: string;
}

export default function CodeBlock({ code, className = "" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3 ${className}`}
    >
      <code className="font-mono text-sm text-primary">{code}</code>
      <button
        onClick={copy}
        className="ml-3 cursor-pointer rounded-[10px] border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
