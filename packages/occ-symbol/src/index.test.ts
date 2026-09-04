import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseOccSymbol,
  isOccSymbol,
  formatOccSymbol,
  type OccParts,
} from "./index.js";

describe("parseOccSymbol", () => {
  test("parses a standard OCC call", () => {
    assert.deepEqual(parseOccSymbol("SMR260919C00009000"), {
      underlying: "SMR",
      expiration: "2026-09-19",
      right: "call",
      strike: 9,
    });
  });

  test("parses a put with a fractional strike", () => {
    assert.deepEqual(parseOccSymbol("SPY260825P00500500"), {
      underlying: "SPY",
      expiration: "2026-08-25",
      right: "put",
      strike: 500.5,
    });
  });

  test("tolerates a space-padded root (Schwab-style)", () => {
    assert.deepEqual(parseOccSymbol("AAPL  240119C00150000"), {
      underlying: "AAPL",
      expiration: "2024-01-19",
      right: "call",
      strike: 150,
    });
  });

  test("returns null for a plain equity symbol", () => {
    assert.equal(parseOccSymbol("AAPL"), null);
    assert.equal(isOccSymbol("AAPL"), false);
  });

  test("isOccSymbol detects OCC strings, padded or not", () => {
    assert.equal(isOccSymbol("SMR260919C00009000"), true);
    assert.equal(isOccSymbol("AAPL  240119C00150000"), true);
    assert.equal(isOccSymbol("SMR"), false);
  });
});

describe("formatOccSymbol", () => {
  test("builds a standard OCC call", () => {
    assert.equal(
      formatOccSymbol({
        underlying: "SPY",
        expiration: "2026-08-25",
        right: "call",
        strike: 500,
      }),
      "SPY260825C00500000",
    );
  });

  test("builds a put", () => {
    assert.equal(
      formatOccSymbol({
        underlying: "SPY",
        expiration: "2026-08-25",
        right: "put",
        strike: 500,
      }),
      "SPY260825P00500000",
    );
  });

  test("handles a fractional strike", () => {
    assert.equal(
      formatOccSymbol({
        underlying: "SPY",
        expiration: "2026-08-25",
        right: "put",
        strike: 500.5,
      }),
      "SPY260825P00500500",
    );
  });
});

describe("round-trip", () => {
  const partsCases: OccParts[] = [
    { underlying: "SPY", expiration: "2026-08-25", right: "call", strike: 500 },
    { underlying: "SPY", expiration: "2026-08-25", right: "put", strike: 500.5 },
    { underlying: "SMR", expiration: "2026-09-19", right: "call", strike: 9 },
    { underlying: "AAPL", expiration: "2024-01-19", right: "call", strike: 150 },
  ];

  for (const parts of partsCases) {
    test(`parseOccSymbol(formatOccSymbol(...)) deep-equals parts: ${parts.underlying}`, () => {
      assert.deepEqual(parseOccSymbol(formatOccSymbol(parts)), parts);
    });
  }

  const symCases = [
    "SPY260825C00500000",
    "SPY260825P00500500",
    "SMR260919C00009000",
    "AAPL240119C00150000",
  ];

  for (const sym of symCases) {
    test(`formatOccSymbol(parseOccSymbol(...)) equals the normalized symbol: ${sym}`, () => {
      const parsed = parseOccSymbol(sym);
      assert.ok(parsed);
      assert.equal(formatOccSymbol(parsed), sym);
    });
  }

  test("normalizes a space-padded symbol through parse+format", () => {
    const parsed = parseOccSymbol("AAPL  240119C00150000");
    assert.ok(parsed);
    assert.equal(formatOccSymbol(parsed), "AAPL240119C00150000");
  });
});
