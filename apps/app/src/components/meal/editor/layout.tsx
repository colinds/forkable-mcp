import type { ReactNode } from "react";

export function MealDetailLayout({
  title,
  navigation,
  inline = true,
  loading = false,
  children,
}: {
  title: ReactNode;
  navigation?: ReactNode;
  inline?: boolean;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className="detail"
      role={loading ? "status" : "region"}
      aria-label={loading ? "Loading meal details" : "Meal details"}
      aria-busy={loading || undefined}
    >
      <header className={`detail-header${inline ? " detail-page-header" : ""}`}>
        {inline && navigation}
        <h2 id="meal-title" tabIndex={-1}>
          {title}
        </h2>
        {!inline && navigation}
      </header>
      {children}
    </section>
  );
}
