import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MealAppContext, type MealAppProps } from "@/app/lib/app-context.ts";
import { createMealQueries, createQueryClient } from "@/app/lib/queries.ts";
import { createMealRouter } from "./router.ts";

export function MealApp(props: MealAppProps) {
  const [services] = useState(() => {
    const initial = props.deepLink && props.deepLink.url !== "/" ? undefined : props.initial;
    const queryClient = createQueryClient();
    const queries = createMealQueries(props.host.callTool, initial);
    const context = { queryClient, queries, initial };
    let router;
    let initialLinkError: string | undefined;
    try {
      router = createMealRouter({ ...context, deepLink: props.deepLink?.url });
    } catch {
      initialLinkError = "This Forkable link could not be opened.";
      router = createMealRouter(context);
    }
    return {
      queryClient,
      queries,
      initialLinkRevision: props.deepLink?.revision,
      initialLinkError,
      router,
    };
  });
  return (
    <MealAppContext
      value={{
        ...props,
        queryClient: services.queryClient,
        queries: services.queries,
        initialLinkRevision: services.initialLinkRevision,
        initialLinkError: services.initialLinkError,
      }}
    >
      <QueryClientProvider client={services.queryClient}>
        <RouterProvider router={services.router} />
      </QueryClientProvider>
    </MealAppContext>
  );
}
