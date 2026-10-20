export function MealOptionsLoading() {
  return (
    <div className="options-loading" role="status" aria-label="Loading meal options">
      <div className="option-skeleton" aria-hidden="true">
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-control" />
        <div className="skeleton skeleton-control" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-control" />
      </div>
    </div>
  );
}
