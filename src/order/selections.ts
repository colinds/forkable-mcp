// Meal selection logic. Pure and unit-tested — this is where a wrong answer silently orders
// the wrong real food.
//
// selectionsHash semantics:
//   - keyed by MenuModifier.id (NOT optionSetId), value = array of selected option ids
//   - single-select modifier ⇔ (max === 1 && options.length > 1); value is [optionId] or the
//     sentinel [-1] when a NON-required single-select has nothing chosen
//   - multi-select ⇔ everything else; value is the array of chosen option ids
//   - key order follows item.modifierIds so previews and requests stay stable and diffable

import {
  type Menu,
  type MenuItem,
  type MenuModifier,
  type MenuOption,
  type SelectionsHash,
} from "./types.ts";

/** A user's requested choices for one modifier — by option id or (case-insensitive) name. */
export interface ModifierChoice {
  modifier: number | string; // modifier id or name
  options: (number | string)[]; // option ids or names
}

export interface SelectionViolation {
  modifierId: number;
  label: string;
  code: "required" | "below_min" | "above_max" | "unknown_option" | "unknown_modifier";
  min?: number;
  max?: number;
  selected: number;
}

export interface BuildSelectionsResult {
  selectionsHash: SelectionsHash;
  violations: SelectionViolation[];
  summary: { modifier: string; options: string[]; extra: number }[];
  extra: number; // added cost in dollars from chosen options
}

function isSingleSelect(mod: MenuModifier): boolean {
  return mod.max === 1 && mod.options.length > 1;
}

function modLabel(mod: MenuModifier): string {
  return mod.display || mod.name || `modifier ${mod.id}`;
}

/** Ordered, non-hidden modifiers for an item (order follows item.modifierIds when present). */
export function resolveItemModifiers(
  item: MenuItem,
  opts: { includeHidden?: boolean } = {},
): MenuModifier[] {
  const mods = (item.modifiers ?? []).filter((m) => opts.includeHidden || !m.hidden);
  if (!item.modifierIds?.length) return mods;
  const byId = new Map(mods.map((m) => [m.id, m]));
  const ordered: MenuModifier[] = [];
  for (const id of item.modifierIds) {
    const m = byId.get(id);
    if (m) {
      ordered.push(m);
      byId.delete(id);
    }
  }
  for (const m of byId.values()) ordered.push(m); // any not listed, appended
  return ordered;
}

/** Diet-aware default option (first whose ingredients don't intersect restrictions; else options[0]). */
export function defaultOption(
  mod: MenuModifier,
  restrictedIngredients: string[] = [],
): MenuOption | undefined {
  if (!restrictedIngredients.length) return mod.options[0];
  const restricted = new Set(restrictedIngredients);
  return (
    mod.options.find((o) => !(o.ingredientTags ?? []).some((t) => restricted.has(t))) ??
    mod.options[0]
  );
}

/** Added price (dollars) of an option: its own price, else the modifier's option-set price, else 0. */
function optionPrice(opt: MenuOption, mod: MenuModifier, menu?: Menu): number {
  if (typeof opt.price === "number") return opt.price;
  if (mod.optionSetId != null && menu?.optionSets) {
    const os = menu.optionSets.find((s) => s.id === mod.optionSetId);
    if (typeof os?.price === "number") return os.price;
  }
  return 0;
}

export interface BuildSelectionsInput {
  menu?: Menu;
  item: MenuItem;
  modifiers?: MenuModifier[]; // defaults to resolveItemModifiers(item)
  choices?: ModifierChoice[]; // explicit user choices
  previous?: SelectionsHash | null; // an existing piece's stored selections (for round-trip / defaults)
  restrictedIngredients?: string[];
}

/**
 * Build a selectionsHash for an item from explicit choices (falling back to sensible defaults).
 * Nothing is silently guessed for user-facing violations — required/min/max problems are returned
 * as violations (the write gate turns them into blocking guards).
 */
export function buildSelectionsHash(input: BuildSelectionsInput): BuildSelectionsResult {
  const mods = input.modifiers ?? resolveItemModifiers(input.item);
  const prev = input.previous ?? null;
  const violations: SelectionViolation[] = [];
  const summary: { modifier: string; options: string[]; extra: number }[] = [];
  const selectionsHash: SelectionsHash = {};
  let extraTotal = 0;

  // Index user choices by resolved modifier id → resolved option ids (with unknown detection).
  const chosenByMod = new Map<number, number[]>();
  for (const choice of input.choices ?? []) {
    const mod =
      typeof choice.modifier === "number"
        ? mods.find((m) => m.id === choice.modifier)
        : mods.find((m) => modLabel(m).toLowerCase() === String(choice.modifier).toLowerCase());
    if (!mod) {
      violations.push({
        modifierId: typeof choice.modifier === "number" ? choice.modifier : -1,
        label: String(choice.modifier),
        code: "unknown_modifier",
        selected: 0,
      });
      continue;
    }
    const optIds: number[] = [];
    for (const o of choice.options) {
      const opt =
        typeof o === "number"
          ? mod.options.find((x) => x.id === o)
          : mod.options.find((x) => x.name.toLowerCase() === String(o).toLowerCase());
      if (!opt) {
        violations.push({
          modifierId: mod.id,
          label: modLabel(mod),
          code: "unknown_option",
          selected: 0,
        });
      } else {
        optIds.push(opt.id);
      }
    }
    chosenByMod.set(mod.id, optIds);
  }

  for (const mod of mods) {
    const label = modLabel(mod);
    const user = chosenByMod.get(mod.id);
    const previous = prev?.[String(mod.id)];

    let selected: number[];
    if (isSingleSelect(mod)) {
      if (user?.length) selected = [user[0]!];
      else if (previous?.length) selected = [previous[0]!];
      else
        selected = [
          mod.required ? (defaultOption(mod, input.restrictedIngredients)?.id ?? -1) : -1,
        ];

      if (mod.required && selected[0] === -1) {
        violations.push({ modifierId: mod.id, label, code: "required", selected: 0 });
      }
      if (user && user.length > 1) {
        violations.push({
          modifierId: mod.id,
          label,
          code: "above_max",
          max: 1,
          selected: user.length,
        });
      }
    } else {
      if (user) selected = user;
      else if (previous?.length) selected = previous;
      else selected = mod.required && mod.options[0] ? [mod.options[0].id] : [];

      const min = mod.min ?? 0;
      const max = mod.max ?? mod.options.length;
      if (selected.length === 0 && mod.required) {
        violations.push({ modifierId: mod.id, label, code: "required", selected: 0 });
      } else if (selected.length < min) {
        violations.push({
          modifierId: mod.id,
          label,
          code: "below_min",
          min,
          selected: selected.length,
        });
      } else if (selected.length > max) {
        violations.push({
          modifierId: mod.id,
          label,
          code: "above_max",
          max,
          selected: selected.length,
        });
      }
    }

    selectionsHash[String(mod.id)] = selected;

    // Human summary + pricing (skip the -1 sentinel).
    const chosenOpts = selected
      .filter((id) => id !== -1)
      .map((id) => mod.options.find((o) => o.id === id))
      .filter((o): o is MenuOption => !!o);
    const extra = chosenOpts.reduce((sum, o) => sum + optionPrice(o, mod, input.menu), 0);
    extraTotal += extra;
    if (chosenOpts.length) {
      summary.push({ modifier: label, options: chosenOpts.map((o) => o.name), extra });
    }
  }

  return { selectionsHash, violations, summary, extra: extraTotal };
}
