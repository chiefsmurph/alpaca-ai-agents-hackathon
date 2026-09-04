# occ-symbol

[![PyPI](https://img.shields.io/pypi/v/occ-symbol?logo=pypi&logoColor=white&label=PyPI&color=3775A9)](https://pypi.org/project/occ-symbol/) [![npm](https://img.shields.io/npm/v/occ-symbol?logo=npm&label=npm)](https://www.npmjs.com/package/occ-symbol)

**Parse, validate, and build OCC option symbols.** A tiny, dependency-free
Python module (stdlib only) that turns the broker-agnostic listed-option string
(the OSI symbol) into structured parts — and back again.

> Python port of the [`occ-symbol`](https://github.com/chiefsmurph/occ-symbol)
> TypeScript package — same API, same behavior, same test cases. Also on
> **npm** for JS/TS: `npm install occ-symbol`.

```python
from occ_symbol import parse_occ_symbol, format_occ_symbol, is_occ_symbol, OccParts

parse_occ_symbol("SPY260825C00500000")
# OccParts(underlying='SPY', expiration='2026-08-25', right='call', strike=500.0)

format_occ_symbol(OccParts(underlying="SPY", expiration="2026-08-25", right="call", strike=500))
# "SPY260825C00500000"

is_occ_symbol("SPY260825C00500000")  # True
is_occ_symbol("SPY")                 # False
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

```bash
pip install occ-symbol
```

Also available for **JavaScript / TypeScript** on [npm](https://www.npmjs.com/package/occ-symbol): `npm install occ-symbol`.

## API

| Function | Description |
|---|---|
| `parse_occ_symbol(symbol)` | Parse a symbol into `OccParts`, or `None` if it isn't a valid OCC string. Tolerates space-padded roots (Schwab-style `"AAPL  240119C00150000"`). |
| `format_occ_symbol(parts)` | Build a canonical (unpadded) OCC symbol from `OccParts`. The inverse of `parse_occ_symbol`. |
| `is_occ_symbol(symbol)` | `True` if the string is a valid OCC option symbol (padded or not). |

```python
from dataclasses import dataclass
from typing import Literal

OptionRight = Literal["call", "put"]

@dataclass(frozen=True)
class OccParts:
    underlying: str
    expiration: str  # 'YYYY-MM-DD'
    right: OptionRight
    strike: float
```

`parse_occ_symbol` and `format_occ_symbol` round-trip: parsing a symbol and
formatting the result yields the canonical symbol, and formatting parts then
parsing them returns the original parts.

## Scope & limitations

- Two-digit years are interpreted as `20YY`, matching current listed-option conventions.
- `format_occ_symbol` emits the canonical **unpadded** root; space-padded input is normalized on the round trip.
- Strikes are scaled by 1000 (rounded to the nearest thousandth), so fractional strikes down to a tenth of a cent are preserved.

## Develop

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT © John Murphy
