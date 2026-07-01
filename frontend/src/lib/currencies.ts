/**
 * Shared currency registry — single source of truth mapping currency codes to
 * their display symbols. Used by the template builder so a "currency" amount
 * field can resolve its symbol dynamically from a linked dropdown's selected
 * code (see `currencyFromField`), instead of a hand-typed per-field symbol.
 */

export interface CurrencyDef {
  code: string;
  symbol: string;
  name: string;
}

export const CURRENCIES: CurrencyDef[] = [
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling" },
  { code: "USD", symbol: "$",   name: "US Dollar" },
  { code: "EUR", symbol: "€",   name: "Euro" },
  { code: "GBP", symbol: "£",   name: "British Pound" },
  { code: "UGX", symbol: "USh", name: "Ugandan Shilling" },
  { code: "TZS", symbol: "TSh", name: "Tanzanian Shilling" },
  { code: "RWF", symbol: "FRw", name: "Rwandan Franc" },
  { code: "ZAR", symbol: "R",   name: "South African Rand" },
  { code: "NGN", symbol: "₦",   name: "Nigerian Naira" },
  { code: "GHS", symbol: "₵",   name: "Ghanaian Cedi" },
  { code: "INR", symbol: "₹",   name: "Indian Rupee" },
  { code: "JPY", symbol: "¥",   name: "Japanese Yen" },
  { code: "CNY", symbol: "¥",   name: "Chinese Yuan" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
];

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code);

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code.toUpperCase(), c]));

/**
 * Resolve a currency symbol from a stored value. Accepts a bare code ("USD") or
 * a "CODE — Name" style option string ("USD — US Dollar"); the leading token is
 * treated as the code. Returns `undefined` when the value is empty or unknown,
 * so callers can fall back to a fixed symbol.
 */
export function currencySymbolFor(value?: string | null): string | undefined {
  if (!value) return undefined;
  const code = String(value).trim().toUpperCase().split(/[\s—–-]/)[0];
  return BY_CODE.get(code)?.symbol;
}
