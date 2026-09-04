# Vendored open-source plumbing

## `occ-symbol/`

A vendored snapshot of **[occ-symbol](https://github.com/chiefsmurph/occ-symbol)** — the
zero-dependency OCC/OSI option-symbol parser this project uses to turn a broker-agnostic listed-option
string (e.g. `SPY260825C00500000`) into structured parts and back again. It is **fully public** —
dual-published to [npm](https://www.npmjs.com/package/occ-symbol) and
[PyPI](https://pypi.org/project/occ-symbol/), with live docs at
[occsymbol.com](https://occsymbol.com) — so it is included here verbatim (git history stripped) as
zero-leak reference plumbing, not to hide anything.

The two ports are kept **byte-identical**: the Python side reimplements JavaScript's
half-away-from-zero rounding because Python's built-in `round()` uses banker's rounding and would
disagree on exact half-thousandth strikes. Option tickers are a notorious source of silent,
money-losing bugs; a round-trip-tested, broker-agnostic parser is the boring-but-critical plumbing
that keeps an options agent from fat-fingering a leg.

Install it directly instead of vendoring:

```bash
npm install occ-symbol      # JavaScript / TypeScript
pip install occ-symbol      # Python
```
