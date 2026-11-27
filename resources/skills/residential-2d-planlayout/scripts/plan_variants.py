"""Shared variant manifest checks."""

import re

from plan_io import read_json


def read_variants(path):
    variants = read_json(path).get("variants")
    if not isinstance(variants, list) or not variants:
        raise ValueError("Provide a nonempty variants array.")
    seen = set()
    for item in variants:
        name = item.get("id") if isinstance(item, dict) else None
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name)
            or re.fullmatch(r"CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]", name, re.IGNORECASE)
            or name.casefold() in seen
        ):
            raise ValueError(
                "Use unique variant ids made of letters, numbers, hyphens or underscores."
            )
        seen.add(name.casefold())
    return variants
