import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { trackingUrl } from "@/app/lib/delivery-labels.ts";
import type { OpenLink } from "@/app/lib/tools.ts";

export function TrackingLink({ url, openLink }: { url: string | null; openLink?: OpenLink }) {
  const [failed, setFailed] = useState(false);
  const target = trackingUrl(url);
  if (!target) return null;
  return (
    <span className="tracking-action">
      <a
        className="btn btn-secondary track-order cursor-interaction"
        href={target}
        target="_blank"
        rel="noreferrer"
        onClick={async (event) => {
          if (!openLink) return;
          event.preventDefault();
          try {
            setFailed(!!(await openLink(target)).isError);
          } catch {
            setFailed(true);
          }
        }}
      >
        Track order
        <ArrowUpRight aria-hidden="true" />
      </a>
      {failed && <span role="alert">Couldn’t open tracking. Try the link again.</span>}
    </span>
  );
}
