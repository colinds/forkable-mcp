# CLAUDE.md

Architecture and development notes for **forkable-mcp**. User-facing quick start is in the [README](./README.md).

## What it is

A local, stateless MCP server (Bun + TypeScript) that drives a Forkable corporate-lunch account over
**stdio**. The MCP client spawns the process and owns its lifecycle; the only durable state is an
on-disk session, read on every tool call.

## Project layout

```
src/
  index.ts        entry: argv → stdio server, or `--auth` CLI
  config.ts       Config (version, read from package.json)
  server.ts       serveStdio + keepalive + headless env provisioning
  tools.ts        the 12 tool definitions + shared runtime helpers
  write-gate.ts   preview-then-token write safety
  net/            Forkable transport
    endpoints.ts    URLs, headers, User-Agent
    client.ts       ForkableClient — query/mutate, CSRF, cookie rotation, 401 handling
    gql.ts          literal serializer + query/mutation builders
    errors.ts       error types
  auth/
    session.ts      on-disk session store (mode 0600)
    cookies.ts      cookie-jar merge + cURL parsing
    ingest.ts       normalize creds → verify → persist (+ FORKABLE_COOKIE provisioning)
    chrome.ts       macOS Chrome cookie decryption
    cli.ts          `bun run auth`
    login.ts        email/password `createSession` login
  order/            ordering domain (pure)
    types.ts        Menu / MenuItem / Piece / Order / Delivery + tracking (EtaStatus, Dropoff, …)
    selections.ts   selectionsHash builder
    guards.ts       ordering guards + own-order resolution
    format.ts       money / date formatting
    status.ts       fulfillment view-model + renderer (get_delivery_status)
tests/            bun test
```

## Transport

stdio via `serveStdio` from `@modelcontextprotocol/server/stdio`. `index.ts` defaults to it; there is no
HTTP server. Each tool reads the session per call, so nothing is held in memory between requests.

## Auth

Forkable uses a session cookie plus a CSRF token (fetched automatically) — there's no API key. Establish
a session one of:

- **Email/password** (`auth/login.ts`): `bun run auth --login` (`--email`/`--password`/`--mfa`) or
  `FORKABLE_EMAIL`/`FORKABLE_PASSWORD` (+ `FORKABLE_MFA`) env. Logs in via the `createSession` mutation;
  works headless. A public `identities` pre-check fails fast on SSO-only accounts. Password-capable only.
- **Browser cookie**: `bun run auth --chrome` (macOS Keychain-decrypts the local browser cookie; `--browser`
  picks any value in `SUPPORTED_BROWSERS`), `FORKABLE_COOKIE` env, or `bun run auth --file <path>` /
  `pbpaste | bun run auth`.

  `chrome.ts` searches **every** profile, not just `Default`: `discoverProfiles` unions `Default`, the
  dirs in `Local State`'s `profile.info_cache`, any sibling dir holding a `Cookies` DB, and the
  user-data root itself (Opera keeps `Cookies` there). Labels come from `info_cache` or the profile's
  own `Preferences` (`profile.name`) — Arc doesn't keep `info_cache` current. `pickProfileJar` then
  takes the profile whose `_easyorder_session` has the newest `last_access_utc`, so a logged-out
  `Default` can't shadow a live `Profile 1`; `--profile <dir>` pins one. Note Arc nests profiles one
  level deeper (`Arc/User Data/<Profile>`), and all Google Chrome channels share the single
  `Chrome Safe Storage` Keychain account, so `BrowserSpec.label` carries the display name separately.

On startup with no session, `provisionFromEnvIfNeeded` establishes one from env (cookie first, else
email/password). The session is stored at `~/.forkable-mcp/session.json` (mode `0600`, never logged); the
client mints CSRF on demand, persists rotated cookies, and a ~20-min keepalive keeps it warm. On a `401`:
if `FORKABLE_EMAIL`/`FORKABLE_PASSWORD` are set, `guard()` **auto-relogins and retries once** (self-healing);
otherwise it returns a re-auth message (a pasted cookie can't be refreshed without a browser).

## Write safety (preview-then-token)

Write tools are dry-run by default. A call returns the exact mutation, the resolved variables, a summary,
and an HMAC `confirmToken` bound to a canonical serialization of the payload — **nothing is sent**.
Calling the tool again with that token re-derives the HMAC over the payload rebuilt from live data and
sends only on a match, so any drift (the piece being replaced, the menu, the selection) invalidates it.

Guards attached to a preview are advisory — Forkable enforces its own policy and reports refusals with
structured codes. Only two things refuse to mint a token, and neither is Forkable's rule: the operator's
own `FORKABLE_MAX_TOTAL` ceiling, and a malformed `selectionsHash` (our bug). See Guards below.

## selectionsHash

The customization payload for a meal item — keyed by modifier id → array of selected option ids:

- single-select modifier (`max === 1 && options.length > 1`): `[optionId]`, or `[-1]` when a
  non-required single-select has nothing chosen
- multi-select: the array of chosen option ids
- key order follows the item's `modifierIds` (stable + diffable)

Required modifiers default to the first diet-safe option. `set_meal` includes hidden modifiers so their
defaults are still sent. Item ids are **not** unique across a delivery's menus, so items are always
resolved by `(menuId, itemId)`.

## Money & dates

Money units are **mixed**, so check which side a field is on before formatting it:

- **dollars** (floats) — `MenuItem.price`, `MenuOption.price`, `Piece.price`, `Delivery.copayAmount`,
  `userReceipt.subtotal/due/copayAmount`. Everything we render, via `formatMoney`.
- **cents** (integers) — `Order.total` (`66759` = $667.59), `Order.serviceFee`, `tally[].value`.
  Company-wide figures with no per-person meaning. Deliberately **not selected**, so nothing
  cents-valued can reach `formatMoney`; don't add them back without a cents-aware formatter.

(`MenuOption.price` was commented "cents" for a while. It is dollars — verified across four venues,
where add-ons come back as `2.5` / `3.99` / `7.95`. `Menu.optionSets[].price`, the fallback used when
an option carries no price of its own, is also dollars.)

`Order.total` / `serviceFee` / `tally[].value` are cents on the wire — but that rests on a single
observation (`total: 66759` against a ~$667 order) and nothing renders them, so they are **not
selected**. Don't add them back without confirming the unit first.

**`myDeliveries` takes `from` AND `to`** — always pass both. `from` alone is week-bucketed: it returns
the calendar week containing `from`, so last Monday yields nothing (measured: Mon Aug 10 → 5, Sat Aug 8
→ 0, previous Mon → 0). Adding `to` switches it to a true inclusive range — `{from: Aug 3, to: Aug 24}`
returns all five Aug 10–14 deliveries where `from: Aug 3` alone returned zero.
`guestLinkRequestableOnly` is a third accepted argument. `list_deliveries` defaults to the
local calendar day
(`todayLocal`, avoiding a UTC off-by-one near midnight) and both tools pass a `to` as well via
`dateOffsetLocal`, so neither depends on week boundaries.

Forkable's timestamps come in **three families**, and a trailing `Z` does not tell you which:

- **True offset** — `etaStatus.start/end`, `dropoff.pickupWindowInfo.*`:
  `"2026-08-10T11:45:00-07:00"`. A real instant, rendered by slicing.
- **Honest UTC** — `dropoffCompletedAt`, `reportMissingItemCutoff` (and `venuePickup.pickupAt`, which we
  don't select). Verified: `dropoffCompletedAt: 18:41:44.000Z` lines up exactly with
  `etaStatus.end: 11:50:00-07:00`. Display these through **`formatInstantIn`**, using the club's real
  IANA zone from `club.market.timezone`; `formatInstantLike` (which borrows an offset off a sibling
  field) is the fallback for clubs that expose no zone. Never
  `parseFloating`, which would strip the `Z` and re-read the value as host-local.
- **Floating local, mislabelled UTC** — `forDeliveryAt`: `"2026-08-11T12:01:00.000Z"` means noon
  local, not 5:01 AM Pacific. Honoring that `Z` shifts the instant and, far enough east, the date.

Which family a field belongs to is knowledge, not inference — the API ships no timezone anywhere, only
offsets and a `shortTz` display label like `"PT"`. `reportMissingItemCutoff` is rendered as a clock (1 PM local, not 8 PM) — that reading is inferred from
how the product itself displays it, not proven, so the raw ISO stays in `structuredContent` too.

`parseFloating` passes a real `±HH:MM` straight to `Date` (whose offset-less date-time parsing is
already local, per spec), strips a lying `Z`, and pins `T00:00:00` onto date-only strings, which would
otherwise parse as UTC. It's only for comparing against the clock (`isPast`) — **display needs almost
no `Date`**: `formatDateTime` slices the leading `YYYY-MM-DDTHH:MM`, which already is the wall
clock to show, in the offset Forkable sent, and keeps output identical on every host. `formatDay` /
`weekdayOf` emit the weekday themselves because callers were re-deriving it from bare `YYYY-MM-DD` and
getting it wrong.

Honest-UTC instants are the exception, since they carry no wall clock to slice. `formatInstantIn` uses
`Intl.DateTimeFormat` with an **explicit** `timeZone` — host-independent precisely because the zone is
named, and DST-correct by construction. `formatInstantLike` is the fallback when no zone is available:
it does the calendar arithmetic by hand and reads the result back through `getUTC*` only, so it stays
host-independent — the invariant this module protects is host-independence, not "never touch `Date`".
`bun run test:tz` re-runs the suite under `TZ=Asia/Kolkata` to keep that honest.

## One order per venue

A delivery carries **one `Order` per venue** — four on the observed account — and your pieces sit on
exactly one of them, at an index that **moves day to day**. Never index into `orders`:

- `findOwnMeal(d)` — your order + its pieces, flagging `ambiguous` when several carry pieces (a guest
  order); that raises a `multiple_own_orders` **warn**, never a block.
- `orderForGuards(d, menuId?)` — what a guard reads counters off. When `menuId` is given (a select)
  the order **selling that menu** wins: capacity and the late-order budget belong to the venue you're
  JOINING, which is not your current one on a cross-venue switch. Without a `menuId`
  (remove/skip/confirm) your own order wins. Falls back to the sole order if there's only one, and
  otherwise to `undefined` rather than `orders[0]` — an arbitrary venue's `lateOrdersRemaining` is
  worse than none, since delivery-level gates still apply.
- `allPieces(d)` — flattens every order, for **display** only (shows guest picks too).
- `ownPieces(d, userId)` — every piece the member owns, across venues.

A member can legitimately hold meals at **several venues on one day** (an extra meal, unless the club
caps it), so `findOwnMeal` returns `orders[]` — all of them, primary first — and `ambiguous` means
"more than one venue today", not "something is wrong". A write acts on the primary; `skip_delivery`
refuses outright when there's more than one and points at `remove_meal`.

Two consequences worth holding onto:

- **A write touches TWO orders.** `replacePiece` removes your piece from the source venue's order and
  adds one to the target's, so `evaluateGuards` takes both (`order` = target, `sourceOrder`) and a
  refusal on either blocks. `pastLateOrderDeadline` is rolled up across *all* orders, matching
  `deliveryWindow()`, so the deadline gate survives even when no specific order resolves.
- **Pass `userId` to `findOwnMeal` on any write path.** Without it, it is only "first order with
  pieces" — on a delivery carrying a guest order that can resolve to someone else's meal and hand
  `replacePiece` the wrong `oldPieceId`. `set_meal` fetches `me` first for exactly this reason.

Per-order counters really do diverge: on one day `orders[0]` reported `lateOrdersRemaining: 0` while
the user's own order reported `6`.

## Allowances (the limit is not always daily)

`allowanceType` is one of `daily` | `weekly` | `weekly_by_day`, and it decides which field carries the
company's coverage. `delivery.copayAmount` is the **daily** figure and is only the answer on a daily
club; a weekly club's budget is `weeklyAllowance` (the cap) and `weeklyAllowanceAvailable` (what's
left). `allowanceFor(delivery)` folds this into `{kind, limit, label}` and everything that renders or
compares money goes through it — never read `copayAmount` directly, and never print the word "daily"
unless `allowanceType` says so.

`weeklyAllowanceAvailable` reads **0 on a daily club**, so it is only consulted when the club really is
weekly. A null/zero limit means "unknown" and must stay silent rather than warn.

**The entitlement lives on the receipt.** `userReceipt.clubCopay` is *this member's* allowance for
*this delivery*, and `allowanceFor` prefers it over the club-level `copayAmount` in the daily and
unknown branches. A **present** `clubCopay` wins outright, `0` included: zero means "unknown, stay
silent" for a club-wide field, but a per-member receipt reporting 0 is a real answer (this member
isn't covered today), and falling back to the club's figure would promise coverage they don't have —
the exact per-member case the field exists to get right. Zero still resolves to a null limit, so we
say nothing rather than claiming $0.00. The app does the same, only falling
back to a club lookup keyed by user and weekday — so `clubCopay` is the field that survives per-member
and per-weekday allowances a single club field can't express. On the club this was measured against
the two agree ($20), so it changed no output there; the fallback matters because `userReceipt.id` is
null before a receipt exists (the figures are still populated).

**`userReceipt.copayAmount` is the copay APPLIED, not the cap** — measured 14.95 / 18.99 / 20 against
a `clubCopay` of 20, i.e. `min(subtotal, entitlement)`. Reading it as the limit would silently shrink
the allowance to whatever was last ordered. Nothing renders it; it stays selected only so the two
can't be confused. `isCopay`, `clubCoversAllFees`, `subtotal`, `feesTotal` and `fees` are also
unrendered — a member doesn't need the spend breakdown.

`club.allowanceMealLimit` is a **boolean** — "the company covers one meal a day", not a count. It
deliberately does not feed the spend guard: every `set_meal` REPLACES a piece rather than adding one,
so a write never turns a first meal into a second. `get_profile` reports the policy instead.

Auto-order has **no user-level override** — `User.disableAutoOrder` doesn't exist. The effective state
is `me.mealClubAutoOrder && !clubs.some(c => c.disableAutoOrder)`; a club that forbids auto-order means
the member must confirm every delivery or receive nothing, whatever their own flag says.

## Family-style service

`forFamily` / `forBuffet` on the delivery, `familyHub` on the club and on any order's venue: any of
them means the meal is shared, and a per-member change request is never offered. `isFamilyStyle()`
folds the four, and `deliveryWindow()` suppresses **only** the change-request source of `grace` — a
remaining late-order budget is a separate affordance and still counts. `forFamily` is nullable, so test
truthiness rather than `=== false`.

## Meal groups (dropoff groups)

`Piece.group` is the dropoff group a meal is bagged into — a **String** like `"A1"`, which the app
badges as *"This meal is in Group A1"*. It's assigned when the delivery is grouped, so it's null on
a future delivery (measured: today's piece carried `"A1"`, tomorrow's `null`), and the app only
shows the badge on an ordered-or-delivered, read-only meal. It's in the shared `PIECE_CORE`, so both
`get_delivery_status` and `list_deliveries` render it — a member scanning the list wants to know
where to collect lunch, and it costs one scalar. The label alone is rendered; that's all the app
shows, and all a member needs to find their food.

The group is per **piece**, not per delivery: a member can hold two meals in different groups, so it
hangs off each dish rather than the delivery line. That matches the app, whose member path is
literally `pieces.map(p => p.group)`.

`Order.mealGroups` (`{label, value}[]`) is the **admin** roster of every group at that venue, and is
deliberately **not selected**:

- It's gated on `order.isSplitted` in the app's admin branch — and `isSplitted` was `false` on all
  four venues of every observed delivery, while pieces still carried groups. The member branch
  ignores `mealGroups` entirely and rebuilds it from its own pieces.
- **`value` has no established meaning.** Nothing in the app ever reads it — only `label`, via
  `formatMealGroupRange`. The member branch even fabricates `{label: g, value: 1}` from a piece and
  throws the real value away. Observed values (12, 11, 7, 1…) *look* like meal counts, but that's a
  guess; don't render it without confirming, and don't assume it's money either.

Labels observed run `A1`–`A8`, plus a starred `A8*` whose meaning is unknown.

## Per-piece state (modelled from the app, not observed)

Five per-meal fields the delivery-level flags can't express. All are in `PIECE_CORE` and render as
trailing badges through the shared `pieceBadges()` in `format.ts`, beside `groupSuffix`:

| field | badge | meaning |
|---|---|---|
| `isConfirmed` | `not confirmed` | Per-MEAL confirmation, finer than `delivery.userConfirmed`. |
| `isRemoval` + `requestStatus: "pending"` | `cancellation requested` | Both must agree; the app shows "PENDING". |
| `isLateSwappable` | `still swappable` | The app offers "Choose Another Meal" **even on a read-only delivery**. |
| `isLateOrder` | `late order` | Placed after the cutoff, against the monthly budget. |

They render as **one bracketed group**, `·`-separated — `Maki — Nara Sushi — group A2 [not confirmed ·
still swappable]` — not as more em-dash segments. The dash is already the structural separator for a
dish's parts, so stacking state onto it produced one flat run with no visible boundary between fact
and state, and it collapsed entirely against the list's comma-joined dishes. Keep badges terse: the
consequence of `not confirmed` is a **footnote** under the status view (`an unconfirmed meal is not
ordered — confirm_delivery to lock it in`), in the same style as the attribution notes.

Every one is **nullable**, and `null` means "not reported" — never false. `pieceBadges` therefore
tests `=== false` / `=== true` rather than falsiness: a `null` `isConfirmed` rendering as "not
confirmed" would tell a member their lunch isn't coming when we simply don't know. On the account
these were modelled against, all of them read null/false except `isConfirmed: true`, so **the
rendering is unobserved** — same footing as `sibling_replacement_pending`. Verify against a real
pending cancellation before trusting a combination.

`cancellationPending()` folds the `isRemoval`/`requestStatus` pair, and `pieceBadges` accepts either
that folded flag or the raw pair, so the view models and a raw `Piece` share one code path.

## Fulfillment progress

`etaStatus.status` is a **closed three-value enum** — `delayed` | `ontime` | `delivered` — not free
text. `delayed` is the only value worth acting on, so both renderers shout `⚠ DELAYED` rather than
passing the lowercase word through, and the list line hands over `etaStatus.trackingUrl` (which is why
that field is in the lean selection too). The app does the same, promoting "Track Order" on a delay.

`Order.replacementCutoffTs` means *the restaurant cancelled and your meal is being replaced; re-pick
before this*. `formatCountdown` renders the time left ("2h 14m", rounded up so a 30-second window
still reads "1m") and nothing once elapsed — which is where the app lands too, since it flips the
delivery to read-only the moment its own timer hits zero. `replacementCutoffRaw` still reports the
cutoff after it elapses, so a caller can tell "the window closed" from "no replacement at all".

It is read across **every** order the member holds, soonest open window first and sorted by instant
rather than lexically (`…T20:14:00Z` and `…T13:30:00-07:00` are the same moment but sort differently as
strings). Reading `orders[0]` would render a second venue's dish and say nothing about its cancellation
— the same trap `group` avoids by being per piece.

**Its timestamp family is unproven** — it read null on every delivery observed, so there was nothing to
measure. The app does `DateTime.fromISO(ts).diffNow()`, i.e. treats it as a true instant and honours a
`Z`, and we follow the app: `new Date`, never `parseFloating` (which would strip the `Z` and re-read it
as host-local). That reading **requires** an explicit `Z` or `±HH:MM`, like `utcInstant`: an offset-less
value has no instant to count down to, and `new Date` would silently make the same wire value render
differently per host — a break `bun run test:tz` can't catch, since every fixture we can write carries
an offset. An unexpected format omits the line instead.

Two adjacent surfaces are deliberately **not** selected. `dropoff.onfleetPhotoUploadUrls` is verified
live (5–6 courier drop-off photos per order, and the same URLs repeat across orders sharing a route)
but isn't wanted. `venueUsage(ids:, from:, to:)` — a root query returning JSON,
`usage[venueId][date] = {am, pm}`, keyed `am`/`pm` by `delivery.afternoon` — gives per-venue seats
taken to compare against `venue.capacity`; `get_menus` instead marks `[venue at capacity]` from the
`isOverVenueCapacity` we already fetch, which needs no extra round trip. That render copies both of
the guard's rules: only the order actually SELLING the menu counts (never the `orderForGuards`
fallback, which would blame one menu for another venue's crowd), and a venue you already hold a meal
at is never full. `atCapacity` is `boolean | null` and a menu with no order on the delivery is
**null, not false** — claiming a seat is free on the strength of a missing order is the one wrong
answer available there.

Known wrinkle, not from that render: `evaluateGuards` reads capacity off `orderForGuards(d, menuId,
userId)`, whose fallback is the member's OWN order when nothing sells `menuId`. So for a menu with no
order yet, `get_menus` correctly marks nothing while a later `set_meal` preview can warn
`over_venue_capacity` about a different venue's crowd. It's a warn on a preview the caller still
confirms, and the guard's fallback — not the new render — is the side to tighten.

`order.state` (`initial` → `preordered` observed) is a **different lifecycle** from `delivery.state`
(`initial` → `grace_period` → `receipt_sent`) and is read nowhere in `src/`. Related: the app
substitutes `order.replaces` whenever `order.state === "hidden"`, so mid-replacement it shows a
different order than the raw list does. `findOwnMeal` does **not** model that — no hidden order has
been observed, and every write path depends on that resolution, so it stays as-is until there's
something real to test against.

## Late orders: the constants are the app's, not the API's

There is no deadline field (see Write windows), and the numbers in those messages come from the app's
**build-time env**, proved in the shipped bundle: `VUE_APP_LATE_ORDERS_CUTOFF_TIME: "09:00"` and
`VUE_APP_LATE_ORDERS_MAX_PER_MONTH: "6"`. That upgrades "the monthly allowance appears to be 6" to the
product's actual constant — though it's a client build value, so a different deployment could differ.
`me.remainingLateOrdersMonthOf` (6, matching) is what `get_profile` reports; the app calls them
"Last-Call Passes".

`me.roles` is **not** a list of roles: it's a JSON scalar carrying the app's ~60 internal feature flags
(`{features: ["late_removal", "disable_auto_order", "mc/report_issue", …]}`). It was selected and typed
`string[]`, so `me.roles?.length` was always undefined and `get_profile`'s roles line never rendered
once. Deliberately dropped rather than fixed — none of it is member-facing, and the capabilities that
matter come from the club/user flags. Don't reintroduce it expecting role names.

`warningDetails[].amount` is **CENTS** — the app renders `amount / 100` on `exceeded_allowance` — while
every other money field we touch is dollars. Nothing renders it today (`MutationError` only maps
`errorDetails.base[].error` codes to help text), so this is a trap for later, not a live bug. Note the
asymmetry: the code lives in `errorDetails`, the amount in `warningDetails`.

## Identity travels with deliveries

A delivery carries one order per venue and may carry **other members'** orders. `loadDeliveries`
therefore returns `{deliveries, userId}`, taking `me { id }` as a second root in the same document —
identity costs no extra request. Every renderer takes that `userId`.

`findOwnMeal(d, userId)` matches pieces by owner and returns **`undefined`** when none match — it
never falls back to "first order with pieces", because that fallback is exactly how a colleague's meal
became the member's: it supplied the courier ETA, arrival time and tracking link, and would hand
`replacePiece` the wrong `oldPieceId`. Called without a `userId` it still means "whoever ordered", and
`byIdentity` (surfaced as `attributed`) records which of the two you got — when false, don't call the
meal "yours". `remove_meal` also refuses a piece owned by someone else.

`club.hidePrices` is a display preference for Forkable's own dashboard, not an access control — the API
returns prices to the member either way. We deliberately do **not** honor it: the caller *is* the member,
and suppressing prices would also have to suppress the `over_company_limit` warn and the
`FORKABLE_MAX_TOTAL` cap, which are the parts of the write gate worth having. `get_profile` reports the
flag so you know the dashboard hides them.

`Menu.modifiers[].free` is a **boolean** mirroring "all of this modifier's options cost $0" — not an
included-selections allowance. Checked across 233 modifiers on four menus: `free: true` never coexists
with a priced option, so summing every chosen option's price is correct.

`Piece.autoOrder` means **the member's account is on auto-order** — meals are ordered without per-meal
confirmation — not "Forkable picked this dish". Settled twice: a live replace-and-revert left it `true`
on a piece created by an explicit `replacePiece`. It mirrors the account-level `me.mealClubAutoOrder`,
which `get_profile` reports directly — that's the field to trust. With auto-order OFF a member must
confirm each delivery or it isn't ordered, which is what makes `confirm_delivery` load-bearing.
`Piece.autoOrder` is passed through raw; nothing renders it, and nothing should infer who chose a meal.

Write payloads differ per mutation. `addPiece`/`replacePiece` return `errors errorDetails
warningDetails`, and the structured codes there (`venue_capacity_overage`, `exceeded_allowance`,
`below_event_order_minimum_cents`) are what `MutationError` turns into a readable message — a refusal
can arrive with an EMPTY `errors` array and the reason only in `errorDetails`, so both are checked.

`removePiece` must stay on plain `errors`: `errorDetails`/`warningDetails` exist on its payload (an
unknown field there returns a clean validation error; these don't) but requesting them returns a **503**.
`confirmDelivery` accepts `errorDetails` and returns it empty. Don't widen either.

## Write windows (two gates, not one)

**There is no member-facing deadline field.** `editingCutoffAt` looks like one and isn't — it carries
buffet/Events semantics, and a Friday delivery was observed carrying a Tuesday cutoff while still
accepting a removal hours later. **It is no longer selected at all.** Never reintroduce it as a deadline.

The real deadline is **fixed policy**, not a field: order until 2pm the day before delivery, with late
orders until 9am on the day. The monthly late-order allowance appears to be 6 (that's the
`lateOrdersRemaining` we observe, not a documented constant). Decide with the booleans:

1. `isReadOnly` — the delivery is locked to normal editing. This is what actually closes a day.
2. `pastLateOrderDeadline` — strictly later, after which even a late order or change request is
   refused. This is the gate that decides whether a *late* write is still possible.

No per-venue or per-weekday lead time exists — the odd Friday value is just buffet semantics leaking
onto every Delivery.

**Guards advise; they don't re-enforce.** Forkable owns this policy and reports refusals with
structured codes, so nearly every guard is a `warn` attached to a preview the caller still has to
confirm. Blocking on our reading of another company's rules is how you refuse a write the server would
have accepted — and the model is only ever as good as the one club it was written against.

Exactly two codes still `block`, and neither is Forkable's call: `over_total_ceiling` (the operator's
own `FORKABLE_MAX_TOTAL`) and `selection_invalid` (the `selectionsHash` *we* build is malformed —
our bug). Everything else — `delivery_read_only`, `menu_not_available`, `over_venue_capacity`,
`change_request_not_allowed`, `no_late_orders_remaining`, `no_late_removals_remaining`,
`late_removal_disabled`, `diet_conflict`, `past_late_order_deadline`, `over_company_limit`,
`no_credit_card`, `multiple_own_orders`, `no_monthly_late_orders`, `change_request_pending`,
`sibling_replacement_pending`, `instructions_not_supported` — is advisory.

Three gates are deliberately *looser* than they look:

- A venue with `order.replaces` pointing at a still-offered menu re-opens: `isReadOnly` and an exhausted
  `lateOrdersRemaining` are both bypassed there.
- A delivery still in `state: "initial"` accepts a removal past the late deadline.
- Capacity never blocks the venue you already hold — re-customizing isn't a new seat.

And one is looser than it should be: a pending `replaces` on a *sibling* order, or any piece with
`flowType: "late_replacement"`, freezes every meal on the delivery. We raise
`sibling_replacement_pending` as a **warn** because that behavior is modelled, not yet observed live;
promote it to a block once seen.

Between them sits a grace period (`state: "grace_period"`, `canRequestChanges: true`) where the
delivery reads as locked but a change request still lands. `Delivery.canRequestChanges` is *false* on a
normally-open delivery — it's the grace-period affordance, not a general "can I edit" flag. Note this
does **not** hold for the order-level `Order.changeRequestAllowed`, which is `true` on normally-open
days; they are different flags and `deliveryWindow()` ORs them. `grace` also arises from a third
signal the flags don't cover: any order with `lateOrdersRemaining > 0`.

`deliveryWindow()` folds all of this into `open` | `grace` | `closed`; tools should surface and branch
on that rather than comparing the cutoff to the clock.

`state` (ordering lifecycle: `initial` → `grace_period` → `receipt_sent`) is orthogonal to
`simpleState` (fulfillment: `delivered`). A delivery reads `grace_period` / `delivered` at once, and
`simpleState` is `null` until delivered — so it's a *fallback* for `state` in a status label, never a
replacement. The whole tracking surface (`etaStatus`, `dropoff*`, `reportMissingItemCutoff`,
`simpleState`) is null before dispatch, which is why `get_delivery_status` has a defined
"not yet dispatched" shape.

## Environment variables

| Variable | Purpose |
|---|---|
| `FORKABLE_EMAIL` / `FORKABLE_PASSWORD` | Headless email/password login; also enables auto-relogin on 401. |
| `FORKABLE_MFA` | Optional MFA code for password login. |
| `FORKABLE_COOKIE` | Headless auth: a full Cookie header, provisioned on startup if no session exists. |
| `FORKABLE_CSRF` | Optional CSRF token to pin (otherwise fetched automatically). |
| `FORKABLE_MAX_TOTAL` | Optional hard spend cap (dollars): a write over it is refused. Unset = no cap (preview just notes when over the company's daily limit, `delivery.copayAmount`). |
| `FORKABLE_WRITE_SECRET` | Optional HMAC key for confirm-tokens (else a per-install key is generated and stored). |
| `FORKABLE_MCP_HOME` | Session store directory (default `~/.forkable-mcp`). |

## Development

```bash
bun test          # unit tests (selectionsHash, confirm-token, guards, own-order resolution,
                  #   date/zone formatting, status renderer, serializer, crypto)
bun run test:tz   # the same suite under TZ=Asia/Kolkata — display must be host-zone independent
bun run check     # oxlint + oxfmt --check + tsc + both test runs
bun run fmt       # oxfmt src tests scripts
bun run smoke     # pack → install the tarball into a scratch project → drive the installed binary
```

`check` only ever sees the source tree, so it can't catch a `files` allowlist gap or an import that
stops resolving once installed — `scripts/smoke.ts` covers that, and CI runs it alongside `check` and
again before publishing. It needs no credentials: the server starts without a session, and the client
transport's default env excludes `FORKABLE_*`. Keep `scripts/` inside the tsconfig `include`, or the
editor falls back to an inferred project and floods the file with resolution errors.

Conventions: delivery-scoped tools take `deliveryId` first; reads are `get_/list_/search_/recommend_/
explain_`, writes are `set_/remove_/skip_/confirm_`, and every write takes an optional `confirmToken`.
TypeScript 7 strict, 2-space indent, kebab-case filenames, snake_case tool names.
