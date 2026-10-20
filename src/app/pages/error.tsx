import { useMutation } from "@tanstack/react-query";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { useMealApp } from "../lib/app-context.ts";
import { BrowserToolbar } from "../components/browser-toolbar.tsx";

export function MealLoadError({ error }: ErrorComponentProps) {
  const { queryClient, queries } = useMealApp();
  const router = useRouter();
  const retry = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ refetchType: "none" });
      await queryClient.fetchQuery(queries.deliveries());
      await queryClient.refetchQueries(
        { predicate: (query) => query.state.status === "error" },
        { throwOnError: true },
      );
      await router.invalidate();
    },
  });
  const failure = retry.error ?? error;
  return (
    <>
      <BrowserToolbar
        title="Unable to load"
        busy={retry.isPending}
        onRefresh={() => retry.mutate()}
      />
      <p className="notice error" role="alert">
        {failure instanceof Error
          ? failure.message
          : "Unable to load Forkable. Refresh to try again."}
      </p>
    </>
  );
}
