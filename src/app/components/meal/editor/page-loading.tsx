import { MealOptionsLoading } from "./options-loading.tsx";
import type { ReactNode } from "react";

export function MealPageLoading({ navigation }: { navigation?: ReactNode }) {
  return (
    <section className="detail" role="status" aria-label="Loading meal details" aria-busy="true">
      <div className="detail-header detail-page-header" aria-hidden={!navigation}>
        {navigation ?? <div className="skeleton skeleton-back" />}
        <div className="skeleton skeleton-title" />
      </div>
      <div className="detail-summary" aria-hidden="true">
        <div className="photo skeleton" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-control" />
      </div>
      <div className="detail-content" aria-hidden="true">
        <MealOptionsLoading />
        <div className="skeleton skeleton-control" />
      </div>
    </section>
  );
}
