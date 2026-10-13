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
  deliveryStatusSchema,
  type DeliveryStatus,
  deliveriesSchema,
  menusSchema,
  itemDetailSchema,
  recommendationsSchema,
  writeResult,
  data,
  resultText,
  selectionArgs,
  type CallTool,
  type Delivery,
  type Detail,
  type Menu,
  type Recommendation,
  type WriteResult,
  type SearchMatch,
} from "../lib/model.ts";
interface BrowserState {
  deliveries: Delivery[];
  deliveriesLoaded: boolean;
  delivery?: Delivery;
  menus: Menu[];
  recommendations: Recommendation[];
  detail?: Detail;
  deliveryStatus?: DeliveryStatus;
  statusUnavailable: boolean;
  source: string;
  choices: Record<string, number[]>;
  query: string;
  filters: MenuFilters;
  searchMatches?: SearchMatch[];
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
  busy: true,
  statusUnavailable: false,
  problem: false,
  needsRefresh: false,
};

export function useMealBrowser(call: CallTool, initial?: InitialView) {
  const [state, setState] = useState(initialState);
  const running = useRef(false);
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
    patch({ menus: [], recommendations: [], deliveryStatus: undefined, statusUnavailable: false });
    if (!selected) return;
    const args = { deliveryId: selected.deliveryId };
    const menusSeed = isPastDelivery(selected.date) ? [] : seed?.menus;
    const recommendationsSeed = isPastDelivery(selected.date) ? [] : seed?.recommendations;
    const [menuResult, recommendationResult, statusResult] = await Promise.allSettled([
      menusSeed
        ? Promise.resolve({ isError: false, structuredContent: { menus: menusSeed } })
        : call("get_menus", args),
      recommendationsSeed
        ? Promise.resolve({
            isError: false,
            structuredContent: { recommendations: recommendationsSeed },
          })
        : call("recommend_meals", args),
      seed?.status
        ? Promise.resolve({ isError: false, structuredContent: { status: seed.status } })
        : call("get_delivery_status", { ...args, from: selected.date, to: selected.date }),
    ]);
    if (statusResult.status === "fulfilled" && !statusResult.value.isError) {
      const parsed = deliveryStatusSchema.safeParse(statusResult.value.structuredContent);
      patch({
        deliveryStatus: parsed.success ? parsed.data.status : undefined,
        statusUnavailable: !parsed.success,
      });
    } else patch({ statusUnavailable: true });
    if (menuResult.status === "rejected" || menuResult.value.isError) {
      patch({
        notice:
          menuResult.status === "fulfilled"
            ? resultText(menuResult.value)
            : "Menus could not be loaded. Refresh to try again.",
        problem: true,
      });
      return;
    }
    const menus = data(menuResult.value, menusSchema).menus;
    patch({ menus });
    if (recommendationResult.status === "fulfilled" && !recommendationResult.value.isError)
      patch({
        recommendations: data(recommendationResult.value, recommendationsSchema).recommendations,
      });
    else
      patch({
        notice: "Recommendations are unavailable. You can still browse all meals.",
        problem: false,
      });
  }
  async function refresh() {
    invalidate({
      ...emptySelection,
      deliveries: [],
      deliveriesLoaded: false,
      delivery: undefined,
      menus: [],
      recommendations: [],
      query: "",
      searchMatches: undefined,
      filters: defaultFilters,
    });
    const deliveries = data(
      await call("list_deliveries", range),
      deliveriesSchema,
    ).deliveries.toSorted((a, b) => a.date.localeCompare(b.date) || a.deliveryId - b.deliveryId);
    const selected = deliveries.find((d) => d.deliveryId === delivery?.deliveryId) ?? deliveries[0];
    patch({ deliveries, deliveriesLoaded: true, delivery: selected, needsRefresh: false });
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
        return call(name, args);
      });
      patch({ preview: undefined });
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
    choose,
    chooseOption,
    review: () => {
      if (!state.needsRefresh) void run(review);
    },
    confirm: () => void run(confirm),
    back: () => invalidate(emptySelection),
    setFilters: (filters: MenuFilters) => patch({ filters }),
    setQuery: (query: string) => patch({ query, searchMatches: undefined }),
    setSource: (source: string) => invalidate({ source }),
    setDelivery: (id: number) =>
      void run(async () => {
        const selected = state.deliveries.find((d) => d.deliveryId === id);
        invalidate({
          ...emptySelection,
          delivery: selected,
          query: "",
          searchMatches: undefined,
          filters: defaultFilters,
        });
        await loadMenus(selected);
      }),
  };
}
export type MealBrowserController = ReturnType<typeof useMealBrowser>;
