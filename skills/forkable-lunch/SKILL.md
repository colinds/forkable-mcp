---
name: forkable-lunch
description: >-
  Read, choose, change, skip, confirm, and track meals through the forkable MCP server. Use for
  Forkable delivery, menu, recommendation, meal, and courier-status requests.
---

# Forkable lunch

Use the `forkable` MCP tools for account data and meal changes. If the tools are not available, use
the `forkable-setup` skill.

## Find the delivery first

Call `list_deliveries` before other delivery tools. Use the returned `deliveryId`; do not derive an
ID from a date. A date can have more than one delivery, so distinguish deliveries by service and club.

Re-list before a write if the conversation has been long or a meal has changed. Piece IDs can change
after a replacement.

The default list window begins today and extends 21 days. For past deliveries, supply both `from`
and `to`. Forkable normally posts the next week's suggestions on Friday; an empty future range may
mean that the week is not available yet.

The delivery fields are server-reported context. Do not infer a write deadline, capacity decision,
company limit, or authoritative charge from them. Forkable decides whether a mutation is allowed.

## Read and choose meals

Use these tools in order as appropriate:

1. `recommend_meals` for Forkable's ranked suggestions.
2. `search_items` when the user names an ingredient, dish, or cuisine.
3. `get_menus` to browse a delivery or load one item's modifier details.

Treat recommendations as suggestions rather than policy. Apply the user's stated preferences and
show a short set of suitable options with prices and any images returned by the tools.

Menu item IDs can repeat across menus. Keep the `menuId` with every item. Both `set_meal` and
`set_meal_all` require the exact `(menuId, itemId)` returned by a menu read tool.

Load item details before setting modifiers. Modifier and option names are accepted only when they
resolve uniquely; IDs are preferable when names repeat. Preserve an explicitly empty optional
selection instead of restoring an old or default choice.

## Local preferences

If file access is available, store user-stated food preferences in
`~/.forkable-mcp/preferences.md` and read it before choosing a meal. This file is an agent
convention, not a Forkable setting.

A simple format is:

```markdown
avoid: peanut (allergy)
dislikes: fried, bone-in
likes: salmon, grain bowls
notes: prefer lighter meals on meeting-heavy days
```

Treat `avoid` entries as hard local constraints unless the user explicitly changes them. Other
entries guide ranking. Do not copy Forkable dietary settings into this file or present local
preferences as server validation.

## Set or remove a meal

`set_meal` adds a meal when none is owned and otherwise replaces an owned meal. It does not add a
second meal. If the delivery has several owned meals, pass `sourcePieceId` to identify the one to
replace.

`set_meal_all` applies one exact `(menuId, itemId)` across the requested delivery IDs and ignores
duplicate delivery IDs. A delivery with several owned meals must be handled individually with
`set_meal` and `sourcePieceId`.

`remove_meal` requires an owned `pieceId`. `skip_delivery` removes the only positively owned
meal on a delivery; use `remove_meal` separately when more than one is owned.

`confirm_delivery` confirms by default. Pass `confirm: false` to unconfirm without removing the
meal. `set_meal` can use `autoConfirm` when the user wants the replacement and confirmation in one
mutation.

## Dietary advisory

While creating a `set_meal` or `set_meal_all` preview, the server calls Forkable's
`mealRestrictions` query with the selected customization.

- `diet_conflict` contains conflicts reported by Forkable.
- `diet_check_unavailable` means the advisory query did not complete.

Neither warning blocks a confirmation token. Show a dietary conflict prominently and use the token
only if the user accepts the override. Confirmation is the equivalent of Forkable's "add anyway"
action. The advisory is not run again during confirmation.

## Preview and confirmation

Every write is a preview until the same tool is called with `confirmToken`. The preview sends
nothing and stores the exact executable request in the running server process.

Before confirming, show the user the delivery, meal or action, price when known, and all warnings.
If the user already gave explicit approval for that exact action and the preview adds no material
warning, the confirmation can happen in the same turn.

The token is single-use, expires after about ten minutes, and is bound to the tool arguments, user,
and delegation session. It is lost when the server restarts. Confirmation submits the stored request
without rebuilding it or repeating advisory checks.

Keep every original argument unchanged when adding `confirmToken`. If a token is expired, used, or
mismatched, the response contains a replacement preview with `confirmationError`. Nothing was sent.
Review the replacement preview before using its new token.

## Result handling

- `preview`: nothing was sent. Review it before confirmation.
- `blocked`: no token was issued. Correct the target, selection, ownership issue, or local preview
  ceiling problem.
- `executed`: Forkable returned success.
- `rejected`: Forkable definitively refused the write. Stop and report the structured errors; do
  not reuse the consumed token.
- `outcome_unknown`: Forkable may have applied the write. Do not retry. Refresh the delivery IDs
  named in `reconciliation` with `list_deliveries`, then compare the current state.

Mutations are not retried after an ambiguous transport or server failure.

## Price and billing

`FORKABLE_MAX_TOTAL`, when configured, is a local per-meal preview ceiling. It is not a Forkable
allowance or charge limit. A total above the ceiling is blocked. An unknown total is also blocked
because the ceiling cannot be verified.

Delivery billing fields are direct values reported by Forkable and are returned in integer cents.
Quote them as reported. Do not calculate company coverage or an authoritative out-of-pocket amount.

## Unsupported account actions

The tools do not add a second meal to a delivery, rate meals, report missing or incorrect items,
change vacation settings, edit Forkable dietary settings, or switch offices. Direct the user to
Forkable for those actions.
