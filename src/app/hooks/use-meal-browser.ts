import {
  initialData,
  initialRange,
  isPastDelivery,
  type InitialView,
} from "../lib/initial-view.ts";
import { defaultFilters, type MenuFilters } from "../lib/menu-filters.ts";
import { useEffect, useRef, useState } from "react";
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
import { type WriteResult } from "@/shared/contracts/writes.ts";
interface BrowserState {
  deliveries: Delivery[];
  deliveriesLoaded: boolean;
  delivery?: Delivery;
  menus: Menu[];
  recommendations: Recommendation[];
  detail?: Detail;
  deliveryStatus?: DeliveryStatus;
  statusUnavailable: boolean;
  statusLoading: boolean;
  recommendationsLoading: boolean;
  recommendationsUnavailable: boolean;
  source: string;
  choices: Record<string, number[]>;
  query: string;
  filters: MenuFilters;
  searchMatches?: SearchMatch[];
  searchFromServer: boolean;
  busy: boolean;
  notice: string;
  problem: boolean;
  preview?: WriteResult;
  needsRefresh: boolean;
}
const emptySelection = {
  detail: undefined,
  source: "",
  choices: {},
  preview: undefined,
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
  busy: true,
  statusUnavailable: false,
  statusLoading: false,
  recommendationsLoading: false,
  recommendationsUnavailable: false,
  problem: false,
  needsRefresh: false,
};

export function useMealBrowser(call: CallTool, initial?: InitialView) {
  const [state, setState] = useState(initialState);
  const running = useRef(false);
  const loadGeneration = useRef(0);
  const [range] = useState(() => initialRange(initial));
  const confirmation = useRef(new Confirmation());
  const { delivery, detail } = state;
  const patch = (next: Partial<BrowserState>) => setState((current) => ({ ...current, ...next }));
  const invalidate = (next: Partial<BrowserState> = {}) => {
    confirmation.current.clear();
    patch({ preview: undefined, notice: "", ...next });
  };

  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    patch({ busy: true });
    try {
      await task();
    } catch (error) {
      patch({
        notice: error instanceof Error ? error.message : "Unable to load Forkable.",
        problem: true,
      });
    } finally {
      running.current = false;
      patch({ busy: false });
    }
  }
  async function loadMenus(selected?: Delivery, seed?: ReturnType<typeof initialData>) {
    const generation = ++loadGeneration.current;
    const patchCurrent = (next: Partial<BrowserState>) =>
      setState((current) =>
        generation === loadGeneration.current ? { ...current, ...next } : current,
      );
    patch({
      menus: [],
      recommendations: [],
      deliveryStatus: undefined,
      statusUnavailable: false,
      statusLoading: !!selected,
      recommendationsLoading: !!selected,
      recommendationsUnavailable: false,
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
          data(await call("recommend_meals", args), recommendationsSchema).recommendations;
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
            await call("get_delivery_status", { ...args, from: selected.date, to: selected.date }),
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
  }
  async function refresh(preserveSearch = false) {
    ++loadGeneration.current;
    invalidate({
      ...emptySelection,
      deliveries: [],
      deliveriesLoaded: false,
      delivery: undefined,
      menus: [],
      recommendations: [],
      query: preserveSearch ? state.query : "",
      searchMatches: undefined,
      searchFromServer: preserveSearch && state.searchFromServer,
      filters: preserveSearch ? state.filters : defaultFilters,
    });
    const deliveries = data(
      await call("list_deliveries", range),
      deliveriesSchema,
    ).deliveries.toSorted((a, b) => a.date.localeCompare(b.date) || a.deliveryId - b.deliveryId);
    const selected = deliveries.find((d) => d.deliveryId === delivery?.deliveryId) ?? deliveries[0];
    patch({ deliveries, deliveriesLoaded: true, delivery: selected, needsRefresh: false });
    if (preserveSearch && selected && state.query.trim() && state.searchFromServer) {
      const { items } = data(
        await call("search_items", { deliveryId: selected.deliveryId, query: state.query }),
        searchResultsSchema,
      );
      patch({ searchMatches: items });
    }
    await loadMenus(selected);
  }
  // The originating tool result seeds the app instead of fetching the same data again.
  useEffect(() => {
    void run(async () => {
      if (initial?.result.isError)
        throw new Error(resultText(initial.result) || "Forkable could not load this view.");
      const seed = initialData(initial);
      const input = initial?.input ?? {};
      const listed =
        seed.deliveries ?? data(await call("list_deliveries", range), deliveriesSchema).deliveries;
      const deliveries = listed.toSorted(
        (a, b) => a.date.localeCompare(b.date) || a.deliveryId - b.deliveryId,
      );
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
        searchMatches: seed.searchItems,
        searchFromServer: seed.searchItems !== undefined,
      });
      await loadMenus(selected, seed);
      if (selected && !isPastDelivery(selected.date)) {
        let item = seed.item;
        if (!item && input.itemId != null) {
          if (input.menuId == null) throw new Error("A menu ID is required to show an exact meal.");
          item = data(
            await call("get_menus", {
              deliveryId: selected.deliveryId,
              menuId: input.menuId,
              itemId: input.itemId,
            }),
            itemDetailSchema,
          ).item;
        }
        if (item)
          patch({
            detail: item,
            source: selected.meals.length === 1 ? String(selected.meals[0]!.pieceId) : "",
            choices: Object.fromEntries(item.modifiers.map((mod) => [mod.id, []])),
          });
      }
    });
    return () => {
      ++loadGeneration.current;
    };
  }, []);

  function choose(menuId: number, itemId: number, sourcePieceId?: string | number) {
    if (!delivery || isPastDelivery(delivery.date)) return;
    void run(async () => {
      invalidate(emptySelection);
      const item = data(
        await call("get_menus", { deliveryId: delivery.deliveryId, menuId, itemId }),
        itemDetailSchema,
      ).item;
      let source = sourcePieceId == null ? "" : String(sourcePieceId);
      if (sourcePieceId == null && delivery.meals.length === 1)
        source = String(delivery.meals[0]!.pieceId);
      patch({
        detail: item,
        source,
        choices: Object.fromEntries(item.modifiers.map((m) => [m.id, []])),
      });
    });
  }
  function chooseOption(
    modifierId: number,
    optionId: number,
    checked: boolean,
    max: number | null,
  ) {
    const picked = state.choices[modifierId] ?? [];
    let options = picked.filter((id) => id !== optionId);
    if (checked) options = max === 1 ? [optionId] : [...picked, optionId];
    invalidate({ choices: { ...state.choices, [modifierId]: options } });
  }
  async function review() {
    invalidate();
    if (!delivery || !detail) throw new Error("Choose a delivery and meal first.");
    const args = selectionArgs(delivery, detail, state.source, state.choices);
    const result = await confirmation.current.preview(call, args);
    const next = writeResult(result);
    patch({
      preview: next,
      notice: result.isError || next?.mode !== "preview" ? resultText(result) : "",
      problem: !!result.isError,
    });
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
      patch({ preview: undefined });
      const outcome = writeResult(result);
      if (outcome?.mode === "executed") {
        try {
          await refresh(true);
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
      patch({ preview: undefined, needsRefresh: sent || state.needsRefresh });
      if (!sent) throw error;
      throw new Error(
        "Confirmation could not be verified. Its outcome may be unknown. Refresh the delivery before trying again.",
        { cause: error },
      );
    }
  }
  return {
    state,
    hasPreview: !!confirmation.current.pending,
    refresh: () => void run(refresh),
    refreshSearch: () => void run(() => refresh(true)),
    choose,
    chooseOption,
    review: () => {
      if (!state.needsRefresh) void run(review);
    },
    confirm: () => void run(confirm),
    back: () => invalidate(emptySelection),
    setFilters: (filters: MenuFilters) => patch({ filters }),
    setQuery: (query: string) =>
      patch({ query, searchMatches: undefined, searchFromServer: false }),
    setSource: (source: string) => invalidate({ source }),
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
export type MealBrowserController = ReturnType<typeof useMealBrowser>;
