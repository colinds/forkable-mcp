// Domain types (only the fields our v0 tools touch).

export interface MenuOption {
  id: number;
  name: string;
  price?: number | null; // dollars (verified: add-ons come back 2.5 / 3.99 / 7.95)
  ingredientTags?: string[];
}

export interface MenuModifier {
  id: number;
  name?: string;
  display?: string;
  optionSetId?: number | null;
  min?: number | null;
  max?: number | null;
  required?: boolean;
  hidden?: boolean;
  options: MenuOption[];
}

export interface MenuItem {
  id: number;
  menuId: number;
  name: string;
  description?: string;
  price?: number; // dollars
  imageUrl?: string;
  ingredientTags?: string[];
  dietLevel?: number;
  modifierIds?: number[];
  modifiers?: MenuModifier[];
}

export interface MenuSection {
  id: number;
  name?: string;
  description?: string;
  items: MenuItem[];
}

export interface Menu {
  id: number;
  name?: string;
  displayName?: string;
  sections: MenuSection[];
  /** Option price fallback. Unit UNVERIFIED — never seen populated; assumed dollars. */
  optionSets?: { id: number; price?: number | null }[];
  /** This venue takes no custom notes; `instructions` sent anyway are dropped. */
  disableSpecialInstructions?: boolean;
  venue?: { id: number; name?: string; capacity?: number; familyHub?: boolean };
}

export interface Piece {
  id: string | number; // piece ids are UUID strings in practice
  itemId: number;
  menuId: number;
  userId?: number; // whose meal — required to tell your piece from a guest's
  name?: string;
  state?: string;
  autoOrder?: boolean; // the MEMBER is on auto-order (no per-meal confirm) — not "who picked this"
  /** `"late_replacement"` on any piece freezes every meal on the delivery. */
  flowType?: string;
  /** Pre-rendered customization labels — cheaper than decoding `selections`. */
  nonHiddenAttributes?: PieceAttribute[];
  instructions?: string;
  price?: number; // dollars
  selections?: SelectionsHash | null; // stored hash on an existing piece
}

/** Live courier state. Null until dispatched. */
export interface EtaStatus {
  start?: string; // true offset — the delivery's zone source
  end?: string;
  shortTz?: string; // display label, e.g. "PT"
  status?: string; // e.g. "delivered"
  trackingUrl?: string;
}

export interface Dropoff {
  id: string | number;
  route?: { courierId?: string | number | null; date?: string };
  pickupWindowInfo?: { windowStart?: string; windowEnd?: string }; // TRUE offsets
}

export interface OrderVenue {
  id: number;
  name?: string;
  displayName?: string;
  capacity?: number;
  /** Family-style venue: meals are shared, so a per-member change request never applies. */
  familyHub?: boolean;
}

export interface PieceAttribute {
  label?: string;
  value?: string;
}

export interface ReportedIssue {
  id: string | number;
  type?: string;
  resolution?: string;
  requestReOrder?: boolean;
  requestRefund?: boolean;
  requestGiftCard?: boolean;
  orders?: { id: string | number }[];
  pieces?: { id: string | number }[];
}

/**
 * One order per VENUE, not per person. Your pieces sit on exactly one, at an index that moves day
 * to day — resolve it with `findOwnMeal`/`orderForGuards`, never by indexing.
 *
 * `total`/`serviceFee`/`tally` are company-wide CENTS on the wire; left unselected and untyped so
 * nothing cents-valued can reach `formatMoney`.
 */
export interface Order {
  id: string | number;
  state?: string;
  isOverVenueCapacity?: boolean;
  lateOrdersRemaining?: number;
  lateGuestOrdersRemaining?: number;
  lateRemovalsRemaining?: number;
  changeRequestAllowed?: boolean;
  pastLateOrderDeadline?: boolean;
  hasVenueLateOrdersRemaining?: boolean;
  hasChangeRequest?: boolean;
  /** The order this one replaces. Its presence unlocks a late order here AND freezes siblings. */
  replaces?: { id: string | number; menu?: { id: number } };
  replacementCutoffTs?: string;
  isNextStepsAble?: boolean;
  isReorderable?: boolean;
  menu?: { id: number; name?: string };
  pieces?: Piece[];
  venue?: OrderVenue;
  etaStatus?: EtaStatus;
  dropoffCompletedAt?: string; // HONEST UTC — display via formatInstantLike, never parseFloating
  dropoff?: Dropoff;
}

/** Scheduled service slot, e.g. `{baseTime: "12:00:00", name: "lunch"}`. */
export interface ServiceWindow {
  baseTime?: string;
  name?: string;
}

export interface DeliveryAddress {
  street?: string;
  city?: string;
  postalCode?: string;
  formatted?: string;
  notes?: string; // building-access instructions
}

export interface Delivery {
  id: number;
  state?: string; // ordering lifecycle: "initial" | "grace_period" | "receipt_sent" | …
  /** Fulfillment track, orthogonal to `state`. Null until delivered, so use as a fallback. */
  simpleState?: string;
  forDeliveryAt?: string; // floating local mislabelled UTC — see parseFloating
  isReadOnly?: boolean;
  userConfirmed?: boolean;
  /** The DAILY company limit. Only meaningful when `allowanceType` is "daily" — see allowanceFor. */
  copayAmount?: number; // dollars
  availableMenuIds?: number[];
  pastLateOrderDeadline?: boolean;
  canRequestChanges?: boolean;
  /** "daily" | "weekly" | "weekly_by_day" — which of the allowance fields actually applies. */
  allowanceType?: string;
  weeklyAllowance?: number; // dollars; the weekly cap
  weeklyAllowanceAvailable?: number; // dollars; what's left of it. Reads 0 on a daily club.
  /** Family-style service: meals are shared, so per-member change requests don't apply. Nullable. */
  forFamily?: boolean | null;
  forBuffet?: boolean | null;
  deliveryWindow?: string[]; // ["11:45","12:15"] — wall clock, no date, no zone
  serviceWindow?: ServiceWindow;
  /** Missing-item deadline. Read as honest UTC (inferred, not proven) — rendered, but never gated on. */
  reportMissingItemCutoff?: string;
  address?: DeliveryAddress;
  notes?: string; // duplicate of address.notes
  club?: {
    id: number;
    name?: string;
    /** Boolean: the company covers ONE meal a day. Not a count. */
    allowanceMealLimit?: boolean;
    allowanceType?: string;
    familyHub?: boolean;
    isLateRemovalEnabled?: boolean;
    market?: { timezone?: string; currencySettings?: { currency?: string } };
  };
  orders?: Order[];
  myReportedIssues?: ReportedIssue[];
  userReceipt?: {
    id: number;
    due?: number;
    copayAmount?: number;
    subtotal?: number;
    feesTotal?: number;
    fees?: { type?: string; fee?: number }[];
  }; // all dollars
}

export type SelectionsHash = Record<string, number[]>;
