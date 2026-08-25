# CLAUDE.md

Development guidance for **forkable-mcp**. User setup belongs in [README.md](./README.md); this file
records implementation contracts that coding agents must preserve.

## Runtime and layout

This is a Bun + TypeScript MCP server. The MCP client spawns it over stdio and owns its lifecycle.
There is no HTTP server.

```text
src/
  index.ts        CLI entry point
  server.ts       stdio lifecycle and keepalive
  tools.ts        MCP tools and Forkable request construction
  write-gate.ts   preview, confirmation, and mutation recovery
  net/            GraphQL transport and error mapping
  auth/           login, browser-cookie ingest, and session storage
  order/          domain types, selections, local guards, formatting, and status
tests/            Bun tests
scripts/smoke.ts  packed-install smoke test
```

The only durable runtime state is `~/.forkable-mcp/session.json` (or
`FORKABLE_MCP_HOME/session.json`). Pending confirmations are process-local and disappear on restart.

Keep one current MCP contract. Do not add legacy argument aliases, confirmation formats, session
migrations, or response shims without a demonstrated need; agents can re-read tool schemas and
adapt.

## Authentication and session state

Forkable uses a Cookie header and CSRF token, not an API key. Sessions can come from email/password,
an imported browser cookie, `FORKABLE_COOKIE`, or an auth file/stdin. Browser import uses
`@steipete/sweet-cookie` on macOS, Linux, and Windows; Arc targeting is macOS-only, and Brave or
Chromium on Linux or Windows may require an explicit profile path. Password input must remain hidden
(`--password-stdin` or environment); never print credentials.

Session invariants:

- The store directory is mode `0700`; the session file is atomically written with mode `0600`.
- A usable session must contain a nonempty `_easyorder_session` cookie.
- `Set-Cookie` response deltas are merged into the latest stored Cookie header. Do not persist a
  client's full stale jar over newer rotations.
- In-process session writes are serialized. Cookie expiry and `Max-Age` are handled by
  `auth/cookies.ts`.
- CSRF and cookie persistence failure is nonfatal after the in-memory client has accepted the
  response; emit a concise stderr warning and do not replay a mutation.
- `delegationSessionId: null` is meaningful and must clear delegation rather than preserve an older
  value.
- Redacted logging may include lengths and metadata, never cookie, CSRF, password, or confirmation
  token contents.

With `FORKABLE_EMAIL` and `FORKABLE_PASSWORD`, a `401` can trigger one login recovery. A confirmed
write token is already single-use at execution time, so recovery must not silently resend the
mutation; the caller receives a fresh preview when confirmation can no longer be used.

## Network safety

`ForkableClient` selects retry behavior from the method being called. Never infer operation type by
parsing GraphQL text.

- `gql`, `gqlPublic`, and `query` use the query path. A query may retry once after a transport failure
  or HTTP 5xx. Callers must use these methods only for reads; retry safety depends on that contract.
- `gqlRaw` and `mutate` use the mutation path. A mutation is never retried after a transport failure,
  redirect, HTTP 408/5xx, malformed successful response, top-level execution failure with ambiguous
  data, or missing/malformed mutation payload.
- The only mutation replay is one retry after an actual first HTTP `419`, following a fresh CSRF
  fetch. A logical `httpErrorCode: 419`, generic `422`, or other rejection is not replayed.
- Mutation redirects use `redirect: "manual"`; following a redirect would hide whether the original
  request ran.
- Requests have an abort timeout. Keep retry limits explicit when changing timeout behavior.

The error boundary is intentional:

- `MutationError` means Forkable definitely rejected the request. Preserve Relay `errors`,
  `errorDetails`, parsed `errorAttributes`, and `warningDetails`.
- `MutationOutcomeUnknownError` means the request may have run but no authoritative result arrived.
  It must remain non-retryable.
- `QueryError` represents GraphQL errors on a read.
- `ReauthRequiredError` is handled by the tool wrapper and must not be collapsed into a generic
  transport error.

Responses must be valid JSON objects with a valid GraphQL envelope. A mutation refusal can have an
empty `errors` array and carry its reason only in `errorDetails.base`; `mutate` checks both.

## Preview and confirmation

Every write tool is dry-run by default. The first call resolves an exact executable plan and returns
the user-facing summary, warnings, affected delivery ids, and a random confirmation token. Nothing
is sent. GraphQL operations, variables, and raw mutation payloads stay internal.

The gate stores a structured clone of the exact executable plan in a bounded process-local map. A
token is:

- valid for ten minutes by default;
- bound to effective user id, delegation id, tool name, and a stable hash of effective arguments;
- single-use and removed before expiry/binding checks;
- unable to survive a process restart.

A valid confirmation sends the stored plan; it does not reconstruct variables from current server
state. An unknown, expired, mismatched, or already-used token produces an error plus a fresh preview.

Structured result modes:

- `blocked`: a selection or configured-ceiling guard refused the plan; no token exists.
- `preview`: summary, warnings, delivery ids, and a confirmation token.
- `executed`: Forkable accepted the change.
- `rejected`: definite `MutationError`; correct the request before trying again.
- `outcome_unknown`: do not retry. Refresh the listed deliveries with `list_deliveries` and reconcile
  state first.

## Meal write construction

Item ids are not unique across menus. `set_meal` and `set_meal_all` require `menuId` and `itemId`, and
the selected item must match both its containing menu and its own `menuId`. Do not fall back to an
item-id-only match on a write.

A delivery can carry multiple venue orders and other members' pieces. Destructive piece operations
require positive ownership: `piece.userId` must equal the effective `me.id`.

- `set_meal` defaults to `mode: "set"`. With no `sourcePieceId`, it adds when there is no verified
  owned piece, replaces the single verified owned piece, and refuses to choose when several are
  owned.
- With `sourcePieceId`, the id must resolve uniquely on that delivery and belong to the effective
  user. It selects `oldPieceId`; it is not part of the GraphQL mutation input.
- `mode: "add"` always uses `addPiece` without resolving a source piece. It cannot be combined with
  `sourcePieceId`, and its input includes `userId` and `replacedPieceId: null` but no `oldPieceId`.
- `remove_meal` requires a unique id and positive ownership.
- `skip_delivery` operates only when exactly one owned piece can be resolved.
- `set_meal_all` deduplicates delivery ids and refuses a target day with multiple owned pieces; those
  days must be handled individually.

Never use `orders[0]`, the first piece on a delivery, or a matching venue as proof of ownership.
Read views may count other members' meals, but must not expose their dish or courier data as the
caller's.

Mutation payload selections are operation-specific. `addPiece` and `replacePiece` request
`errors errorDetails warningDetails`. `removePiece` must request only `errors`; requesting its detail
fields has returned HTTP 503. Keep `confirmDelivery` on its known selection.

`replaceAllPieces.newPiece.deliveryId` is the first target delivery id, and its payload selection is
`errors`.

## `selectionsHash`

Customization is keyed by modifier id, with arrays of option ids:

- A single-select modifier is `max === 1 && options.length > 1`. Its value is `[optionId]`, or `[-1]`
  for an explicit or default-empty optional selection.
- Other modifiers use an array of selected ids.
- Key order follows `item.modifierIds`; unlisted modifiers follow in API order.
- Write construction includes hidden modifiers so required API defaults are still sent.

String choices resolve only by a unique trimmed, case-insensitive match: modifier
`display || name`, and option `name`. Unknown, ambiguous, duplicate modifiers, and duplicate options
are blocking selection violations. Numeric ids remain the preferred unambiguous input.

Explicit emptiness is not absence. An explicitly empty optional single stays `[-1]`; an explicitly
empty required modifier violates the requirement. An absent choice may preserve stored selections or
use the API-ordered first option for a required default. Do not invent diet-aware defaults locally.

## Thin-client validation

Forkable is authoritative for availability, capacity, deadlines, allowances, card requirements, and
other business policy. Local code validates only what the client owns:

- exact request identity and shape;
- positive ownership and unambiguous source selection;
- valid customization construction;
- the operator's optional preview ceiling.

Server signals such as unavailable-menu hints, unsupported instructions, and dietary results may be
shown as warnings, but they must not become locally invented Forkable policy blocks.

Diet checking uses Forkable's `mealRestrictions` query with the final `(userId, menuId, itemId,
selectionsHash)`. It is advisory: conflicts are warnings, and an unavailable check is reported as
unchecked rather than blocking. A multi-delivery plan performs one dietary query for the common meal,
not one per delivery.

`FORKABLE_MAX_TOTAL` is a user-configured dollar amount converted to integer cents at the boundary.
Preview totals are also integer cents. If the base item price is absent or non-finite, total remains
unknown; it is not treated as zero. Unknown total blocks only when a ceiling is configured. An unset
or invalid ceiling adds no local spend block. Zero is a valid ceiling.

## Reads, status, and billing

`loadDeliveries` requests `me { id }` beside `myDeliveries` so ownership attribution costs no extra
round trip. Ownership-sensitive renderers receive that id and select only pieces whose `userId`
matches. Do not fall back to the first order when identity is absent.

`get_delivery_status` keeps one record per positively owned order, including order id, exact ETA and
arrival timestamps, and tracking URL. It also returns current meal customizations, cancellation
state, the scheduled window, and direct billing fields. The top-level fulfillment is a conservative
roll-up. Raw order and ETA state stay internal. Courier and meal data from another member must never
be attributed to the caller.

Billing output is direct wire data, not a coverage calculation. Billing values in status are exposed
as nullable integer cents:

- `reportedDueCents` from `userReceipt.due`;
- `copayAmountCents` from `delivery.copayAmount`;
- `weeklyAllowanceCents` and `weeklyAllowanceAvailableCents`;
- `memberClubCopayCents` from `userReceipt.clubCopay`.

Do not label these as company coverage or out-of-pocket cost. Their product meaning can depend on the
club and receipt state.

Useful piece fields are per piece, not per delivery. Read projections expose `group`, `isConfirmed`,
customization labels, and a derived `cancellationPending`; other UI state stays internal. Nullable
wire fields mean “not reported,” never false. `Piece.group` is a dropoff label such as `A1`. Do not
use the unrelated admin `Order.mealGroups` roster as the member's group.

## Verified wire quirks

Money units are mixed:

- Dollars: item, option, piece, delivery copay, and receipt monetary fields.
- Cents: `Order.total`, `Order.serviceFee`, `tally[].value`, and
  `warningDetails[].amount` for allowance warnings.

Do not pass cents-valued fields to `formatMoney` without dividing at an explicit boundary.
`MenuOption.price` and the `Menu.optionSets[].price` fallback are dollars.

`myDeliveries` must always receive both `from` and `to`. A bare `from` is week-bucketed rather than a
true range. `deliveryRange` is the single place that supplies bounds. It uses local calendar dates,
keeps the default horizon through at least today + 21 days, and preserves an explicit `to` so callers
can request a past-only window. `list_deliveries` refuses a backwards range and names an empty range.

Forkable timestamps have distinct families:

- `forDeliveryAt` is a floating local wall clock even though it carries `Z`; do not treat it as UTC.
- `etaStatus.start/end` carry real offsets.
- `dropoffCompletedAt` and `reportMissingItemCutoff` are UTC instants. Render them with the club's IANA
  timezone, falling back to a sibling ETA offset when no zone is available.

Keep date rendering host-independent. `bun run test:tz` exercises the suite under another host zone.

Other wire constraints:

- `etaStatus.status` values observed by the client are `delayed`, `ontime`, and `delivered`.
- `delivery.state`, `delivery.simpleState`, and `order.state` are different lifecycles; do not merge
  them into one source field.
- `me.roles` is a JSON feature-flags scalar, not a role-name array.
- `Piece.autoOrder` reflects account auto-order behavior, not who selected the meal.
- `club.hidePrices` is a Forkable display preference, not an API authorization boundary.

## Environment

| Variable                               | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| `FORKABLE_EMAIL` / `FORKABLE_PASSWORD` | Headless login and optional 401 recovery.     |
| `FORKABLE_MFA`                         | Optional MFA code.                            |
| `FORKABLE_COOKIE`                      | Full Cookie header for headless provisioning. |
| `FORKABLE_CSRF`                        | Optional initial CSRF token.                  |
| `FORKABLE_MAX_TOTAL`                   | Optional per-meal preview ceiling in dollars. |
| `FORKABLE_MCP_HOME`                    | Session-store directory.                      |

## Development

```bash
bun test
bun run test:tz
bun run check
bun run fmt
bun run smoke
```

`bun run smoke` packs the project, installs the tarball in a scratch project, and drives the installed
binary without credentials. Keep `scripts/` in the TypeScript project.

Use TypeScript strict mode, two-space indentation, kebab-case files, and snake_case tool names. Reads
use `get_`, `list_`, `search_`, `recommend_`, or `explain_`; writes use `set_`, `remove_`, `skip_`, or
`confirm_` and accept an optional `confirmToken`.
