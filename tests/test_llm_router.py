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
