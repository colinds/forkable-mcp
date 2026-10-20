import { useEffect, useRef, type ReactNode } from "react";

/** Native dialog provides focus containment and an inert background inside any MCP Apps host. */
export function MealDialog({
  children,
  busy,
  onClose,
  returnFocus,
}: {
  children: ReactNode;
  busy: boolean;
  onClose: () => void | boolean;
  returnFocus?: HTMLElement;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const restoreAfterClose = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    dialog.querySelector<HTMLElement>("h2")?.focus();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = overflow;
      requestAnimationFrame(() => {
        if (dialog.open) return;
        const target = returnFocus?.isConnected
          ? returnFocus
          : document.querySelector<HTMLElement>("[data-dialog-return-focus]");
        target?.focus({ preventScroll: true });
      });
    };
  }, [returnFocus]);
  return (
    <dialog
      ref={ref}
      className="meal-dialog"
      aria-label="Meal details"
      aria-labelledby="meal-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((node) => node.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onClose={() => {
        const dialog = ref.current;
        if (!dialog?.isConnected || dialog.open) return;
        if (busy || restoreAfterClose.current) {
          restoreAfterClose.current = false;
          dialog.showModal();
        } else if (onClose() === false) dialog.showModal();
      }}
      onCancel={(event) => {
        restoreAfterClose.current = busy;
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}
