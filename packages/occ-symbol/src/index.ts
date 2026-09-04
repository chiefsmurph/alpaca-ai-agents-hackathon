/**
 * OCC option-symbol parsing and building (the broker-agnostic listed-option
 * format, also known as the OSI symbol):
 *   SPY260825C00500000  =  <ROOT><YYMMDD><C|P><STRIKE*1000, 8 digits, zero-padded>
 * e.g. SPY260825C00500000 → SPY, 2026-08-25, call, strike 500.
 *
 * The layout is: an alphabetic underlying/root, a 6-digit YYMMDD expiration
 * (the 2-digit year is interpreted as 20YY), a single C/P for call/put, and an
 * 8-digit strike price scaled by 1000 (so 00500000 = 500.000, 00500500 = 500.5).
 */

export type OptionRight = "call" | "put";

export interface OccParts {
  underlying: string;
  expiration: string; // 'YYYY-MM-DD'
  right: OptionRight;
  strike: number;
}

const OCC_RE = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;

// Some brokers space-pad the root to 6 chars (Schwab: "AAPL  240119C00150000");
// strip whitespace so the same matcher handles both padded and unpadded forms.
export function isOccSymbol(symbol: string): boolean {
  return OCC_RE.test(symbol.replace(/\s+/g, ""));
}

export function parseOccSymbol(symbol: string): OccParts | null {
  const m = OCC_RE.exec(symbol.replace(/\s+/g, ""));
  if (!m) return null;
  // The regex has four capture groups; a successful match guarantees all four.
  const [, underlying, ymd, cp, strikeStr] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    underlying,
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    right: cp === "C" ? "call" : "put",
    strike: parseInt(strikeStr, 10) / 1000,
  };
}

// Inverse of parseOccSymbol: build a canonical (unpadded) OCC symbol from parts.
export function formatOccSymbol(parts: OccParts): string {
  const { underlying, expiration, right, strike } = parts;
  const ymd = expiration.slice(2, 4) + expiration.slice(5, 7) + expiration.slice(8, 10);
  const cp = right === "call" ? "C" : "P";
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying}${ymd}${cp}${strikeStr}`;
}
