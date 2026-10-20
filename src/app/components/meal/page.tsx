import { useEffect, useRef, type ReactNode } from "react";

export function MealPage({
  children,
  returnFocus,
}: {
  children: ReactNode;
  returnFocus?: HTMLElement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = ref.current;
    page?.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      requestAnimationFrame(() => {
        if (page?.isConnected || document.querySelector(".meal-dialog[open], .meal-page")) return;
        const target = returnFocus?.isConnected
          ? returnFocus
          : document.querySelector<HTMLElement>("[data-dialog-return-focus]");
        target?.focus();
      });
    };
  }, [returnFocus]);
  return (
    <div ref={ref} className="meal-page">
      {children}
    </div>
  );
}
