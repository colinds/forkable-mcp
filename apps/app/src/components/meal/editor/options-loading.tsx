export function MealOptionsLoading() {
  return (
    <div
      className="detail-content"
      role="status"
      aria-label="Loading meal options"
      aria-busy="true"
    >
      <div className="option-skeleton" aria-hidden="true">
        <div className="skeleton skeleton-label" />
        {Array.from({ length: 3 }, (_, index) => (
          <div className="option" key={index}>
            <div className="skeleton skeleton-checkbox" />
            <div className="skeleton skeleton-label" />
          </div>
        ))}
      </div>
      <div className="skeleton skeleton-control" aria-hidden="true" />
    </div>
  );
}
