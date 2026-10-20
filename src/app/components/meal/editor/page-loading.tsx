import { MealOptionsLoading } from "./options-loading.tsx";
import type { ReactNode } from "react";

export function MealPageLoading({
  navigation,
  inline = true,
}: {
  navigation?: ReactNode;
  inline?: boolean;
}) {
  return (
    <section className="detail" role="status" aria-label="Loading meal details" aria-busy="true">
      <div
        className={`detail-header${inline ? " detail-page-header" : ""}`}
        aria-hidden={!navigation}
      >
        {inline && (navigation ?? <div className="skeleton skeleton-back" />)}
        <div className="skeleton skeleton-title" />
        {!inline && navigation}
      </div>
      <div className="detail-summary" aria-hidden="true">
        <div className="photo skeleton" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-label" />
      </div>
      <div className="detail-content" aria-hidden="true">
        <MealOptionsLoading />
        <div className="skeleton skeleton-control" />
      </div>
    </section>
  );
}
