"""Canonical JSON (P2-T07): object keys sorted at every level, no whitespace, arrays kept in order. Two values that are
equal as data always serialize identically, so their SHA-256 is a stable content hash (D17 revision dedup).

The output is byte-identical to the TypeScript implementation: keys are ordered by UTF-16 code units (JS `sort()`),
strings are escaped as `JSON.stringify` does, and numbers are formatted by the ECMAScript Number-to-string rules
(`5.0` -> `5`, `1e21` -> `1e+21`, `0.000001` stays decimal)."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any


class CanonicalJsonError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.name = "CanonicalJsonError"


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _string(value: str) -> str:
    text = json.dumps(value, ensure_ascii=False)
    # A Python str holds a surrogate code point only when it is lone; JSON.stringify writes those as \udXXX escapes.
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)


def js_number(value: int | float) -> str:
    """ECMAScript Number::toString for a finite number."""
    if isinstance(value, int) and abs(value) < 2**53:
        return str(value)
    number = float(value)
    if not math.isfinite(number):
        raise CanonicalJsonError("non-finite number")
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    digit_tuple = Decimal(repr(abs(number))).normalize().as_tuple()
    digits = "".join(str(d) for d in digit_tuple.digits)
    exponent = int(digit_tuple.exponent)  # type: ignore[arg-type]
    k = len(digits)
    n = exponent + k  # decimal point position
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digits[:n]}.{digits[n:]}"
    elif -6 < n <= 0:
        body = f"0.{'0' * -n}{digits}"
    else:
        e = n - 1
        mantissa = digits[0] + (f".{digits[1:]}" if k > 1 else "")
        body = f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
    return sign + body


def _utf16_key(key: str) -> bytes:
    return key.encode("utf-16-be", "surrogatepass")


def canonical_json(value: Any) -> str:
    """Serializes plain JSON data canonically. Raises CanonicalJsonError on anything JSON can't represent faithfully."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, int | float):
        if isinstance(value, float) and not math.isfinite(value):
            raise CanonicalJsonError("non-finite number")
        return js_number(value)
    if isinstance(value, list | tuple):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        for key in value:
            if not isinstance(key, str):
                raise CanonicalJsonError("only string keys are allowed")
        entries = [f"{_string(key)}:{canonical_json(value[key])}" for key in sorted(value, key=_utf16_key)]
        return "{" + ",".join(entries) + "}"
    raise CanonicalJsonError(f"unsupported type: {type(value).__name__}")
