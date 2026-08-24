// selectionsHash semantics:
//   - keyed by MenuModifier.id, not optionSetId
//   - single-select modifier ⇔ (max === 1 && options.length > 1); value is [optionId] or the
//     sentinel [-1] when a non-required single-select has nothing chosen
//   - multi-select ⇔ everything else; value is the array of chosen option ids
//   - key order follows item.modifierIds

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
  code:
    | "required"
    | "below_min"
    | "above_max"
    | "unknown_option"
    | "unknown_modifier"
    | "ambiguous_option"
    | "ambiguous_modifier"
    | "duplicate_option"
    | "duplicate_modifier";
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

function modName(mod: MenuModifier): string {
  return mod.display?.trim() || mod.name?.trim() || "";
}

function modLabel(mod: MenuModifier): string {
  return modName(mod) || `modifier ${mod.id}`;
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

/** The API-ordered default for a required modifier. */
export function defaultOption(mod: MenuModifier): MenuOption | undefined {
  return mod.options[0];
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
}

const normalizeName = (value: string): string => value.trim().toLowerCase();

function resolveUnique<T>(values: T[], name: string, label: (value: T) => string): T[] {
  const normalized = normalizeName(name);
  if (!normalized) return [];
  return values.filter((value) => normalizeName(label(value)) === normalized);
}

/** Build selections from explicit choices, prior values, or API-ordered defaults. */
export function buildSelectionsHash(input: BuildSelectionsInput): BuildSelectionsResult {
  const mods = input.modifiers ?? resolveItemModifiers(input.item);
  const prev = input.previous ?? null;
  const violations: SelectionViolation[] = [];
  const summary: { modifier: string; options: string[]; extra: number }[] = [];
  const selectionsHash: SelectionsHash = {};
  let extraTotal = 0;

  // Resolve names before indexing choices by modifier id.
  const chosenByMod = new Map<number, number[]>();
  for (const choice of input.choices ?? []) {
    const matches =
      typeof choice.modifier === "number"
        ? mods.filter((m) => m.id === choice.modifier)
        : resolveUnique(mods, choice.modifier, modName);
    const mod = matches[0];
    if (!mod) {
      violations.push({
        modifierId: typeof choice.modifier === "number" ? choice.modifier : -1,
        label: String(choice.modifier),
        code: "unknown_modifier",
        selected: 0,
      });
      continue;
    }
    if (matches.length > 1) {
      violations.push({
        modifierId: -1,
        label: String(choice.modifier),
        code: "ambiguous_modifier",
        selected: matches.length,
      });
      continue;
    }
    if (chosenByMod.has(mod.id)) {
      violations.push({
        modifierId: mod.id,
        label: modLabel(mod),
        code: "duplicate_modifier",
        selected: 2,
      });
    }

    const optIds: number[] = [];
    for (const o of choice.options) {
      const optionMatches =
        typeof o === "number"
          ? mod.options.filter((x) => x.id === o)
          : resolveUnique(mod.options, o, (x) => x.name);
      const opt = optionMatches[0];
      if (!opt) {
        violations.push({
          modifierId: mod.id,
          label: modLabel(mod),
          code: "unknown_option",
          selected: 0,
        });
      } else if (optionMatches.length > 1) {
        violations.push({
          modifierId: mod.id,
          label: modLabel(mod),
          code: "ambiguous_option",
          selected: optionMatches.length,
        });
      } else if (optIds.includes(opt.id) || chosenByMod.get(mod.id)?.includes(opt.id)) {
        violations.push({
          modifierId: mod.id,
          label: modLabel(mod),
          code: "duplicate_option",
          selected: 2,
        });
      } else {
        optIds.push(opt.id);
      }
    }
    chosenByMod.set(mod.id, [...(chosenByMod.get(mod.id) ?? []), ...optIds]);
  }

  for (const mod of mods) {
    const label = modLabel(mod);
    const hasUserChoice = chosenByMod.has(mod.id);
    const user = chosenByMod.get(mod.id);
    const previous = prev?.[String(mod.id)];

    let selected: number[];
    if (isSingleSelect(mod)) {
      if (hasUserChoice) selected = user?.length ? [user[0]!] : [-1];
      else if (previous?.length) selected = [previous[0]!];
      else selected = [mod.required ? (defaultOption(mod)?.id ?? -1) : -1];

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

    // The -1 sentinel has no option or price.
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
