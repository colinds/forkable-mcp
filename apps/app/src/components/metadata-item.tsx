import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function MetadataItem({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="metadata-item">
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
