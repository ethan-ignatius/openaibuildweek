import type { ReactNode } from "react";

export function StatusPill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "danger" | "info"; children: ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
