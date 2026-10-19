import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { dateLabels } from "../lib/delivery-labels.ts";
import { IconButton } from "./icon-button.tsx";

export function BrowserToolbar({
  title,
  date,
  service,
  busy,
  onRefresh,
  children,
}: {
  title: string;
  date?: string;
  service?: string;
  busy: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const label = date ? dateLabels(date) : undefined;
  return (
    <header className="browser-toolbar">
      <div>
        <h2 tabIndex={-1} data-dialog-return-focus>
          {title}
        </h2>
        {date && label && (
          <p className="muted">
            <time dateTime={date}>
              {label.weekday}, {label.date}
            </time>
            {service ? ` · ${service}` : ""}
          </p>
        )}
      </div>
      <div className="app-toolbar" role="group" aria-label="Meal browser actions">
        <IconButton icon={RefreshCw} label="Refresh" disabled={busy} onClick={onRefresh} />
        {children}
      </div>
    </header>
  );
}
