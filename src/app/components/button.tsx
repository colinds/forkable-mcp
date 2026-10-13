import type { ButtonHTMLAttributes } from "react";

export function Button({
  primary = false,
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      type={type}
      className={`btn ${primary ? "btn-primary" : "btn-secondary"} cursor-interaction ${className}`}
    />
  );
}
