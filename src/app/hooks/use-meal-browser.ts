import { selectedMealTotal } from "@/shared/meal-options.ts";
import { createMealReference } from "@/shared/meal-reference.ts";
import type { WriteDraft } from "../lib/chat-draft.ts";
import {
  initialData,
  initialLaunch,
  initialRange,
  isPastDelivery,
  type InitialView,
} from "../lib/initial-view.ts";
import { defaultFilters, type MenuFilters } from "../lib/menu-filters.ts";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useOnReturn } from "./use-on-return.ts";
import {
  Confirmation,
  writeResult,
  data,
  resultText,
  selectionArgs,
  type CallTool,
} from "../lib/tools.ts";
import {
  deliveryStatusSchema,
  type DeliveryStatus,
  deliveriesSchema,
  menusSchema,
  itemDetailSchema,
  recommendationsSchema,
  searchResultsSchema,
  type Delivery,
  type Detail,
  type Menu,
  type Recommendation,
  type SearchMatch,
} from "@/shared/contracts/meals.ts";
type PendingAction = "loading" | "saving" | "drafting";
type MealPreview = Pick<
  Detail,
  "menuId" | "itemId" | "name" | "imageUrl" | "price" | "description"
>;

interface BrowserState {
  deliveries: Delivery[];
  deliveriesLoaded: boolean;
  delivery?: Delivery;
  menus: Menu[];
  recommendations: Recommendation[];
  detail?: Detail;
  selectedMeal?: MealPreview;
  deliveryStatus?: DeliveryStatus;
  statusUnavailable: boolean;
  statusLoading: boolean;
  recommendationsLoading: boolean;
  recommendationsUnavailable: boolean;
  source: string;
  choices: Record<string, number[]>;
  instructions: string;
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
  state: BrowserState & { busy: boolean };
  mealTotal: number | undefined;
  refresh: () => void;
  choose: (menuId: number, itemId: number, sourcePieceId?: string | number) => void;
  chooseOption: (
    modifierId: number,
    optionId: number,
    checked: boolean,
    max: Detail["modifiers"][number]["max"],
  ) => void;
  submit: () => void;
  askAboutMeal?: () => void;
  back: () => void;
  setFilters: (filters: MenuFilters) => void;
  setQuery: (query: string) => void;
  setSource: (source: string) => void;
  setInstructions: (instructions: string) => void;
  setDelivery: (id: number) => void;
}

export type MealEditorController = Pick<
  MealBrowserController,
  | "mealTotal"
  | "choose"
  | "chooseOption"
  | "setSource"
  | "setInstructions"
  | "submit"
  | "back"
  | "askAboutMeal"
> & {
  state: Pick<
    MealBrowserController["state"],
    | "delivery"
    | "detail"
    | "selectedMeal"
    | "busy"
    | "pendingAction"
    | "notice"
    | "problem"
    | "source"
    | "choices"
    | "instructions"
    | "needsRefresh"
  >;
};

const emptyDeliveryData = {
  menus: [],
  recommendations: [],
  deliveryStatus: undefined,
  statusUnavailable: false,
  statusLoading: false,
  recommendationsLoading: false,
  recommendationsUnavailable: false,
} satisfies Partial<BrowserState>;

function sortDeliveries(deliveries: Delivery[]) {
  return deliveries.toSorted((a, b) => a.date.localeCompare(b.date) || a.deliveryId - b.deliveryId);
}

function savedInstructions(detail: Detail, delivery: Delivery, source: string | number) {
  const meal = delivery.meals.find((candidate) => String(candidate.pieceId) === String(source));
  return meal?.menuId === detail.menuId && meal.itemId === detail.itemId
    ? (meal.instructions ?? "")
    : "";
}

function detailSelection(detail: Detail, delivery: Delivery, sourcePieceId?: string | number) {
  const source = sourcePieceId ?? (delivery.meals.length === 1 ? delivery.meals[0]!.pieceId : "");
  return {
    detail,
    source: String(source),
    choices: {},
    instructions: savedInstructions(detail, delivery, source),
  };
}

const emptySelection = {
  detail: undefined,
  selectedMeal: undefined,
  source: "",
  choices: {},
  instructions: "",
  notice: "",
};
const initialState: BrowserState = {
  ...emptySelection,
  deliveries: [],
  deliveriesLoaded: false,
  menus: [],
  recommendations: [],
  query: "",
  filters: defaultFilters,
  searchFromServer: false,
  pendingAction: "loading",
  statusUnavailable: false,
  statusLoading: false,
  recommendationsLoading: false,
  recommendationsUnavailable: false,
  problem: false,
  needsRefresh: false,
};

export function useMealBrowser(
  { callTool: call, createDraft: writeDraft }: MealBrowserHost,
  initial?: InitialView,
): MealBrowserController {
  const [state, setState] = useState(initialState);
  const running = useRef(false);
  const [refreshRequested, setRefreshRequested] = useState(false);
  const refreshing = useRef(false);
  const detailRequest = useRef<MealPreview | undefined>(undefined);
  const loadGeneration = useRef(0);
  const [range] = useState(() => initialRange(initial));
  const [launch] = useState(() => initialLaunch(initial));
  const confirmation = useRef(new Confirmation());
  const { delivery, detail } = state;
  const patch = useCallback(
    (next: Partial<BrowserState>) => setState((current) => ({ ...current, ...next })),
    [],
  );
  const discardPendingDeliveryReads = useCallback(() => {
    ++loadGeneration.current;
  }, []);
  const invalidate = (next: Partial<BrowserState> = {}) => {
    confirmation.current.clear();
    patch({ notice: "", ...next });
  };

  const run = useCallback(
    async (task: () => Promise<void>, pendingAction: PendingAction = "loading") => {
      if (running.current) return;
      running.current = true;
      patch({ pendingAction });
      try {
        await task();
      } catch (error) {
        patch({
          notice: error instanceof Error ? error.message : "Unable to load Forkable.",
          problem: true,
        });
      } finally {
        running.current = false;
        patch({ pendingAction: undefined });
      }
    },
    [patch],
  );
  const loadMenus = useCallback(
    async (selected?: Delivery, seed?: ReturnType<typeof initialData>) => {
      const generation = ++loadGeneration.current;
      const patchCurrent = (next: Partial<BrowserState>) =>
        setState((current) =>
          generation === loadGeneration.current ? { ...current, ...next } : current,
        );
      patch({
        ...emptyDeliveryData,
        statusLoading: !!selected,
        recommendationsLoading: !!selected,
      });
      if (!selected) return;

      const args = { deliveryId: selected.deliveryId };
      const historical = isPastDelivery(selected.date);
      const menusSeed = historical ? [] : seed?.menus;
      const recommendationsSeed = historical ? [] : seed?.recommendations;

      // Auxiliary reads may finish after navigation; only the current delivery can receive them.
      void (async () => {
        try {
          const recommendations =
            recommendationsSeed ??
            data(
              await call("recommend_meals", {
                ...args,
                ...(launch.limit != null ? { limit: launch.limit } : {}),
              }),
              recommendationsSchema,
            ).recommendations;
          patchCurrent({ recommendations });
        } catch {
          patchCurrent({ recommendationsUnavailable: true });
        } finally {
          patchCurrent({ recommendationsLoading: false });
        }
      })();
      void (async () => {
        try {
          const status =
            seed?.status ??
            data(
              await call("get_delivery_status", {
                ...args,
                from: selected.date,
                to: selected.date,
              }),
              deliveryStatusSchema,
            ).status;
          patchCurrent({ deliveryStatus: status });
        } catch {
          patchCurrent({ statusUnavailable: true });
        } finally {
          patchCurrent({ statusLoading: false });
        }
      })();

      const menus = menusSeed ?? data(await call("get_menus", args), menusSchema).menus;
      patchCurrent({ menus });
    },
    [call, patch, launch.limit],
  );
  async function refresh() {
    ++loadGeneration.current;
    invalidate({
      ...emptySelection,
      deliveries: [],
      deliveriesLoaded: false,
      delivery: undefined,
      ...emptyDeliveryData,
      searchMatches: undefined,
    });
    const deliveries = sortDeliveries(
      data(await call("list_deliveries", range), deliveriesSchema).deliveries,
    );
    const selected = deliveries.find((d) => d.deliveryId === delivery?.deliveryId) ?? deliveries[0];
    patch({ deliveries, deliveriesLoaded: true, delivery: selected, needsRefresh: false });
    if (selected && state.query.trim() && state.searchFromServer) {
      const { items } = data(
        await call("search_items", { deliveryId: selected.deliveryId, query: state.query }),
        searchResultsSchema,
      );
      patch({ searchMatches: items });
    }
    await loadMenus(selected);
  }

  const refreshDeliverySummary = useEffectEvent(async () => {
    const generation = loadGeneration.current;
    try {
      const deliveries = sortDeliveries(
        data(await call("list_deliveries", range), deliveriesSchema).deliveries,
      );
      const selected = deliveries.find((item) => item.deliveryId === delivery?.deliveryId);
      const status = selected
        ? data(
            await call("get_delivery_status", {
              deliveryId: selected.deliveryId,
              from: selected.date,
              to: selected.date,
            }),
            deliveryStatusSchema,
          ).status
        : undefined;
      setState((current) =>
        generation !== loadGeneration.current ||
        current.pendingAction ||
        current.detail ||
        current.selectedMeal
          ? current
          : {
              ...current,
              deliveries,
              delivery: selected,
              ...(selected
                ? { deliveryStatus: status, statusUnavailable: false }
                : emptyDeliveryData),
            },
      );
    } catch {
      // Keep the last usable view. The refresh control remains available for an explicit retry.
    }
  });
  useOnReturn(() => setRefreshRequested(true));
  const canRefresh =
    state.deliveriesLoaded &&
    !state.pendingAction &&
    !state.statusLoading &&
    !state.detail &&
    !state.selectedMeal &&
    !state.needsRefresh;

  useEffect(() => {
    if (!refreshRequested || !canRefresh || refreshing.current) return;
    refreshing.current = true;
    void refreshDeliverySummary().finally(() => {
      refreshing.current = false;
      setRefreshRequested(false);
    });
  }, [refreshRequested, canRefresh]);
  // The originating tool result seeds the app instead of fetching the same data again.
  useEffect(() => {
    let cancelled = false;
    running.current = true;
    void (async () => {
      try {
        if (initial?.result.isError)
          throw new Error(resultText(initial.result) || "Forkable could not load this view.");
        const seed = initialData(initial);
        const input = initial?.input ?? {};
        const listed =
          seed.deliveries ??
          data(await call("list_deliveries", range), deliveriesSchema).deliveries;
        if (cancelled) return;
        const deliveries = sortDeliveries(listed);
        const wanted = input.deliveryId ?? seed.status?.deliveryId;
        const selected =
          wanted == null ? deliveries[0] : deliveries.find((d) => d.deliveryId === wanted);
        if (wanted != null && !selected)
          throw new Error(
            "This delivery is not in the requested date range. Refresh to see current deliveries.",
          );
        patch({
          deliveries,
          deliveriesLoaded: true,
          delivery: selected,
          query: input.query ?? "",
          filters: launch.filters,
          searchMatches: seed.searchItems,
          searchFromServer: seed.searchItems !== undefined,
        });
        await loadMenus(selected, seed);
        if (cancelled) return;
        if (selected && !isPastDelivery(selected.date)) {
          let item = seed.item;
          if (!item && input.itemId != null) {
            if (input.menuId == null)
              throw new Error("A menu ID is required to show an exact meal.");
            item = data(
              await call("get_menus", {
                deliveryId: selected.deliveryId,
                menuId: input.menuId,
                itemId: input.itemId,
              }),
              itemDetailSchema,
            ).item;
          }
          if (cancelled) return;
          if (item) patch(detailSelection(item, selected));
        }
      } catch (error) {
        if (!cancelled)
          patch({
            notice: error instanceof Error ? error.message : "Unable to load Forkable.",
            problem: true,
          });
      } finally {
        if (!cancelled) {
          running.current = false;
          patch({ pendingAction: undefined });
        }
      }
    })();
    return () => {
      cancelled = true;
      detailRequest.current = undefined;
      discardPendingDeliveryReads();
    };
  }, [call, initial, range, loadMenus, patch, discardPendingDeliveryReads, launch.filters]);

  async function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    if (!delivery || isPastDelivery(delivery.date) || running.current || detailRequest.current)
      return;
    const listed = state.menus
      .find((menu) => menu.menuId === menuId)
      ?.items.find((meal) => meal.itemId === itemId);
    const selected = delivery.meals.find(
      (meal) => meal.menuId === menuId && meal.itemId === itemId,
    );
    const preview: MealPreview = {
      menuId,
      itemId,
      name: listed?.name ?? selected?.name ?? "Meal details",
      price: listed?.price ?? null,
      imageUrl: listed?.imageUrl ?? null,
      description: listed?.description ?? null,
    };
    detailRequest.current = preview;
    invalidate({
      ...emptySelection,
      selectedMeal: preview,
      source: sourcePieceId == null ? "" : String(sourcePieceId),
      pendingAction: "loading",
      problem: false,
    });
    try {
      const loaded = data(
        await call("get_menus", { deliveryId: delivery.deliveryId, menuId, itemId }),
        itemDetailSchema,
      ).item;
      if (detailRequest.current === preview)
        patch(detailSelection(loaded, delivery, sourcePieceId));
    } catch (error) {
      if (detailRequest.current === preview)
        patch({
          notice: error instanceof Error ? error.message : "Unable to load meal options.",
          problem: true,
        });
    } finally {
      if (detailRequest.current === preview) {
        detailRequest.current = undefined;
        patch({ pendingAction: undefined });
      }
    }
  }
  function chooseOption(
    modifierId: number,
    optionId: number,
    checked: boolean,
    max: Detail["modifiers"][number]["max"],
  ) {
    const picked = state.choices[modifierId] ?? [];
    let options = picked.filter((id) => id !== optionId);
    if (checked) options = max === 1 ? [optionId] : [...picked, optionId];
    invalidate({ choices: { ...state.choices, [modifierId]: options } });
  }
  async function askAboutMeal() {
    if (!writeDraft || !delivery || !detail) return;
    patch({ notice: "", problem: false });
    await writeDraft(
      createMealReference({
        delivery,
        detail,
        restaurant: state.menus.find((menu) => menu.menuId === detail.menuId)?.name,
        choices: state.choices,
        instructions: state.instructions,
        source: state.source,
      }),
    );
    patch({
      notice: "Added to your draft. Edit it in chat, then send when ready.",
      problem: false,
    });
  }

  async function submit() {
    invalidate();
    if (!delivery || !detail) throw new Error("Choose a delivery and meal first.");
    const args = selectionArgs(delivery, detail, state.source, state.choices, state.instructions);
    const result = await confirmation.current.preview(call, args);
    if (!confirmation.current.pending) {
      patch({
        notice:
          resultText(result) || "Unable to save this meal. Check your selection and try again.",
        problem: true,
      });
      return;
    }
    await confirm();
  }
  async function confirm() {
    let sent = false;
    try {
      const result = await confirmation.current.confirm((name, args) => {
        sent = true;
        ++loadGeneration.current;
        patch({ statusLoading: false, recommendationsLoading: false });
        return call(name, args);
      });
      const outcome = writeResult(result);
      if (outcome?.mode === "executed") {
        try {
          await refresh();
          patch({ notice: "Change sent. Delivery refreshed.", problem: false });
        } catch {
          patch({
            ...emptySelection,
            menus: [],
            needsRefresh: true,
            notice:
              "Change sent, but delivery refresh failed. Refresh to check its current state; do not submit again.",
            problem: true,
          });
        }
      } else
        patch({
          needsRefresh: !outcome || outcome.mode === "outcome_unknown",
          notice:
            resultText(result) || "The change was not confirmed. Refresh before trying again.",
          problem: true,
        });
    } catch (error) {
      patch({ needsRefresh: sent || state.needsRefresh });
      if (!sent) throw error;
      throw new Error(
        "Confirmation could not be verified. Its outcome may be unknown. Refresh the delivery before trying again.",
        { cause: error },
      );
    }
  }
  return {
    launch,
    state: { ...state, busy: state.pendingAction !== undefined },
    mealTotal: detail ? selectedMealTotal(detail, state.choices) : undefined,
    refresh: () => void run(refresh),
    choose,
    chooseOption,
    askAboutMeal: writeDraft ? () => void run(askAboutMeal, "drafting") : undefined,
    submit: () => {
      if (!state.needsRefresh) void run(submit, "saving");
    },
    back: () => {
      detailRequest.current = undefined;
      invalidate({ ...emptySelection, pendingAction: undefined });
    },
    setFilters: (filters: MenuFilters) => patch({ filters }),
    setQuery: (query: string) =>
      patch({ query, searchMatches: undefined, searchFromServer: false }),
    setSource: (source: string) => {
      let instructions = state.instructions;
      if (detail && delivery && instructions === savedInstructions(detail, delivery, state.source))
        instructions = savedInstructions(detail, delivery, source);
      invalidate({ source, instructions });
    },
    setInstructions: (instructions: string) => invalidate({ instructions }),
    setDelivery: (id: number) =>
      void run(async () => {
        const selected = state.deliveries.find((d) => d.deliveryId === id);
        invalidate({
          ...emptySelection,
          delivery: selected,
          query: "",
          searchMatches: undefined,
          searchFromServer: false,
          filters: defaultFilters,
        });
        await loadMenus(selected);
      }),
  };
}
