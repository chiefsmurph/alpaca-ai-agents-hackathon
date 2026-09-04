"""Ported from occ-symbol/src/index.test.ts — same fixtures and expected values."""

import pytest

from occ_symbol import (
    OccParts,
    format_occ_symbol,
    is_occ_symbol,
    parse_occ_symbol,
)


# --- parseOccSymbol ---------------------------------------------------------

def test_parses_a_standard_occ_call():
    assert parse_occ_symbol("SMR260919C00009000") == OccParts(
        underlying="SMR",
        expiration="2026-09-19",
        right="call",
        strike=9,
    )


def test_parses_a_put_with_a_fractional_strike():
    assert parse_occ_symbol("SPY260825P00500500") == OccParts(
        underlying="SPY",
        expiration="2026-08-25",
        right="put",
        strike=500.5,
    )


def test_tolerates_a_space_padded_root_schwab_style():
    assert parse_occ_symbol("AAPL  240119C00150000") == OccParts(
        underlying="AAPL",
        expiration="2024-01-19",
        right="call",
        strike=150,
    )


def test_returns_none_for_a_plain_equity_symbol():
    assert parse_occ_symbol("AAPL") is None
    assert is_occ_symbol("AAPL") is False


def test_is_occ_symbol_detects_occ_strings_padded_or_not():
    assert is_occ_symbol("SMR260919C00009000") is True
    assert is_occ_symbol("AAPL  240119C00150000") is True
    assert is_occ_symbol("SMR") is False


# --- formatOccSymbol --------------------------------------------------------

def test_builds_a_standard_occ_call():
    assert (
        format_occ_symbol(
            OccParts(
                underlying="SPY",
                expiration="2026-08-25",
                right="call",
                strike=500,
            )
        )
        == "SPY260825C00500000"
    )


def test_builds_a_put():
    assert (
        format_occ_symbol(
            OccParts(
                underlying="SPY",
                expiration="2026-08-25",
                right="put",
                strike=500,
            )
        )
        == "SPY260825P00500000"
    )


def test_handles_a_fractional_strike():
    assert (
        format_occ_symbol(
            OccParts(
                underlying="SPY",
                expiration="2026-08-25",
                right="put",
                strike=500.5,
            )
        )
        == "SPY260825P00500500"
    )


# --- round-trip -------------------------------------------------------------

PARTS_CASES = [
    OccParts(underlying="SPY", expiration="2026-08-25", right="call", strike=500),
    OccParts(underlying="SPY", expiration="2026-08-25", right="put", strike=500.5),
    OccParts(underlying="SMR", expiration="2026-09-19", right="call", strike=9),
    OccParts(underlying="AAPL", expiration="2024-01-19", right="call", strike=150),
]


@pytest.mark.parametrize("parts", PARTS_CASES, ids=[p.underlying for p in PARTS_CASES])
def test_parse_of_format_deep_equals_parts(parts):
    assert parse_occ_symbol(format_occ_symbol(parts)) == parts


SYM_CASES = [
    "SPY260825C00500000",
    "SPY260825P00500500",
    "SMR260919C00009000",
    "AAPL240119C00150000",
]


@pytest.mark.parametrize("sym", SYM_CASES)
def test_format_of_parse_equals_the_normalized_symbol(sym):
    parsed = parse_occ_symbol(sym)
    assert parsed is not None
    assert format_occ_symbol(parsed) == sym


def test_normalizes_a_space_padded_symbol_through_parse_format():
    parsed = parse_occ_symbol("AAPL  240119C00150000")
    assert parsed is not None
    assert format_occ_symbol(parsed) == "AAPL240119C00150000"
