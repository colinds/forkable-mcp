import { useEffect, useEffectEvent } from "react";

export function useOnReturn(onReturn: () => void): void {
  const notify = useEffectEvent(onReturn);

  useEffect(() => {
    let away = false;
    const leave = () => {
      away = true;
    };
    const enter = () => {
      if (document.visibilityState === "hidden" || !away) return;
      away = false;
      notify();
    };
    const visibility = () => (document.visibilityState === "hidden" ? leave() : enter());

    window.addEventListener("blur", leave);
    window.addEventListener("focus", enter);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", enter);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
}
