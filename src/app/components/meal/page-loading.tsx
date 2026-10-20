import { MealOptionsLoading } from "./loading.tsx";

export function MealPageLoading() {
  return (
    <section className="detail" role="status" aria-label="Loading meal details" aria-busy="true">
      <div className="detail-header detail-page-header" aria-hidden="true">
        <div className="skeleton skeleton-back" />
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
