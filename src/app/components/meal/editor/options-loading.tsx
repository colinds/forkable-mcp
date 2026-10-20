export function MealOptionsLoading() {
  return (
    <div className="options-loading" role="status" aria-label="Loading meal options">
      <div className="option-skeleton" aria-hidden="true">
        <div className="skeleton skeleton-label" />
        {Array.from({ length: 3 }, (_, index) => (
          <div className="option" key={index}>
            <div className="skeleton skeleton-checkbox" />
            <div className="skeleton skeleton-label" />
          </div>
        ))}
      </div>
    </div>
  );
}
