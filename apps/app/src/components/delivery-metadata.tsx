import { CalendarDays, MapPin, Utensils } from "lucide-react";
import { dateLabels, serviceLabel } from "@/app/lib/delivery-labels.ts";
import { MetadataItem } from "./metadata-item.tsx";

export function DeliveryMetadata({
  date,
  service,
  club,
}: {
  date?: string;
  service?: string | null;
  club?: string | null;
}) {
  if (!date && !service && !club) return null;
  const label = date ? dateLabels(date) : undefined;
  return (
    <div className="metadata-list muted">
      {date && label && (
        <MetadataItem icon={CalendarDays}>
          <time dateTime={date}>
            {label.weekday}, {label.date}
          </time>
        </MetadataItem>
      )}
      {service && <MetadataItem icon={Utensils}>{serviceLabel(service)}</MetadataItem>}
      {club && <MetadataItem icon={MapPin}>{club}</MetadataItem>}
    </div>
  );
}
