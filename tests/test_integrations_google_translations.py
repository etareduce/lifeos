from datetime import datetime

from integrations.google_calendar.translations import (
    translate_google_events_to_primitives,
)


def test_google_translations_group_instances_by_series_and_keep_single_events():
    events = [
        {
            "id": "instance-1",
            "recurringEventId": "series-1",
            "summary": "Team sync",
            "start": {"dateTime": "2026-03-01T09:00:00-08:00"},
            "end": {"dateTime": "2026-03-01T09:30:00-08:00"},
        },
        {
            "id": "instance-2",
            "recurringEventId": "series-1",
            "summary": "Team sycn",
            "start": {"dateTime": "2026-03-08T09:00:00-08:00"},
            "end": {"dateTime": "2026-03-08T09:30:00-08:00"},
        },
        {
            "id": "solo-1",
            "summary": "Dentist",
            "start": {"dateTime": "2026-03-03T12:00:00-08:00"},
            "end": {"dateTime": "2026-03-03T13:00:00-08:00"},
        },
        {
            "id": "cancelled-1",
            "status": "cancelled",
            "summary": "Should ignore",
            "start": {"dateTime": "2026-03-04T12:00:00-08:00"},
            "end": {"dateTime": "2026-03-04T13:00:00-08:00"},
        },
    ]

    recurrences = translate_google_events_to_primitives(
        events,
        calendar_id="work",
        calendar_name="Work",
        calendar_time_zone="America/Los_Angeles",
    )

    assert len(recurrences) == 2
    series = next(item for item in recurrences if item.key.endswith("series-1"))
    solo = next(item for item in recurrences if item.key.endswith("solo-1"))
    assert len(series.events) == 2
    assert series.title == "Team sync"
    assert series.is_recurring is True
    assert len(solo.events) == 1
    assert solo.events[0].name == "Dentist"
    assert solo.is_recurring is False


def test_google_translations_support_all_day_events():
    events = [
        {
            "id": "all-day-1",
            "summary": "Holiday",
            "start": {"date": "2026-04-10"},
            "end": {"date": "2026-04-11"},
        }
    ]
    recurrences = translate_google_events_to_primitives(
        events,
        calendar_id="personal",
        calendar_name="Personal",
        calendar_time_zone="UTC",
    )

    assert len(recurrences) == 1
    event = recurrences[0].events[0]
    assert event.default_start == datetime.fromisoformat("2026-04-10T00:00:00+00:00")
    assert event.default_end == datetime.fromisoformat("2026-04-11T00:00:00+00:00")
