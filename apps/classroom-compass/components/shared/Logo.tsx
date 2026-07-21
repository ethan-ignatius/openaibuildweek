import { Compass, Sparkles } from "lucide-react";

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Classroom Compass">
      <span className="brand-mark" aria-hidden="true"><Compass size={compact ? 20 : 24} strokeWidth={2.25} /><Sparkles className="brand-spark" size={10} /></span>
      {!compact && <span><strong>Classroom</strong> Compass</span>}
    </div>
  );
}
