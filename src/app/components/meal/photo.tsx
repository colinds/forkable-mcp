import { useState } from "react";
import { imageUrl } from "../../lib/model.ts";
export function MealPhoto({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = imageUrl(url);
  return (
    <div className="photo">
      {src && !failed ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{failed ? "Photo unavailable" : "No photo available"}</span>
      )}
    </div>
  );
}
