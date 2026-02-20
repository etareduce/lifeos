from datetime import datetime, timezone
from functools import cache


# Hard-coded by product spec; keep as a named constant for easy future tuning.
DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD = 4


def edit_distance(left: str, right: str) -> int:
    @cache
    def helper(i: int, j: int) -> int:
        if i == len(left):
            return len(right) - j

        if j == len(right):
            return len(left) - i

        if left[i] == right[j]:
            return helper(i + 1, j + 1)

        skip_left = helper(i + 1, j)
        skip_right = helper(i, j + 1)
        skip_both = helper(i + 1, j + 1)

        return 1 + min(skip_left, skip_right, skip_both)

    return helper(0, 0)


def normalize_name(value: str | None) -> str:
    return (value or "").strip().lower()


def names_within_edit_distance(
    left: str | None,
    right: str | None,
    threshold: int = DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
) -> bool:
    if threshold < 0:
        return False
    return edit_distance(normalize_name(left), normalize_name(right)) <= threshold


def ensure_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def timeranges_equal(
    left_start: datetime,
    left_end: datetime,
    right_start: datetime,
    right_end: datetime,
) -> bool:
    return ensure_aware_utc(left_start) == ensure_aware_utc(right_start) and ensure_aware_utc(
        left_end
    ) == ensure_aware_utc(right_end)
