import { MealOptionsLoading } from "./options-loading.tsx";
import type { ReactNode } from "react";
import type { Delivery } from "@/shared/contracts/meals.ts";
import type { MealPreview } from "../../../lib/editor-types.ts";
import { MealSummary } from "./summary.tsx";

export function MealPageLoading({
  navigation,
  inline = true,
  meal,
  delivery,
}: {
  navigation?: ReactNode;
  inline?: boolean;
  meal?: MealPreview;
  delivery?: Delivery;
}) {
  return (
    <section className="detail" role="status" aria-label="Loading meal details" aria-busy="true">
      <div
        className={`detail-header${inline ? " detail-page-header" : ""}`}
        aria-hidden={!navigation}
      >
        {inline && (navigation ?? <div className="skeleton skeleton-back" />)}
        {meal ? <h2>{meal.name}</h2> : <div className="skeleton skeleton-title" />}
        {!inline && navigation}
      </div>
      {meal ? (
        <MealSummary meal={meal} delivery={delivery} />
      ) : (
        <div className="detail-summary" aria-hidden="true">
          <div className="photo skeleton" />
          <div className="skeleton skeleton-label" />
          <div className="skeleton skeleton-label" />
          <div className="skeleton skeleton-label" />
        </div>
      )}
      <div className="detail-content" aria-hidden="true">
        <MealOptionsLoading />
        <div className="skeleton skeleton-control" />
      </div>
    </section>
  );
}
