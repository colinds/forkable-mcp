---
name: forkable-friday
description: >-
  Review and plan the next week of Forkable meals one delivery at a time. Use when the user asks to
  plan next week, review the week ahead, or establish a Friday meal-planning routine.
---

# Forkable week planning

Forkable normally posts the next week's suggestions on Friday morning. Use this workflow when the
requested week is available. Follow the write and recovery rules in the `forkable-lunch` skill.

## Load the week

1. Call `list_deliveries` with next Monday and Friday as explicit `from` and `to` dates.
2. If useful for variety, list the current week with explicit bounds.
3. Read `~/.forkable-mcp/preferences.md` when it exists.

If no deliveries are returned, report that the week may not be posted yet. Do not invent delivery
IDs or treat an empty range as a completed plan.

A date can contain more than one delivery. Use the service and club fields to identify each one.
Treat the current meal as selected only when the returned data attributes it to the user.

Delivery billing fields are direct Forkable values in integer cents. Report them as supplied; do not
infer a company limit, coverage amount, or final charge.

## Review one delivery at a time

For each delivery:

1. Show the current owned meal and whether it is confirmed.
2. Use `recommend_meals` for a short set of alternatives.
3. Use `search_items` for a stated ingredient or cuisine, or `get_menus` when the user wants to
   browse.
4. Keep the image Markdown returned by the tools.
5. Record whether the user wants to keep, replace, remove, or confirm the meal.

Apply local preferences across the week. An `avoid` entry in
`~/.forkable-mcp/preferences.md` is a hard agent constraint, not a Forkable dietary rule. Use
likes, dislikes, and notes to rank options and avoid unnecessary repetition.

Keep every item's `menuId`. A write requires the exact `(menuId, itemId)` from the read result;
`itemId` alone is not a stable identity. If a delivery has several owned meals, use
`sourcePieceId` with `set_meal` to choose the one being replaced.

## Place changes

Writes use preview and confirmation:

1. Call the write tool without `confirmToken`.
2. Show the exact action, price when known, and warnings.
3. Call the same tool with unchanged arguments and the preview token after approval.
4. Continue to the next delivery.

Tokens are process-local, single-use, and expire after about ten minutes. Confirmation sends the
stored request without rebuilding it. Do not save several previews for confirmation at the end of a
long review; create each preview when it is ready to be confirmed.

`set_meal_all` may be used when the same exact item is available for several delivery IDs. It
deduplicates delivery IDs. Deliveries with several owned meals must be handled separately with
`set_meal` and `sourcePieceId`.

## Dietary and price warnings

`set_meal` and `set_meal_all` previews call Forkable's `mealRestrictions` query. A
`diet_conflict` warning is Forkable's advisory result. Show it and confirm only when the user wants
to use Forkable's "add anyway" path. A `diet_check_unavailable` warning does not block confirmation,
but it must be disclosed. The check is not repeated during confirmation.

`FORKABLE_MAX_TOTAL` is a local preview ceiling, not a Forkable billing rule. A meal above the
ceiling, or with an unknown total when the ceiling is configured, receives no confirmation token.

## Recover from write results

- An invalid, expired, used, or mismatched token returns a replacement preview and sends nothing.
  Review the replacement before using its new token.
- `rejected` means Forkable refused the request. Stop and report the returned errors.
- `outcome_unknown` means the write may have succeeded. Do not retry it. Refresh the affected
  delivery IDs with `list_deliveries` and reconcile the result.

## Finish

Summarize deliveries that changed, deliveries left unchanged, and requests Forkable rejected or the
tools could not target safely. Keep unresolved deliveries explicit.
