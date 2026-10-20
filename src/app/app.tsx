import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MealAppContext, type MealAppProps } from "./lib/app-context.ts";
import { createMealQueries, createQueryClient } from "./lib/queries.ts";
import { createMealRouter } from "./router.ts";

export function MealApp(props: MealAppProps) {
  const [services] = useState(() => {
    const queryClient = createQueryClient();
    const queries = createMealQueries(props.host.callTool, props.initial);
    return {
      queryClient,
      queries,
      router: createMealRouter({ queryClient, queries, initial: props.initial }),
    };
  });
  return (
    <MealAppContext
      value={{ ...props, queryClient: services.queryClient, queries: services.queries }}
    >
      <QueryClientProvider client={services.queryClient}>
        <RouterProvider router={services.router} />
      </QueryClientProvider>
    </MealAppContext>
  );
}
