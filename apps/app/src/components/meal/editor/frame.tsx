import type { ReactNode } from "react";
import { useEditorContext } from "@/app/lib/editor-context.ts";
import { MealInlineFrame } from "./inline-frame.tsx";
import { Dialog } from "@/app/components/dialog.tsx";

export function MealFrame({ children, locked = false }: { children: ReactNode; locked?: boolean }) {
  const { browser, inline, opener } = useEditorContext();
  return inline ? (
    <MealInlineFrame returnFocus={opener}>{children}</MealInlineFrame>
  ) : (
    <Dialog
      className="meal-dialog"
      label="Meal details"
      labelledBy="meal-title"
      busy={locked}
      onClose={browser.back}
      returnFocus={opener}
    >
      {children}
    </Dialog>
  );
}
