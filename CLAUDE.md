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
sends only on a match, so any drift (price, cutoff, the piece being replaced) invalidates it. Blocking
guards (past cutoff, over capacity, a required modifier missing, no late orders left) never mint a token.

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

`Menu.modifiers[].free` is a **boolean** mirroring "all of this modifier's options cost $0" — not an
included-selections allowance. Checked across 233 modifiers on four menus: `free: true` never coexists
with a priced option, so summing every chosen option's price is correct.

`Piece.autoOrder` means **the member's account is on auto-order** — meals are ordered without per-meal
confirmation — not "Forkable picked this dish". Settled twice: a live replace-and-revert left it `true`
on a piece created by an explicit `replacePiece`. It mirrors the account-level `me.mealClubAutoOrder`,
which `get_profile` reports directly — that's the field to trust. With auto-order OFF a member must
confirm each delivery or it isn't ordered, which is what makes `confirm_delivery` load-bearing.
`Piece.autoOrder` is passed through raw; nothing renders it, and nothing should infer who chose a meal.

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

Careful: gate 1 blocks too. `evaluateGuards` pushes `delivery_read_only` at `level: "block"` whenever
`isReadOnly` is set, so a delivery `deliveryWindow()` classifies as `grace` can still be hard-blocked.
Other blocking codes: `menu_not_available`, `selection_invalid`, `over_total_ceiling`,
`change_request_not_allowed`, `no_late_orders_remaining`, `no_late_removals_remaining`,
`late_removal_disabled`. Warn-only: `past_late_order_deadline`, `over_company_limit`, `no_credit_card`,
`multiple_own_orders`, `no_monthly_late_orders`, `change_request_pending`,
`sibling_replacement_pending`.

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
bun run fmt       # oxfmt src tests
```

Conventions: delivery-scoped tools take `deliveryId` first; reads are `get_/list_/search_/recommend_/
explain_`, writes are `set_/remove_/skip_/confirm_`, and every write takes an optional `confirmToken`.
TypeScript 7 strict, 2-space indent, kebab-case filenames, snake_case tool names.
