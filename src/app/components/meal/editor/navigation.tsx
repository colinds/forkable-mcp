import { ArrowLeft, X } from "lucide-react";
import { IconButton } from "../../icon-button.tsx";
import { Button } from "../../button.tsx";

export function MealNavigation({
  backLabel,
  disabled,
  onBack,
}: {
  backLabel?: string;
  disabled?: boolean;
  onBack: () => void | boolean;
}) {
  return backLabel ? (
    <Button className="detail-back" disabled={disabled} onClick={onBack}>
      <ArrowLeft size={18} aria-hidden="true" />
      {backLabel}
    </Button>
  ) : (
    <IconButton icon={X} label="Close" disabled={disabled} onClick={onBack} />
  );
}
