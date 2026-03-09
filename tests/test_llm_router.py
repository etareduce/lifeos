from backend.llm_router import _normalize_llm_recurrence
from backend.schemas import RecurrenceCreate


def _blob_payload() -> dict:
    return {
        "default_scheduled_timerange": {
            "start": "2026-03-09T09:00:00-04:00",
            "end": "2026-03-09T10:00:00-04:00",
        },
        "schedulable_timerange": {
            "start": "2026-03-09T08:00:00-04:00",
            "end": "2026-03-09T11:00:00-04:00",
        },
    }


def test_normalize_weekly_promotes_blob_to_blobs_of_week():
    recurrence = RecurrenceCreate.model_validate(
        {
            "type": "weekly",
            "payload": {
                "recurrence_name": "Weekly Planning",
                "blob": _blob_payload(),
            },
        }
    )

    normalized = _normalize_llm_recurrence(
        recurrence, "America/New_York", "Draft 1"
    )

    assert "blob" not in normalized.payload
    assert len(normalized.payload["blobs_of_week"]) == 1
    assert normalized.payload["blobs_of_week"][0]["name"] == "Weekly Planning"
    assert normalized.payload["blobs_of_week"][0]["tz"] == "America/New_York"


def test_normalize_weekly_promotes_blobs_to_blobs_of_week():
    recurrence = RecurrenceCreate.model_validate(
        {
            "type": "weekly",
            "payload": {
                "blobs": [_blob_payload(), _blob_payload()],
            },
        }
    )

    normalized = _normalize_llm_recurrence(
        recurrence, "America/New_York", "Draft 2"
    )

    assert "blobs" not in normalized.payload
    assert len(normalized.payload["blobs_of_week"]) == 2
    assert normalized.payload["blobs_of_week"][0]["name"] == "Draft 2"
    assert normalized.payload["blobs_of_week"][1]["name"] == "Draft 2"


def test_normalize_weekly_wraps_root_blob_shape():
    recurrence = RecurrenceCreate.model_validate(
        {
            "type": "weekly",
            "payload": {
                "recurrence_description": "Team sync",
                **_blob_payload(),
            },
        }
    )

    normalized = _normalize_llm_recurrence(
        recurrence, "America/New_York", "Draft 3"
    )

    assert len(normalized.payload["blobs_of_week"]) == 1
    assert normalized.payload["blobs_of_week"][0]["description"] == "Team sync"


def test_normalize_applies_default_non_main_calendar_view():
    recurrence = RecurrenceCreate.model_validate(
        {
            "type": "single",
            "payload": {
                "recurrence_name": "Focused Work",
                "blob": _blob_payload(),
            },
        }
    )
    default_calendar_view = {
        "id": "google:acct:team",
        "name": "Team Calendar",
        "source": "google",
        "is_main": False,
        "account_key": "acct",
        "calendar_id": "team",
    }

    normalized = _normalize_llm_recurrence(
        recurrence,
        "America/New_York",
        "Draft 4",
        default_calendar_view=default_calendar_view,
        available_calendar_views_by_id={"google:acct:team": default_calendar_view},
    )

    assert normalized.payload["calendar_view"] == default_calendar_view


def test_normalize_keeps_explicit_main_calendar_view_when_default_non_main():
    recurrence = RecurrenceCreate.model_validate(
        {
            "type": "single",
            "payload": {
                "recurrence_name": "Inbox Zero",
                "calendar_view": {"id": "main", "is_main": True, "name": "Main"},
                "blob": _blob_payload(),
            },
        }
    )
    default_calendar_view = {
        "id": "google:acct:team",
        "name": "Team Calendar",
        "source": "google",
        "is_main": False,
    }

    normalized = _normalize_llm_recurrence(
        recurrence,
        "America/New_York",
        "Draft 5",
        default_calendar_view=default_calendar_view,
        available_calendar_views_by_id={"google:acct:team": default_calendar_view},
    )

    assert "calendar_view" not in normalized.payload
