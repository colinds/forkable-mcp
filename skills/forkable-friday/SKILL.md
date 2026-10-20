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
4. Call `prepare_meal` with that `deliveryId` and a short, preference-ranked list of exact
   `{menuId, itemId}` candidates. The tool loads the names, prices, and photos and presents a native
   form when supported. Each form is for one delivery; keep the date, service, and club clear.
5. Handle the returned choice:
   - `selected`: call `prepare_meal` again with its returned `arguments` (the exact delivery/menu/item
     pair, without `candidates`). This configures required options, optional add-ons, Notes when the
     restaurant accepts them, and an owned replacement target when needed.
   - `configured`: use the returned arguments for the later `set_meal` preview.
   - `keep`: leave the meal unchanged; handle delivery confirmation separately if requested.
   - `skip`: record the request to remove the owned meal(s), using the normal removal preview and
     confirmation flow. An already-empty delivery needs no removal.
   - `cancelled`: leave the delivery unchanged and unresolved; do not interpret cancellation as skip.

If `prepare_meal` returns `needs_input` with `phase: "meal"`, show the same shortlist in chat,
retaining its image Markdown, prices, and exact menu/item identities. Ask the user which meal to
keep or choose, or whether to skip. If it returns `needs_input` with `phase: "options"`, collect
the options and optional Notes in chat from the returned item details. A client without native
forms can complete the whole workflow this way; do not repeatedly retry forms or require an MCP App.
If `prepare_meal` is unavailable on the current connection, use the existing read tools and
collect the same choices in chat.

Form submissions collect preferences only. They do not place or remove meals, and are not an
authorization to execute a write. Review the proposed change and obtain the confirmation required
by the `forkable` skill before using a confirmation token.

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
