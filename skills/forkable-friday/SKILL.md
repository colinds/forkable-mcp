---
name: forkable-friday
description: >-
  Walk the user through their upcoming week of Forkable lunch one day at a time — what's on each day,
  what else the restaurants are offering, and what they want instead. Forkable posts the coming
  week's suggestions on Friday morning. Use on a Friday, when the user asks to plan / order / review
  next week or "the week ahead", or when they want a standing weekly lunch routine.
---

# The week ahead

Forkable posts suggestions for the coming week on **Friday morning, the week before delivery** — so
Friday is the day the whole week is open at once, and the day this is worth doing.

Go **one day at a time**. Most people want to see Monday, decide Monday, then move on; a five-row
table of the whole week is a summary, not a decision. Batch only when they ask for it.

Tool-by-tool rules are in `forkable-lunch`.

## Read the week first

- `list_deliveries { from: <next Monday>, to: <next Friday> }` — the week.
- `list_deliveries { from: <this Monday>, to: <today> }` — what they've already eaten (both bounds),
  so you don't offer the same restaurant twice in a week.
- `~/.forkable-mcp/preferences.md`, if they keep one.

**Don't assume every day has a meal on it, and don't call what's there an order.** Read each day:

| What the day shows | What it is |
|---|---|
| a pick, confirmed | already ordered — changing it is a swap |
| a pick, not confirmed | a *suggestion*. With auto-order off it's canceled at the cutoff unless confirmed |
| nothing picked / needs an order | genuinely empty — a vacation day, a weekday they don't take, or no suggestion |
| no deliveries at all | next week isn't posted yet — say so rather than reporting an empty week |

## Then walk it

Per day, a few lines and a question — not a menu dump:

> **Mon 24th** — currently *Chili Paneer Bowl* (Cardamom House), covered by the $20 allowance.
> Also on offer: *Miso Salmon Bowl* (Blue Pine), *Herb Chicken Plate* (Olive & Ash).
> Keep it, or swap?

- Lead with what's on the day, then two or three real alternatives — `recommend_meals` first,
  `search_items` if they named something, `get_menus` when they want the full slate.
- Keep the `![dish](url)` markdown the tools return. People pick lunch by looking at it.
- Place each day as it's decided (preview → `confirmToken`), then move to the next. Don't hold five
  days of decisions in your head to place at the end — a confirm token lapses about ten minutes
  after its preview, so a week agreed now and placed later needs fresh previews, never saved tokens.
- Carry the thread forward: if they turn down noodles on Monday, don't lead with noodles on Thursday.

Let them jump the queue at any point — "rest of the week is fine", "you pick the others", "same as
Monday for Thursday" (that's `set_meal_all`). When they hand you the rest of the week, show one
table of what you're about to place before you place it, then do it in one pass — re-list first if
the conversation has been long, since a window can close under you while you talk.

## Two things to say out loud

- **Suggestions ignore the allowance.** Forkable picks on taste, not budget, so a suggested meal can
  land over what the company covers. Over the limit with no card on file, the meal is **cancelled**
  — flag it on the day rather than letting the week fail quietly.
- **Auto-order off means confirming is the order.** An unconfirmed day is canceled at the cutoff, so
  `confirm_delivery` (or `autoConfirm` on `set_meal`) is what makes the week real. Check `get_profile`
  once, up front, so you know which mode they're in.

Also worth a mention when it applies: a suggestion is generated from their Forkable diet settings but
isn't guaranteed to respect them, so read the dish rather than trusting the pick; and if they say
they're away, the day still has to be removed by hand — marking vacation only stops *future* meals
being generated.

## Close it out

Three lists: placed, left alone, couldn't. A day that refused — closed, at capacity, item not
offered — is theirs to solve, not yours to bury.

If the routine lands, offer to make it recurring: a scheduled run on Friday morning that pulls the
week and starts at Monday. Ask before scheduling it, and keep the per-day approval — a weekly job
that orders silently is one nobody trusts.
