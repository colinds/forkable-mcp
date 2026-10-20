export function MealCardLoading({ horizontal = false }: { horizontal?: boolean }) {
  return (
    <div className={`meal-card${horizontal ? " meal-card-horizontal" : ""}`} aria-hidden="true">
      <div className="photo skeleton" />
      <div className="card-body">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-label" />
        <div className="skeleton skeleton-label" />
      </div>
    </div>
  );
}
