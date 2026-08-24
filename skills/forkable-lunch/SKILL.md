---
name: forkable-lunch
description: >-
  Order, change, skip, and track Forkable corporate lunches through the forkable MCP server. Use
  for anything about the user's lunch — what's coming this week, what's on the menu, picking or
  swapping a meal, skipping a day, confirming an order, or where today's delivery is right now.
---

# Forkable lunch

The `forkable` MCP server acts on the user's real Forkable account; the tool descriptions say what
each tool does, so this file only covers what they can't. If the tools aren't connected, don't
improvise a CLI or hit the website — use the `forkable-setup` skill.

## Start at `list_deliveries`

Every other tool takes a `deliveryId`, and the only valid source of one is `list_deliveries`.
Don't guess an id, don't derive it from a date, and re-list rather than reusing anything from
earlier in a long conversation — pieceIds are reissued on every swap, and a day's `writeWindow`
can flip while you talk. One date can carry **two** deliveries (lunch and dinner, or two clubs) —
tell them apart by the service and club labels, not the date.

- Default window is today → 21 days out, so days already eaten aren't in it. To look back, pass
  `from` **and** `to`: a past `from` on its own appends upcoming days, and a question about last
  week comes back looking answered when it isn't.
- **The horizon really ends this Friday.** Forkable posts the coming week's suggestions on Friday
  morning, the week before delivery, so mid-week the list stops at Friday however wide the window.
  Nothing past Friday means *next week isn't out yet* — say that, don't report an empty week.
  Planning a full week is the `forkable-friday` skill.
- Branch on `writeWindow`, never on a cutoff you compute yourself (Forkable's stated policy is 2pm
  the day before, but the flag is the truth): `open` — freely editable · `grace` — normal editing
  closed, but a late adjustment can still be requested, and Forkable confirms it morning-of rather
  than instantly, so report it as requested, not done · `closed` — nothing further will land.
- In `grace`, adding and removing are **separate budgets**: late orders spend the monthly allowance
  the app calls Last-Call Passes (`get_profile` shows the balance), late cancellations spend their
  own and some clubs switch them off entirely. Being able to add a meal there says nothing about
  being able to drop one.

## Common asks

| They say | Route |
|---|---|
| "what's for lunch this week / tomorrow" | `list_deliveries`, then the picked meal per day |
| "what's my company limit?" | the per-delivery copay in `list_deliveries`; `get_profile` for club policy |
| "switch Wednesday to something better" | `recommend_meals` for that day → `set_meal` |
| "where's my lunch?" | `get_delivery_status` — ETA, tracking link, meal group (reassigned daily), access notes |
| "I'm away next week" | `skip_delivery` each scheduled day — Forkable's vacation setting only stops future weeks from generating |
| "plan next week" | the `forkable-friday` skill |

## Picking

A day may already carry a meal, but don't assume one, and don't assume it's ordered. Forkable
*suggests* from the user's diet settings: with auto-order on that suggestion gets ordered unless
canceled, with it off the day is only real once confirmed, and a day can be empty outright — a
vacation day, a weekday they don't take, or no suggestion at all. Read the day, then decide whether
this is a swap or a first order. `explain_pick` gives the pick's score and rank — which on a day of
tied scores explains less than it looks like; `set_meal` replaces it.

Three ways in, in rough order of cost:

1. `recommend_meals` — Forkable's meal-generation scores. Start here, but read the numbers before
   you trust them: they tie heavily in practice — a real day came back with one item at 27.5 and
   every other suggestion at exactly 7.50, the same score as the meal Forkable itself had picked,
   which ranked 15th. Treat the list as a shortlist to break with what you know about the user, not
   a ranking that already knows their taste.
2. `search_items` — when the user named something ("anything with salmon").
3. `get_menus` — the full slate when they want to browse, or to read one item's modifiers
   (`itemId`) before customizing. It marks a full venue with `[venue at capacity]`; the venue the
   user already holds a meal at is never full for them — re-picking there isn't a new seat.

Then apply the user's own taste on top: Forkable's score doesn't know they're off tofu this month,
and even the diet match isn't guaranteed — Forkable's own advice is to review suggestions. Prefer
the user's stated constraint over the higher score, and say why you picked in a line, not a paragraph.

- **Keep the dish images.** Items come back with `![name](url)` markdown attached. Pass it through —
  people choose lunch by looking at it. An item without one just has no photo on Forkable's side.
- **Don't dump menus.** One day is around fifty items across four venues, so a week is a wall of
  text. Show a handful that fit what they asked for, with prices, and offer the rest. `get_menus`
  does carry a per-item `diet` label, which is the cheapest way to filter a day properly.

Customize through `modifiers` on `set_meal`, by name or id:
`[{modifier: "Choose Protein", options: ["Steak"]}]`. Required modifiers get a diet-safe default
if you leave them out; read the item's options first when the user cares.

## Preferences

A convention this skill owns, not a server feature: keep what the user tells you about their food
in `~/.forkable-mcp/preferences.md`, with your own file tools — read before any ordering task,
append whenever they state a taste, a limit, or a rule. Forkable holds their diet server-side
(`set_meal` warns `diet_conflict`), so don't re-declare it; the file is for what Forkable can't express:

```markdown
avoid: peanut (allergy — hard block, never order around it)
dislikes: fried, bone-in
likes: salmon, grain bowls, greens
maxPrice: 20
notes: lighter on meeting-heavy days; don't repeat a cuisine twice in a week
```

Anything under `avoid` is a hard block: if the whole day's menu conflicts, say so and pick nothing
rather than the least-bad option. The rest is judgment you're expected to exercise — open-ended
notes like "more protein this week" are the point, not noise.

## Writing: preview, show, then confirm

Every write tool is **dry-run by default**. The first call sends nothing — it returns the exact
mutation, the resolved payload, a summary with the price, and a `confirmToken`. Calling again with
that token is what actually sends it.

1. Preview.
2. Show the user the dish, the day, and the total — plus any warning the preview raised.
3. Call again with `confirmToken` once they've agreed. If they already said "order it", one clear
   summary and the confirming call in the same turn is fine; don't loop back for permission twice.

The token is bound to the exact tool arguments, user, and delegation. It is single-use, lapses after
ten minutes, and disappears when the server restarts. Confirmation sends the stored preview once;
Forkable decides whether intervening server changes make it invalid. A rejected token means
**re-preview**, never retry.

Guards attached to a preview are advisory: Forkable enforces its own policy and reports refusals
itself. A warning is worth repeating to the user, not worth refusing over. Only two things stop a
token being minted, and both are real stops: the operator's `FORKABLE_MAX_TOTAL` ceiling, and a
malformed selection (a bug — report it, don't work around it).

- `set_meal` **replaces** the day's existing pick; it never stacks a second meal on a day. It takes
  `instructions` too — a venue that ignores special instructions gets a warn, and they're sent anyway.
- `set_meal_all` puts one item across several days and flags the days that don't offer it.
- `skip_delivery` declines the whole day, but refuses when the day carries more than one of the
  user's meals — `remove_meal` them one at a time so the right ones go.
- `confirm_delivery` is a toggle: `confirm: false` unconfirms but leaves the meal in place.
  Unconfirming is **not** skipping.
- Auto-order off (check `get_profile`) means an unconfirmed meal is **canceled at the cutoff** —
  `confirm_delivery` is load-bearing, not a formality. `set_meal` takes `autoConfirm` for both in one call.
- Suggestions ignore the allowance, and a confirmed meal over it with no card on file is
  **cancelled**, not merely charged — the app warns in those words. `over_company_limit` /
  `no_credit_card` on a preview is that failure arriving early; say so before confirming.

## Not through these tools

The website does things this server doesn't expose. Say so and point at forkable.com rather than
improvising: **adding a second meal** to a day (`set_meal` only replaces), **rating** a meal (ratings
are what steer future suggestions), **reporting a missing or wrong item** after delivery, **vacation
days**, **diet settings**, and **switching office** for a day.

## Don't

- Don't touch a meal the tools didn't attribute to this user — a delivery can carry a colleague's
  order, and the tools say when a meal isn't theirs.
- Don't promise coverage. What the company pays is reported per delivery and can be per-member,
  weekly, or absent; quote what the tool said and nothing more.
- Don't read a meal the user didn't set as a mistake. Forkable suggests; `explain_pick` says why.
- Don't answer a closed day with just "too late". Say what the window is (`grace` still takes a late
  change request; `closed` doesn't) and what the user can do instead — tomorrow, or a different day.
