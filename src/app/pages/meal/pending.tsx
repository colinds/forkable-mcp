import { useEditorContext } from "../../lib/editor-context.ts";
import { MealFrame } from "../../components/meal/editor/frame.tsx";
import { MealPageLoading } from "../../components/meal/editor/page-loading.tsx";
import { MealNavigation } from "../../components/meal/editor/navigation.tsx";

export function MealPending() {
  const { browser, inline, backLabel } = useEditorContext();
  return (
    <MealFrame>
      <MealPageLoading
        navigation={
          <MealNavigation backLabel={inline ? backLabel : undefined} onBack={browser.back} />
        }
      />
    </MealFrame>
  );
}
