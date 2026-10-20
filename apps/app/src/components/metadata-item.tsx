import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function MetadataItem({
  icon: Icon,
  children,
  className = "",
  title,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={`metadata-item ${className}`} title={title}>
      <Icon size={16} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
