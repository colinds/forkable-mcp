export function DateStripLoading() {
  return (
    <div className="date-strip" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="date-chip" key={index}>
          <div className="skeleton skeleton-label" />
          <div className="skeleton skeleton-back" />
          <div className="skeleton skeleton-label" />
        </div>
      ))}
    </div>
  );
}
