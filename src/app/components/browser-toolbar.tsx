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
  const refresh = (
    <IconButton
      icon={RefreshCw}
      label="Refresh"
      className="refresh-button"
      disabled={busy}
      onClick={onRefresh}
    />
  );
  return (
    <header className="browser-toolbar">
      <div>
        <div className="browser-title-row">
          <h2 tabIndex={-1} data-dialog-return-focus>
            {title}
          </h2>
          {!date && refresh}
        </div>
        {date && label && (
          <div className="browser-date-row">
            <p className="muted">
              <time dateTime={date}>
                {label.weekday}, {label.date}
              </time>
              {service ? ` · ${service}` : ""}
            </p>
            {refresh}
          </div>
        )}
      </div>
      {children && (
        <div className="app-toolbar" role="group" aria-label="Meal browser actions">
          {children}
        </div>
      )}
    </header>
  );
}
