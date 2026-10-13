const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const money = (amount: number | null) =>
  amount == null ? "Price unavailable" : currency.format(amount);
