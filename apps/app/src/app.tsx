import { deepLinkInput } from "@/app/lib/deep-links.ts";
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MealAppContext, type MealAppProps } from "@/app/lib/app-context.ts";
import { createMealQueries, createQueryClient } from "@/app/lib/queries.ts";
import { createMealRouter } from "./router.ts";

export function MealApp(props: MealAppProps) {
  const [services] = useState(() => {
    let initial = props.initial;
    let initialLinkError: string | undefined;
    if (props.deepLink && props.deepLink.url !== "/") {
      try {
        initial = { input: deepLinkInput(props.deepLink.url), result: { content: [] } };
      } catch {
        initialLinkError = "This Forkable link could not be opened.";
      }
    }
    const queryClient = createQueryClient();
    const queries = createMealQueries(props.host.callTool, initial);
    return {
      queryClient,
      queries,
      initialLinkRevision: props.deepLink?.revision,
      initialLinkError,
      router: createMealRouter({ queryClient, queries, initial }),
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
