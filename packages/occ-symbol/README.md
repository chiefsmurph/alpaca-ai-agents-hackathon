# occ-symbol

[![npm](https://img.shields.io/npm/v/occ-symbol?logo=npm&label=npm)](https://www.npmjs.com/package/occ-symbol) [![PyPI](https://img.shields.io/pypi/v/occ-symbol?logo=pypi&logoColor=white&label=PyPI&color=3775A9)](https://pypi.org/project/occ-symbol/)

> ▶ **[Try it live at occsymbol.com](https://occsymbol.com)** — decode or build any option symbol right in your browser.

**Parse, validate, and build OCC option symbols.** A tiny, dependency-free module that turns the broker-agnostic listed-option string (the OSI symbol) into structured parts — and back again. Available for **JavaScript / TypeScript** (npm) and **Python** (PyPI) with an identical API.

```ts
import { parseOccSymbol, formatOccSymbol, isOccSymbol } from "occ-symbol";

parseOccSymbol("SPY260825C00500000");
// { underlying: "SPY", expiration: "2026-08-25", right: "call", strike: 500 }

formatOccSymbol({ underlying: "SPY", expiration: "2026-08-25", right: "call", strike: 500 });
// "SPY260825C00500000"

isOccSymbol("SPY260825C00500000"); // true
isOccSymbol("SPY");                // false
```

## The format

An OCC (a.k.a. OSI) option symbol packs four fields into one string:

```
SPY260825C00500000
└┬┘└──┬─┘│└───┬──┘
 │    │  │    └── strike × 1000, 8 digits, zero-padded (00500000 = 500.000)
 │    │  └─────── C = call, P = put
 │    └────────── expiration YYMMDD (20YY)
 └─────────────── underlying / root
```

## Install

**JavaScript / TypeScript** ([npm](https://www.npmjs.com/package/occ-symbol)):

```bash
npm install occ-symbol
```

**Python** ([PyPI](https://pypi.org/project/occ-symbol/)) — stdlib-only, same API and test cases; docs in [`python/`](python/):

```bash
pip install occ-symbol
```

## API

| Function | Description |
|---|---|
| `parseOccSymbol(symbol)` | Parse a symbol into `OccParts`, or `null` if it isn't a valid OCC string. Tolerates space-padded roots (Schwab-style `"AAPL  240119C00150000"`). |
| `formatOccSymbol(parts)` | Build a canonical (unpadded) OCC symbol from `OccParts`. The inverse of `parseOccSymbol`. |
| `isOccSymbol(symbol)` | `true` if the string is a valid OCC option symbol (padded or not). |

```ts
type OptionRight = "call" | "put";

interface OccParts {
  underlying: string;
  expiration: string; // 'YYYY-MM-DD'
  right: OptionRight;
  strike: number;
}
```

`parseOccSymbol` and `formatOccSymbol` round-trip: parsing a symbol and formatting the result yields the canonical symbol, and formatting parts then parsing them returns the original parts.

## Scope & limitations

- Two-digit years are interpreted as `20YY`, matching current listed-option conventions.
- `formatOccSymbol` emits the canonical **unpadded** root; space-padded input is normalized on the round trip.
- Strikes are scaled by 1000 (`Math.round(strike * 1000)`), so fractional strikes down to a tenth of a cent are preserved.

## Develop

```bash
npm install
npm test        # node:test suite
npm run build   # emit dist/ (ESM + .d.ts)
```

## License

MIT © John Murphy
