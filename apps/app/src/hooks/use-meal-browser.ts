import { useEffect, useRef, useEffectEvent } from "react";
import { useMutation, useQuery, useSuspenseQuery, skipToken } from "@tanstack/react-query";
import { useRouter, useParams, useRouterState, useSearch } from "@tanstack/react-router";
import type { createMealReference } from "@forkable-mcp/shared/meal-reference.ts";
import type { BrowserView } from "@forkable-mcp/shared/contracts/browser.ts";
import type {
  Delivery,
  Detail,
  Menu,
  Recommendation,
  SearchMatch,
  DeliveryStatus,
} from "@forkable-mcp/shared/contracts/meals.ts";
import {
  Confirmation,
  writeResult,
  resultText,
  selectionArgs,
  type CallTool,
  type MealWrite,
} from "@/app/lib/tools.ts";
import { initialLaunch, isPastDelivery } from "@/app/lib/initial-view.ts";
import { defaultFilters, type MenuFilters } from "@/app/lib/menu-filters.ts";
import type { WriteDraft } from "@/app/lib/chat-draft.ts";
import { useMealApp } from "@/app/lib/app-context.ts";
import { MEAL_PATH } from "@/app/lib/navigation.ts";
import { useOnReturn } from "./use-on-return.ts";

import type { MealDraftValues, MealPreview } from "@/app/lib/editor-types.ts";

type MealSubmission =
  | { kind: "set"; delivery: Delivery; detail: Detail; draft: MealDraftValues }
  | { kind: "remove"; deliveryId: number; pieceId: string | number };

type PendingAction = "loading" | "saving" | "drafting";
interface BrowserState {
  deliveries: Delivery[];
  deliveriesLoaded: boolean;
  delivery?: Delivery;
  menus: Menu[];
  mealsLoading: boolean;
  recommendations: Recommendation[];
  detail?: Detail;
  selectedMeal?: MealPreview;
  deliveryStatus?: DeliveryStatus;
  statusUnavailable: boolean;
  statusLoading: boolean;
  recommendationsLoading: boolean;
  recommendationsUnavailable: boolean;
  query: string;
  filters: MenuFilters;
  searchMatches?: SearchMatch[];
  searchFromServer: boolean;
  pendingAction?: PendingAction;
  notice: string;
  problem: boolean;
  needsRefresh: boolean;
}
export interface MealBrowserHost {
  callTool: CallTool;
  createDraft?: WriteDraft;
}

export interface MealBrowserController {
  launch: ReturnType<typeof initialLaunch>;
  view: BrowserView;
  editing: boolean;
  state: BrowserState & { busy: boolean };
  refresh: () => void;
  setView: (view: BrowserView) => void;
  browse: () => void;
  choose: (menuId: number, itemId: number, sourcePieceId?: string | number) => void;
  prefetchMeal: (menuId: number, itemId: number) => Promise<void>;
  submit: (draft: MealDraftValues) => void;
  skipMeal: (pieceId: string | number) => Promise<boolean>;
  askAboutMeal?: (reference: ReturnType<typeof createMealReference>) => void;
  back: () => boolean;
  clearFeedback: () => void;
  setFilters: (filters: MenuFilters) => void;
  setQuery: (query: string) => void;
  setDelivery: (id: number) => void;
}

export type { MealEditorController } from "./use-meal-editor.ts";
const noMenus: Menu[] = [];
const noRecommendations: Recommendation[] = [];

export function useMealBrowser(): MealBrowserController {
  const {
    host: { callTool: call, createDraft: writeDraft },
    queries,
    queryClient,
  } = useMealApp();
  const router = useRouter();
  const navigation = useSearch({ from: "__root__" });
  const inMealRoute = useRouterState({ select: (state) => state.location.pathname !== "/" });
  const params = useParams({ from: MEAL_PATH, shouldThrow: false });
  const target = inMealRoute ? params : undefined;
  const { launch, seed } = queries;
  const returnRefreshPending = useRef(false);

  const refreshMutation = useMutation({
    mutationFn: refreshBrowser,
    onSuccess: () => {
      writeMutation.reset();
      draftMutation.reset();
      returnToBrowser();
    },
  });
  const deliveriesQuery = useSuspenseQuery(queries.deliveries());
  const deliveries = deliveriesQuery.data;
  const wanted = target?.deliveryId ?? navigation.deliveryId ?? seed.status?.deliveryId;
  const delivery =
    wanted == null ? deliveries[0] : deliveries.find((item) => item.deliveryId === wanted);
  const menusQuery = useQuery(
    delivery ? queries.menus(delivery) : { queryKey: ["menus"], queryFn: skipToken },
  );
  const recommendationsQuery = useQuery(
    delivery
      ? queries.recommendations(delivery, launch.limit)
      : { queryKey: ["recommendations"], queryFn: skipToken },
  );
  const statusQuery = useQuery(
    delivery ? queries.status(delivery) : { queryKey: ["status"], queryFn: skipToken },
  );
  const detailQuery = useQuery(
    target && delivery && !isPastDelivery(delivery.date)
      ? queries.detail(target)
      : { queryKey: ["meal"], queryFn: skipToken },
  );
  const serverSearch = navigation.serverSearch === true;
  const searchQuery = useQuery(
    serverSearch && delivery
      ? queries.search(delivery.deliveryId, navigation.query ?? "")
      : { queryKey: ["search"], queryFn: skipToken },
  );
  const menus = menusQuery.data ?? noMenus;
  const detail = target ? detailQuery.data : undefined;
  const listedItem = target
    ? menus
        .find((menu) => menu.menuId === target.menuId)
        ?.items.find((item) => item.itemId === target.itemId)
    : undefined;
  const preview: MealPreview | undefined = target
    ? (detail ??
      (listedItem
        ? {
            menuId: target.menuId,
            itemId: target.itemId,
            name: listedItem.name,
            imageUrl: listedItem.imageUrl,
            price: listedItem.price,
            description: listedItem.description ?? null,
          }
        : undefined))
    : undefined;
  const selectedMeal: MealPreview | undefined = preview
    ? { ...preview, ingredients: listedItem?.ingredients ?? preview.ingredients }
    : undefined;
  const writeMutation = useMutation({
    mutationFn: async (submission: MealSubmission) => {
      const change: MealWrite =
        submission.kind === "set"
          ? {
              tool: "set_meal",
              args: selectionArgs(
                submission.delivery,
                submission.detail,
                submission.draft.source,
                submission.draft.choices,
                submission.draft.instructions,
              ),
            }
          : {
              tool: "remove_meal",
              args: { deliveryId: submission.deliveryId, pieceId: submission.pieceId },
            };
      const confirmation = new Confirmation();
      const preview = await confirmation.preview(call, change);
      if (!confirmation.pending)
        return {
          notice:
            resultText(preview) ||
            "Unable to update this meal. Check your selection and try again.",
          problem: true,
          needsRefresh: false,
        };
      let sent = false;
      try {
        const result = await confirmation.confirm((name, input) => {
          sent = true;
          return call(name, input);
        });
        const outcome = writeResult(result);
        if (outcome?.mode !== "executed")
          return {
            notice:
              resultText(result) || "The change was not confirmed. Refresh before trying again.",
            problem: true,
            needsRefresh: !outcome || outcome.mode === "outcome_unknown",
          };
        try {
          await refreshBrowser();
          returnToBrowser();
          return {
            notice:
              change.tool === "remove_meal"
                ? "Skip requested. Delivery refreshed."
                : "Change sent. Delivery refreshed.",
            problem: false,
            needsRefresh: false,
          };
        } catch {
          returnToBrowser();
          return {
            notice:
              "Change sent, but delivery refresh failed. Refresh to check its current state; do not submit again.",
            problem: true,
            needsRefresh: true,
          };
        }
      } catch (error) {
        if (!sent) throw error;
        return {
          notice:
            "Confirmation could not be verified. Its outcome may be unknown. Refresh the delivery before trying again.",
          problem: true,
          needsRefresh: true,
        };
      }
    },
  });
  const draftMutation = useMutation({
    mutationFn: async (reference: ReturnType<typeof createMealReference>) => {
      if (!writeDraft) throw new Error("Chat drafts are unavailable in this host.");
      await writeDraft(reference);
    },
  });
  const needsRefresh = writeMutation.data?.needsRefresh ?? false;
  const changing = writeMutation.isPending || refreshMutation.isPending || draftMutation.isPending;
  const menuLoading = !!delivery && menusQuery.isPending;
  const detailLoading =
    !!target && !!delivery && !isPastDelivery(delivery.date) && !detail && detailQuery.isPending;
  let pendingAction: PendingAction | undefined;
  if (writeMutation.isPending) pendingAction = "saving";
  else if (draftMutation.isPending) pendingAction = "drafting";
  else if (refreshMutation.isPending || deliveriesQuery.isLoading || menuLoading || detailLoading)
    pendingAction = "loading";
  const busy = pendingAction !== undefined;
  const readError = target
    ? (detailQuery.error ?? menusQuery.error ?? deliveriesQuery.error)
    : (searchQuery.error ?? menusQuery.error ?? deliveriesQuery.error);
  const missingDelivery = deliveriesQuery.isSuccess && wanted != null && !delivery;
  const error = writeMutation.error ?? draftMutation.error ?? refreshMutation.error ?? readError;
  const fallbackNotice = missingDelivery
    ? "This delivery is not in the requested date range. Refresh to see current deliveries."
    : "";
  const notice =
    writeMutation.data?.notice ??
    error?.message ??
    (draftMutation.isSuccess
      ? "Added to your draft. Edit it in chat, then send when ready."
      : fallbackNotice);

  function returnToBrowser() {
    void router.navigate({
      to: "/",
      search: (previous) => ({ ...previous, sourcePieceId: undefined }),
      replace: true,
      resetScroll: false,
    });
  }
  async function refreshBrowser() {
    await queryClient.cancelQueries();
    await queryClient.invalidateQueries({ refetchType: "none" });
    const listed = await queryClient.fetchQuery(queries.deliveries());
    const selected = listed.find((item) => item.deliveryId === delivery?.deliveryId) ?? listed[0];
    if (selected && serverSearch)
      await queryClient.fetchQuery(queries.search(selected.deliveryId, navigation.query ?? ""));
    if (selected) {
      await queryClient.fetchQuery(queries.menus(selected));
      void queryClient.fetchQuery(queries.status(selected)).catch(() => {});
      void queryClient.fetchQuery(queries.recommendations(selected, launch.limit)).catch(() => {});
    }
    if (selected?.deliveryId !== navigation.deliveryId)
      await router.navigate({
        to: "/",
        search: (previous) => ({
          ...previous,
          deliveryId: selected?.deliveryId,
          sourcePieceId: undefined,
        }),
        replace: true,
      });
  }
  const canRefreshOnReturn =
    deliveriesQuery.isSuccess && !busy && !inMealRoute && !statusQuery.isPending && !needsRefresh;
  function refreshOnReturn() {
    returnRefreshPending.current = true;
    if (!canRefreshOnReturn) return;
    returnRefreshPending.current = false;
    void queryClient.invalidateQueries(
      {
        predicate: (query) => query.queryKey[0] === "deliveries" || query.queryKey[0] === "status",
      },
      { cancelRefetch: false },
    );
  }
  const refreshWhenIdle = useEffectEvent(refreshOnReturn);
  useOnReturn(refreshOnReturn);
  useEffect(() => {
    if (canRefreshOnReturn && returnRefreshPending.current) refreshWhenIdle();
  }, [canRefreshOnReturn]);

  function clearFeedback() {
    if (!needsRefresh && !writeMutation.isIdle) writeMutation.reset();
    if (!draftMutation.isIdle) draftMutation.reset();
  }
  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    if (!delivery || isPastDelivery(delivery.date) || queryClient.isMutating() > 0) return;
    if (target?.menuId === menuId && target.itemId === itemId) {
      void detailQuery.refetch();
      return;
    }
    if (!needsRefresh) writeMutation.reset();
    draftMutation.reset();
    void router.navigate({
      to: MEAL_PATH,
      params: { deliveryId: delivery.deliveryId, menuId, itemId },
      resetScroll: false,
      search: (previous) => ({ ...previous, sourcePieceId }),
    });
  }
  return {
    launch,
    view: navigation.view ?? launch.view,
    editing: inMealRoute,
    state: {
      deliveries,
      deliveriesLoaded: true,
      delivery,
      menus,
      mealsLoading:
        menusQuery.isLoading ||
        (serverSearch && searchQuery.isLoading) ||
        ((navigation.filters ?? defaultFilters).recommendedOnly && recommendationsQuery.isLoading),
      recommendations: recommendationsQuery.data ?? noRecommendations,
      detail,
      selectedMeal,
      deliveryStatus: statusQuery.data,
      statusUnavailable: statusQuery.isError,
      statusLoading: statusQuery.isLoading,
      recommendationsLoading: recommendationsQuery.isLoading,
      recommendationsUnavailable: recommendationsQuery.isError,
      query: navigation.query ?? "",
      filters: navigation.filters ?? defaultFilters,
      searchMatches: serverSearch ? searchQuery.data : undefined,
      searchFromServer: serverSearch,
      busy,
      pendingAction,
      notice,
      problem: !!error || missingDelivery || !!writeMutation.data?.problem,
      needsRefresh,
    },
    refresh: () => {
      if (queryClient.isMutating() === 0) refreshMutation.mutate();
    },
    choose,
    prefetchMeal: async (menuId, itemId) => {
      if (!delivery || isPastDelivery(delivery.date) || queryClient.isMutating() > 0) return;
      const query = queries.detail({ deliveryId: delivery.deliveryId, menuId, itemId });
      if (queryClient.getQueryState(query.queryKey)?.status === "error") return;
      await queryClient.prefetchQuery(query);
    },
    submit: (draft) => {
      if (busy || queryClient.isMutating() > 0 || needsRefresh || !delivery || !detail) return;
      // Validation is part of the mutation so the same error state covers form and server failures.
      writeMutation.mutate({ kind: "set", delivery, detail, draft });
    },
    skipMeal: async (pieceId) => {
      if (
        busy ||
        queryClient.isMutating() > 0 ||
        needsRefresh ||
        !delivery ||
        isPastDelivery(delivery.date)
      )
        return false;
      const meal = delivery.meals.find(
        (candidate) => String(candidate.pieceId) === String(pieceId),
      );
      if (!meal || meal.cancellationPending) return false;
      try {
        const result = await writeMutation.mutateAsync({
          kind: "remove",
          deliveryId: delivery.deliveryId,
          pieceId: meal.pieceId,
        });
        return !result.problem;
      } catch {
        return false;
      }
    },
    askAboutMeal: writeDraft
      ? (reference) => {
          if (busy || queryClient.isMutating() > 0) return;
          draftMutation.mutate(reference);
        }
      : undefined,
    back: () => {
      if (queryClient.isMutating() > 0) return false;
      draftMutation.reset();
      if (!needsRefresh) writeMutation.reset();
      returnToBrowser();
      return true;
    },
    clearFeedback,
    setFilters: (filters) => {
      void router.navigate({
        to: "/",
        search: (previous) => ({ ...previous, filters }),
        replace: true,
      });
    },
    setQuery: (query) => {
      void router.navigate({
        to: "/",
        search: (previous) => ({ ...previous, query, serverSearch: false }),
        replace: true,
      });
    },
    setView: (view) => {
      void router.navigate({
        to: "/",
        search: (previous) => ({ ...previous, view }),
        replace: true,
      });
    },
    browse: () => {
      void router.navigate({
        to: "/",
        search: (previous) => ({
          ...previous,
          query: "",
          serverSearch: false,
          filters: defaultFilters,
          view: "browse",
          sourcePieceId: undefined,
        }),
      });
    },
    setDelivery: (deliveryId) => {
      if (changing) return;
      if (!needsRefresh) writeMutation.reset();
      draftMutation.reset();
      void router.navigate({
        to: "/",
        search: (previous) => ({
          ...previous,
          deliveryId,
          query: "",
          serverSearch: false,
          filters: defaultFilters,
          sourcePieceId: undefined,
        }),
      });
    },
  };
}
