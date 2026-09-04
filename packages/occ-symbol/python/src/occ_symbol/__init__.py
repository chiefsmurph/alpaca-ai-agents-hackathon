"""OCC option-symbol parsing and building.

The broker-agnostic listed-option format, also known as the OSI symbol::

    SPY260825C00500000  =  <ROOT><YYMMDD><C|P><STRIKE*1000, 8 digits, zero-padded>

e.g. ``SPY260825C00500000`` -> ``SPY``, ``2026-08-25``, call, strike 500.

The layout is: an alphabetic underlying/root, a 6-digit YYMMDD expiration (the
2-digit year is interpreted as 20YY), a single ``C``/``P`` for call/put, and an
8-digit strike price scaled by 1000 (so ``00500000`` = 500.000,
``00500500`` = 500.5).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Optional

__all__ = [
    "OptionRight",
    "OccParts",
    "is_occ_symbol",
    "parse_occ_symbol",
    "format_occ_symbol",
]

OptionRight = Literal["call", "put"]

_OCC_RE = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class OccParts:
    """The four structured fields packed into an OCC/OSI option symbol."""

    underlying: str
    expiration: str  # 'YYYY-MM-DD'
    right: OptionRight
    strike: float


def is_occ_symbol(symbol: str) -> bool:
    """Return ``True`` if ``symbol`` is a valid OCC option symbol (padded or not).

    Some brokers space-pad the root to 6 chars (Schwab:
    ``"AAPL  240119C00150000"``); whitespace is stripped so the same matcher
    handles both padded and unpadded forms.
    """
    return _OCC_RE.match(_WHITESPACE_RE.sub("", symbol)) is not None


def parse_occ_symbol(symbol: str) -> Optional[OccParts]:
    """Parse a symbol into :class:`OccParts`, or ``None`` if it isn't valid.

    Tolerates space-padded roots (Schwab-style ``"AAPL  240119C00150000"``).
    """
    m = _OCC_RE.match(_WHITESPACE_RE.sub("", symbol))
    if m is None:
        return None
    underlying, ymd, cp, strike_str = m.group(1), m.group(2), m.group(3), m.group(4)
    strike = int(strike_str) / 1000
    return OccParts(
        underlying=underlying,
        expiration=f"20{ymd[0:2]}-{ymd[2:4]}-{ymd[4:6]}",
        right="call" if cp == "C" else "put",
        strike=strike,
    )


def format_occ_symbol(parts: OccParts) -> str:
    """Build a canonical (unpadded) OCC symbol from parts.

    The inverse of :func:`parse_occ_symbol`. Strikes are scaled by 1000 and
    rounded to the nearest thousandth, matching the OSI convention.
    """
    ymd = parts.expiration[2:4] + parts.expiration[5:7] + parts.expiration[8:10]
    cp = "C" if parts.right == "call" else "P"
    strike_str = str(_round_half_away_from_zero(parts.strike * 1000)).zfill(8)
    return f"{parts.underlying}{ymd}{cp}{strike_str}"


def _round_half_away_from_zero(value: float) -> int:
    """Match JavaScript ``Math.round`` semantics (round half toward +infinity).

    Python's built-in ``round`` uses banker's rounding, which would disagree
    with the JS reference implementation on exact ``*.5`` thousandths. Strikes
    are never negative in practice, so half-up and half-away-from-zero coincide;
    we implement half toward +infinity to mirror ``Math.round`` exactly.
    """
    import math

    return math.floor(value + 0.5)
