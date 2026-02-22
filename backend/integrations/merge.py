from __future__ import annotations

from datetime import datetime, timezone

from .primitives import EventPrimitive, RecurrencePrimitive
from .utils import (
    DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
    names_within_edit_distance,
    timeranges_equal,
)

MIN_IDENTIFIER_EDGE_CHARS = 6


def events_are_same(
    left: EventPrimitive,
    right: EventPrimitive,
    name_distance_threshold: int = DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
) -> bool:
    if not timeranges_equal(
        left.default_start,
        left.default_end,
        right.default_start,
        right.default_end,
    ):
        return False
    return names_within_edit_distance(left.name, right.name, name_distance_threshold)


def recurrences_are_same(
    left: RecurrencePrimitive,
    right: RecurrencePrimitive,
    name_distance_threshold: int = DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
) -> bool:
    if len(left.events) != len(right.events):
        return False
    if not left.events:
        return True
    if _timerange_signature(left.events) != _timerange_signature(right.events):
        return False
    graph: list[list[int]] = []
    for left_event in left.events:
        edges: list[int] = []
        for right_index, right_event in enumerate(right.events):
            if events_are_same(left_event, right_event, name_distance_threshold):
                edges.append(right_index)
        if not edges:
            return False
        graph.append(edges)
    return _has_perfect_bipartite_matching(graph, len(right.events))


def find_recurrence_matches(
    imported: RecurrencePrimitive,
    existing: list[RecurrencePrimitive],
    name_distance_threshold: int = DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
) -> list[RecurrencePrimitive]:
    matches: list[RecurrencePrimitive] = []
    for candidate in existing:
        if recurrences_are_same(imported, candidate, name_distance_threshold) or (
            recurrences_have_related_identifiers(imported, candidate)
        ):
            matches.append(candidate)
    return matches


def recurrences_have_related_identifiers(
    left: RecurrencePrimitive,
    right: RecurrencePrimitive,
    min_shared_chars: int = MIN_IDENTIFIER_EDGE_CHARS,
) -> bool:
    left_ids = _recurrence_identifiers(left)
    right_ids = _recurrence_identifiers(right)
    if not left_ids or not right_ids:
        return False
    for left_id in left_ids:
        for right_id in right_ids:
            if _shares_nontrivial_prefix_or_suffix(
                left_id,
                right_id,
                min_shared_chars=min_shared_chars,
            ):
                return True
    return False


def _has_perfect_bipartite_matching(graph: list[list[int]], right_size: int) -> bool:
    right_match = [-1] * right_size

    def _dfs(left_index: int, visited: list[bool]) -> bool:
        for right_index in graph[left_index]:
            if visited[right_index]:
                continue
            visited[right_index] = True
            if right_match[right_index] == -1 or _dfs(right_match[right_index], visited):
                right_match[right_index] = left_index
                return True
        return False

    for left_index in range(len(graph)):
        visited = [False] * right_size
        if not _dfs(left_index, visited):
            return False
    return True


def _to_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _timerange_signature(events: list[EventPrimitive]) -> tuple[tuple[str, str], ...]:
    return tuple(
        sorted(
            (_to_utc(event.default_start).isoformat(), _to_utc(event.default_end).isoformat())
            for event in events
        )
    )


def _recurrence_identifiers(value: RecurrencePrimitive) -> list[str]:
    raw = list(value.identifiers or [])
    raw.append(value.key)
    identifiers: list[str] = []
    for item in raw:
        normalized = str(item or "").strip().lower()
        if not normalized:
            continue
        if normalized in identifiers:
            continue
        identifiers.append(normalized)
    return identifiers


def _shares_nontrivial_prefix_or_suffix(
    left: str,
    right: str,
    *,
    min_shared_chars: int,
) -> bool:
    if not left or not right:
        return False
    if left == right:
        return True
    if min(len(left), len(right)) < (min_shared_chars + 2):
        return False
    return _common_prefix_length(left, right) >= min_shared_chars or _common_suffix_length(
        left, right
    ) >= min_shared_chars


def _common_prefix_length(left: str, right: str) -> int:
    count = 0
    for left_char, right_char in zip(left, right):
        if left_char != right_char:
            break
        count += 1
    return count


def _common_suffix_length(left: str, right: str) -> int:
    count = 0
    for left_char, right_char in zip(reversed(left), reversed(right)):
        if left_char != right_char:
            break
        count += 1
    return count
