import { useEditorContext } from "@/app/lib/editor-context.ts";
import { Link } from "lucide-react";
import { useState } from "react";
import { useMealApp } from "@/app/lib/app-context.ts";
import { useViewLink } from "@/app/hooks/use-view-link.ts";

export function ViewLink() {
  const { browser } = useEditorContext();
  const href = useViewLink(browser.state);
  const { openLink } = useMealApp();
  const [failed, setFailed] = useState(false);
  if (!href) return null;
  return (
    <>
      <a
        className="btn btn-secondary icon-button cursor-interaction"
        href={href}
        aria-label="Link to this view"
        title="Link to this view"
        target="_blank"
        rel="noreferrer"
        onClick={async (event) => {
          if (!openLink) return;
          event.preventDefault();
          try {
            setFailed(!!(await openLink(href)).isError);
          } catch {
            setFailed(true);
          }
        }}
      >
        <Link size={18} aria-hidden="true" />
      </a>
      {failed && (
        <span role="alert" className="muted">
          Could not open the view link. You can copy its link address instead.
        </span>
      )}
    </>
  );
}
