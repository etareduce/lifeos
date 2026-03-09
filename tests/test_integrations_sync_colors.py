from datetime import datetime, timedelta, timezone

from integrations.primitives import EventPrimitive, RecurrencePrimitive
from integrations.router import _build_recurrence_payload, _color_for_key


def _recurrence(key: str, *, calendar_id: str) -> RecurrencePrimitive:
    start = datetime(2026, 3, 1, 9, 0, tzinfo=timezone.utc)
    return RecurrencePrimitive(
        key=key,
        provider="google",
        calendar_id=calendar_id,
        calendar_name="Work",
        title="Imported event",
        events=[
            EventPrimitive(
                name="Imported event",
                default_start=start,
                default_end=start + timedelta(hours=1),
                timezone="UTC",
            )
        ],
    )


def test_synced_google_recurrences_share_color_within_same_calendar_view():
    calendar_view_id = "google:acct-1:team-calendar"
    first = _recurrence("team-calendar:series-1", calendar_id="team-calendar")
    second = _recurrence("team-calendar:series-2", calendar_id="team-calendar")

    _, first_payload = _build_recurrence_payload(
        first,
        account_key="acct-1",
        account_id="user@example.com",
        account_name="User",
        calendar_view_id=calendar_view_id,
    )
    _, second_payload = _build_recurrence_payload(
        second,
        account_key="acct-1",
        account_id="user@example.com",
        account_name="User",
        calendar_view_id=calendar_view_id,
    )

    assert first_payload["color"] == second_payload["color"]
    assert first_payload["color"] == _color_for_key(calendar_view_id)


def test_synced_google_recurrence_color_is_derived_from_calendar_view_id():
    calendar_view_id = "google:acct-2:personal-calendar"
    recurrence = _recurrence("personal-calendar:event-1", calendar_id="personal-calendar")

    _, payload = _build_recurrence_payload(
        recurrence,
        account_key="acct-2",
        account_id="user@example.com",
        account_name="User",
        calendar_view_id=calendar_view_id,
    )

    assert payload["color"] == _color_for_key(calendar_view_id)
