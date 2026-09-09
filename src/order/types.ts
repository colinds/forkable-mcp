// Domain fields selected by the tools. Monetary values here are dollars.

export interface MenuOption {
  id: number;
  name: string;
  price?: number | null;
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
  price?: number;
  imageUrl?: string;
  dietLevel?: number;
  modifierIds?: number[];
  modifiers?: MenuModifier[];
}

export interface Menu {
  id: number;
  name?: string;
  displayName?: string;
  sections: { items: MenuItem[] }[];
  /** Option price fallback, in dollars. */
  optionSets?: { id: number; price?: number | null }[];
  disableSpecialInstructions?: boolean;
}

/** The dashboard supplies a record even before the first score is submitted. */
export interface UserRating {
  id: string | number;
  level?: number | null;
  reasons?: string[] | null;
  comment?: string | null;
  forGuest?: boolean | null;
  allowRatingFollowUps?: boolean | null;
  attachment?: string | null;
}

export interface Piece {
  id: string | number;
  itemId: number;
  menuId: number;
  userId?: number;
  name?: string;
  nonHiddenAttributes?: { label?: string; value?: string }[];
  group?: string | null;
  isConfirmed?: boolean | null;
  isLateSwappable?: boolean | null;
  isRemoval?: boolean | null;
  requestStatus?: string | null;
  isLateOrder?: boolean | null;
  price?: number;
  userRating?: UserRating | null;
}

export interface EtaStatus {
  start?: string; // Real offset, also used as a timezone fallback.
  end?: string;
  shortTz?: string;
  status?: string;
  trackingUrl?: string;
}

/** One order per venue. Resolve pieces by owner rather than order position. */
export interface Order {
  id: string | number;
  state?: string;
  replacementCutoffTs?: string;
  menu?: { name?: string };
  pieces?: Piece[];
  venue?: { name?: string; displayName?: string };
  etaStatus?: EtaStatus;
  dropoffCompletedAt?: string; // UTC instant.
}

export interface Delivery {
  id: number;
  state?: string; // Ordering lifecycle, distinct from fulfillment.
  simpleState?: string;
  forDeliveryAt?: string; // Floating local wall clock despite its Z suffix.
  userConfirmed?: boolean;
  copayAmount?: number;
  availableMenuIds?: number[];
  allowanceType?: string;
  weeklyAllowance?: number;
  weeklyAllowanceAvailable?: number;
  forBuffet?: boolean | null;
  deliveryWindow?: string[];
  serviceWindow?: { baseTime?: string; name?: string };
  reportMissingItemCutoff?: string; // UTC instant.
  address?: { formatted?: string; notes?: string };
  club?: { id: number; name?: string; market?: { timezone?: string } };
  orders?: Order[];
  userReceipt?: { due?: number; clubCopay?: number };
}

export type SelectionsHash = Record<string, number[]>;
