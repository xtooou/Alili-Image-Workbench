from __future__ import annotations

DEFAULT_CANVAS_MULTIPLE = 32
MAX_RESOLUTION = 16384


def round_to_multiple(value: float, multiple: int = DEFAULT_CANVAS_MULTIPLE) -> int:
    multiple = max(1, int(multiple))
    return max(multiple, int(round(float(value) / multiple)) * multiple)
