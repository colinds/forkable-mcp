import { MealCardLoading } from "./card-loading.tsx";

export function MealCardsLoading() {
  return (
    <section className="meal-results" role="status" aria-label="Loading meals" aria-busy="true">
      <div className="meals" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <MealCardLoading key={index} />
        ))}
      </div>
    </section>
  );
}
