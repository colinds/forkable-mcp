// Domain types (only the fields our v0 tools touch).

export interface MenuOption {
  id: number;
  name: string;
  price?: number | null; // cents
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
  price?: number; // cents
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
  optionSets?: { id: number; price?: number | null }[];
  venue?: { id: number; name?: string; capacity?: number };
}

export interface Piece {
  id: string | number; // piece ids are UUID strings in practice
  itemId: number;
  menuId: number;
  name?: string;
  state?: string;
  autoOrder?: boolean;
  isConfirmed?: boolean;
  instructions?: string;
  price?: number;
  selections?: SelectionsHash | null; // stored hash on an existing piece
}

export interface Order {
  id: string | number;
  state?: string;
  total?: number;
  isOverVenueCapacity?: boolean;
  lateOrdersRemaining?: number;
  lateGuestOrdersRemaining?: number;
  lateRemovalsRemaining?: number;
  changeRequestAllowed?: boolean;
  pastLateOrderDeadline?: boolean;
  menu?: { id: number; name?: string };
  pieces?: Piece[];
}

export interface Delivery {
  id: number;
  state?: string;
  simpleState?: string;
  forDeliveryAt?: string;
  editingCutoffAt?: string;
  isReadOnly?: boolean;
  userConfirmed?: boolean;
  copayAmount?: number;
  availableMenuIds?: number[];
  pastLateOrderDeadline?: boolean;
  canRequestChanges?: boolean;
  weeklyAllowanceAvailable?: number;
  club?: { id: number; name?: string };
  orders?: Order[];
  userReceipt?: { id: number; due?: number; copayAmount?: number };
}

export type SelectionsHash = Record<string, number[]>;
