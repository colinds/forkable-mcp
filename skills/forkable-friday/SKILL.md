---
name: forkable-friday
description: >-
  Add a next-week planning workflow to the forkable skill. Use with forkable when the user asks to
  plan next week, review the week ahead, or establish a Friday meal-planning routine.
---

# Forkable week planning

Use the `forkable` skill for shared tool, selection, confirmation, and recovery rules. This skill
only adds a one-delivery-at-a-time workflow for planning the next week. Forkable normally posts the
next week's suggestions on Friday morning.

## Load the week

1. Call `list_deliveries` with next Monday and Friday as explicit `from` and `to` dates.
2. If useful for variety, list the current week with explicit bounds.
3. Read `~/.forkable-mcp/preferences.md` when it exists.

If no deliveries are returned, report that the week may not be posted yet. Do not treat an empty
range as a completed plan.

## Review one delivery at a time

For each delivery:

1. Show the current owned meal and whether it is confirmed.
2. Use `recommend_meals` for a short set of alternatives.
3. Use `search_items` for a stated ingredient or cuisine, or `get_menus` when the user wants to
   browse.
4. Keep the image Markdown returned by the tools.
5. Record whether the user wants to keep, replace, remove, or confirm the meal.

Apply the local preferences described in the `forkable` skill across the week. Use likes, dislikes,
and notes to rank options and avoid unnecessary repetition.

## Place changes

Preview and confirm each approved change before moving to the next delivery. Do not collect several
preview tokens for confirmation at the end of a long review.

Use `set_meal_all` only when the user wants the same exact item on several deliveries. Otherwise,
keep the review and changes one delivery at a time.

## Finish

Summarize deliveries that changed, deliveries left unchanged, and requests Forkable rejected or the
tools could not target safely. Keep unresolved deliveries explicit.
