import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "./button.tsx";

export function IconButton({
  icon: Icon,
  label,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "title"> & {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Button {...props} className={`icon-button ${className}`} aria-label={label} title={label}>
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}
