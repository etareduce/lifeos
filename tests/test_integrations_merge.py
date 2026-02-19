from datetime import datetime, timedelta, timezone

from integrations.merge import events_are_same, recurrences_are_same
from integrations.primitives import EventPrimitive, RecurrencePrimitive


def _event(name: str, start: datetime, minutes: int = 60) -> EventPrimitive:
    return EventPrimitive(
        name=name,
        default_start=start,
        default_end=start + timedelta(minutes=minutes),
        timezone="UTC",
    )


def test_events_are_same_within_name_threshold_and_same_timerange():
    start = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
    left = _event("Weekly planning", start)
    right = _event("Weekly planing", start)
    assert events_are_same(left, right)


def test_events_are_not_same_when_name_distance_too_large():
    start = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
    left = _event("Weekly planning", start)
    right = _event("Dinner", start)
    assert not events_are_same(left, right)


def test_recurrences_are_same_when_all_events_match_order_independent():
    a_start = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
    b_start = datetime(2026, 3, 2, 10, 0, tzinfo=timezone.utc)
    left = RecurrencePrimitive(
        key="left",
        provider="google",
        calendar_id="team",
        calendar_name="Team",
        title="Planning",
        events=[_event("Planning", a_start), _event("Review", b_start)],
    )
    right = RecurrencePrimitive(
        key="right",
        provider="local",
        calendar_id="local",
        calendar_name="Elastisched",
        title="Planning",
        events=[_event("Review", b_start), _event("Planing", a_start)],
    )
    assert recurrences_are_same(left, right)


def test_recurrences_are_not_same_when_any_event_is_missing():
    a_start = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
    b_start = datetime(2026, 3, 2, 10, 0, tzinfo=timezone.utc)
    left = RecurrencePrimitive(
        key="left",
        provider="google",
        calendar_id="team",
        calendar_name="Team",
        title="Planning",
        events=[_event("Planning", a_start), _event("Review", b_start)],
    )
    right = RecurrencePrimitive(
        key="right",
        provider="local",
        calendar_id="local",
        calendar_name="Elastisched",
        title="Planning",
        events=[_event("Planning", a_start)],
    )
    assert not recurrences_are_same(left, right)
