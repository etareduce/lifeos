from __future__ import annotations

from datetime import datetime, timezone

from .primitives import EventPrimitive, RecurrencePrimitive
from .utils import (
    DEFAULT_NAME_EDIT_DISTANCE_THRESHOLD,
    names_within_edit_distance,
    timeranges_equal,
)


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
        if recurrences_are_same(imported, candidate, name_distance_threshold):
            matches.append(candidate)
    return matches


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
