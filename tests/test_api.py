import os
import importlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


async def _build_api_client(tmp_path_factory, *, batch_size: int | None = None):
    db_path = tmp_path_factory.mktemp("db") / "test.db"
    analytics_db_path = db_path.parent / "analytics.db"
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{db_path}"
    os.environ["ANALYTICS_DATABASE_URL"] = f"sqlite+aiosqlite:///{analytics_db_path}"
    if batch_size is None:
        os.environ.pop("PREFERENCE_BATCH_SIZE", None)
    else:
        os.environ["PREFERENCE_BATCH_SIZE"] = str(batch_size)

    from backend import analytics as analytics_module
    from backend import analytics_db as analytics_db_module
    from backend import db as db_module
    from backend import main as main_module
    from backend import models as models_module
    from backend import recurrence_router as recurrence_router_module

    importlib.reload(analytics_db_module)
    importlib.reload(db_module)
    importlib.reload(models_module)
    importlib.reload(analytics_module)
    importlib.reload(recurrence_router_module)
    importlib.reload(main_module)

    await db_module.init_db()
    await analytics_db_module.init_analytics_db()
    transport = ASGITransport(app=main_module.app)
    client = AsyncClient(transport=transport, base_url="http://test")
    client._analytics_db_path = analytics_db_path
    return client


@pytest_asyncio.fixture
async def api_client(tmp_path_factory):
    return await _build_api_client(tmp_path_factory)


@pytest.mark.asyncio
async def test_create_and_get_blob(api_client):
    start = datetime(2024, 1, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=2)
    payload = {
        "name": "Morning Focus",
        "description": "Deep work block",
        "location": "Library - 2nd floor",
        "tz": "UTC",
        "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
        "schedulable_timerange": {
            "start": (start - timedelta(hours=1)).isoformat(),
            "end": (end + timedelta(hours=1)).isoformat(),
        },
        "policy": {"kind": "fixed"},
        "dependencies": [],
        "tags": ["focus"],
    }

    async with api_client as client:
        create_resp = await client.post("/blobs", json=payload)
        assert create_resp.status_code == 201
        created = create_resp.json()

        get_resp = await client.get(f"/blobs/{created['id']}")
        assert get_resp.status_code == 200
        fetched = get_resp.json()

    assert fetched["name"] == payload["name"]
    def _coerce_utc(value: str) -> datetime:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    assert _coerce_utc(fetched["default_scheduled_timerange"]["start"]) == _coerce_utc(
        payload["default_scheduled_timerange"]["start"]
    )
    assert fetched["location"] == payload["location"]


@pytest.mark.asyncio
async def test_update_blob(api_client):
    start = datetime(2024, 2, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    payload = {
        "name": "Standup",
        "description": "Daily sync",
        "location": None,
        "tz": "UTC",
        "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
        "schedulable_timerange": {
            "start": (start - timedelta(minutes=30)).isoformat(),
            "end": (end + timedelta(minutes=30)).isoformat(),
        },
        "policy": {},
        "dependencies": [],
        "tags": [],
    }

    async with api_client as client:
        create_resp = await client.post("/blobs", json=payload)
        blob_id = create_resp.json()["id"]

        update_resp = await client.put(
            f"/blobs/{blob_id}",
            json={"name": "Standup Updated", "location": "Conference Room B", "tags": ["team"]},
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()

    assert updated["name"] == "Standup Updated"
    assert updated["location"] == "Conference Room B"
    assert updated["tags"] == ["team"]


@pytest.mark.asyncio
async def test_occurrence_includes_blob_location(api_client):
    start = datetime(2024, 2, 15, 14, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    payload = {
        "recurrence_name": "Dentist",
        "recurrence_description": "Routine checkup",
        "blob": {
            "name": "Dentist",
            "description": "Routine checkup",
            "location": "Downtown Clinic",
            "tz": "UTC",
            "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "schedulable_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "policy": {},
            "dependencies": [],
            "tags": [],
        },
    }

    async with api_client as client:
        create_resp = await client.post("/recurrences", json={"type": "single", "payload": payload})
        assert create_resp.status_code == 201

        list_resp = await client.get(
            "/occurrences",
            params={
                "start": (start - timedelta(days=1)).isoformat(),
                "end": (end + timedelta(days=1)).isoformat(),
            },
        )
        assert list_resp.status_code == 200
        occurrences = list_resp.json()

    assert len(occurrences) == 1
    assert occurrences[0]["location"] == "Downtown Clinic"


@pytest.mark.asyncio
async def test_list_blobs_with_overlap_filter(api_client):
    base = datetime(2024, 3, 1, 9, 0, tzinfo=timezone.utc)
    payloads = [
        {
            "name": "Morning",
            "description": None,
            "tz": "UTC",
            "default_scheduled_timerange": {
                "start": base.isoformat(),
                "end": (base + timedelta(hours=1)).isoformat(),
            },
            "schedulable_timerange": {
                "start": (base - timedelta(hours=1)).isoformat(),
                "end": (base + timedelta(hours=2)).isoformat(),
            },
            "policy": {},
            "dependencies": [],
            "tags": [],
        },
        {
            "name": "Afternoon",
            "description": None,
            "tz": "UTC",
            "default_scheduled_timerange": {
                "start": (base + timedelta(hours=6)).isoformat(),
                "end": (base + timedelta(hours=7)).isoformat(),
            },
            "schedulable_timerange": {
                "start": (base + timedelta(hours=5)).isoformat(),
                "end": (base + timedelta(hours=8)).isoformat(),
            },
            "policy": {},
            "dependencies": [],
            "tags": [],
        },
    ]

    async with api_client as client:
        for payload in payloads:
            resp = await client.post("/blobs", json=payload)
            assert resp.status_code == 201

        overlap_start = (base + timedelta(minutes=30)).isoformat()
        overlap_end = (base + timedelta(hours=1, minutes=30)).isoformat()
        list_resp = await client.get(
            "/blobs",
            params={"overlaps_start": overlap_start, "overlaps_end": overlap_end},
        )
        assert list_resp.status_code == 200
        listed = list_resp.json()

    assert len(listed) == 1
    assert listed[0]["name"] == "Morning"


@pytest.mark.asyncio
async def test_logs_occurrence_completion_analytics(tmp_path_factory):
    api_client = await _build_api_client(tmp_path_factory)
    start = datetime(2024, 5, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    payload = {
        "recurrence_name": "Write report",
        "recurrence_description": "Quarterly review",
        "blob": {
            "name": "Write report",
            "description": "Quarterly review",
            "tz": "UTC",
            "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "schedulable_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "policy": {"show_on_tasks_page": True},
            "dependencies": ["dep-1"],
            "tags": ["work", "writing"],
        },
    }

    async with api_client as client:
        create_resp = await client.post("/recurrences", json={"type": "single", "payload": payload})
        assert create_resp.status_code == 201
        created = create_resp.json()
        occurrence_key = payload["blob"]["schedulable_timerange"]["start"]
        finished_at = (start + timedelta(minutes=35)).isoformat()
        update_resp = await client.put(
            f"/recurrences/{created['id']}",
            json={
                "type": "single",
                "payload": {
                    **payload,
                    "occurrence_overrides": {
                        occurrence_key: {
                            "finished_at": finished_at,
                        }
                    },
                },
            },
        )
        assert update_resp.status_code == 200

    conn = sqlite3.connect(api_client._analytics_db_path)
    try:
        row = conn.execute(
            "SELECT recurrence_id, duration_seconds, occurrence_snapshot, recurrence_snapshot "
            "FROM occurrence_completion_events"
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    assert row[0] == created["id"]
    assert row[1] == 35 * 60
    occurrence_snapshot = json.loads(row[2])
    recurrence_snapshot = json.loads(row[3])
    assert occurrence_snapshot["after"]["name"] == "Write report"
    assert sorted(occurrence_snapshot["after"]["tags"]) == ["work", "writing"]
    assert recurrence_snapshot["after"]["payload"]["recurrence_name"] == "Write report"


@pytest.mark.asyncio
async def test_batches_manual_schedule_preference_updates(tmp_path_factory):
    api_client = await _build_api_client(tmp_path_factory, batch_size=2)
    start = datetime(2024, 6, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    occurrence_key = start.isoformat()
    payload = {
        "recurrence_name": "Prepare slides",
        "blob": {
            "name": "Prepare slides",
            "description": "Deck work",
            "tz": "UTC",
            "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "schedulable_timerange": {
                "start": start.isoformat(),
                "end": (end + timedelta(hours=2)).isoformat(),
            },
            "policy": {},
            "dependencies": [],
            "tags": ["deep-work"],
        },
    }

    async with api_client as client:
        create_resp = await client.post("/recurrences", json={"type": "single", "payload": payload})
        assert create_resp.status_code == 201
        created = create_resp.json()

        first_payload = {
            **payload,
            "occurrence_overrides": {
                occurrence_key: {
                    "schedulable_timerange": {
                        "start": (start + timedelta(minutes=30)).isoformat(),
                        "end": (end + timedelta(minutes=30)).isoformat(),
                    }
                }
            },
        }
        first_resp = await client.put(
            f"/recurrences/{created['id']}",
            json={"type": "single", "payload": first_payload},
        )
        assert first_resp.status_code == 200

        second_payload = {
            **payload,
            "occurrence_overrides": {
                occurrence_key: {
                    "schedulable_timerange": {
                        "start": (start + timedelta(hours=1)).isoformat(),
                        "end": (end + timedelta(hours=1)).isoformat(),
                    }
                }
            },
        }
        second_resp = await client.put(
            f"/recurrences/{created['id']}",
            json={"type": "single", "payload": second_payload},
        )
        assert second_resp.status_code == 200

    conn = sqlite3.connect(api_client._analytics_db_path)
    try:
        row = conn.execute(
            "SELECT edit_count, closed_at, before_state, after_state, edits "
            "FROM schedule_feedback_batches"
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    assert row[0] == 2
    assert row[1] is not None
    before_state = json.loads(row[2])
    after_state = json.loads(row[3])
    edits = json.loads(row[4])
    assert before_state["recurrence_count"] == 1
    assert after_state["recurrence_count"] == 1
    assert len(edits) == 2
    assert edits[0]["occurrence_before"]["name"] == "Prepare slides"
    assert edits[-1]["after_schedulable_timerange"]["start"] == (
        start + timedelta(hours=1)
    ).isoformat()


@pytest.mark.asyncio
async def test_flush_preference_batches_closes_partial_batch(tmp_path_factory):
    api_client = await _build_api_client(tmp_path_factory, batch_size=20)
    start = datetime(2024, 7, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    occurrence_key = start.isoformat()
    payload = {
        "recurrence_name": "Planning block",
        "blob": {
            "name": "Planning block",
            "description": "Weekly planning",
            "tz": "UTC",
            "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
            "schedulable_timerange": {
                "start": start.isoformat(),
                "end": (end + timedelta(hours=2)).isoformat(),
            },
            "policy": {},
            "dependencies": [],
            "tags": ["planning"],
        },
    }

    async with api_client as client:
        create_resp = await client.post("/recurrences", json={"type": "single", "payload": payload})
        assert create_resp.status_code == 201
        created = create_resp.json()

        update_payload = {
            **payload,
            "occurrence_overrides": {
                occurrence_key: {
                    "schedulable_timerange": {
                        "start": (start + timedelta(minutes=45)).isoformat(),
                        "end": (end + timedelta(minutes=45)).isoformat(),
                    }
                }
            },
        }
        update_resp = await client.put(
            f"/recurrences/{created['id']}",
            json={"type": "single", "payload": update_payload},
        )
        assert update_resp.status_code == 200

        flush_resp = await client.post("/analytics/flush-preference-batches")
        assert flush_resp.status_code == 204

    conn = sqlite3.connect(api_client._analytics_db_path)
    try:
        row = conn.execute(
            "SELECT edit_count, closed_at FROM schedule_feedback_batches"
        ).fetchone()
    finally:
        conn.close()

    assert row is not None
    assert row[0] == 1
    assert row[1] is not None

