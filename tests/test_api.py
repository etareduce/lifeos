import os
import importlib
import json
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient


@pytest_asyncio.fixture
async def api_client(tmp_path_factory):
    db_path = tmp_path_factory.mktemp("db") / "test.db"
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{db_path}"

    from backend import db as db_module
    from backend import main as main_module

    importlib.reload(db_module)
    importlib.reload(main_module)

    await db_module.init_db()
    transport = ASGITransport(app=main_module.app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_create_and_get_blob(api_client):
    start = datetime(2024, 1, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=2)
    payload = {
        "name": "Morning Focus",
        "description": "Deep work block",
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


@pytest.mark.asyncio
async def test_update_blob(api_client):
    start = datetime(2024, 2, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    payload = {
        "name": "Standup",
        "description": "Daily sync",
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
            json={"name": "Standup Updated", "tags": ["team"]},
        )
        assert update_resp.status_code == 200
        updated = update_resp.json()

    assert updated["name"] == "Standup Updated"
    assert updated["tags"] == ["team"]


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
async def test_export_calendar_views_as_ndjson(api_client):
    start = datetime(2024, 4, 1, 9, 0, tzinfo=timezone.utc)
    end = start + timedelta(hours=1)
    base_blob = {
        "name": "Exported recurrence",
        "description": "Included in export",
        "tz": "UTC",
        "default_scheduled_timerange": {"start": start.isoformat(), "end": end.isoformat()},
        "schedulable_timerange": {
            "start": (start - timedelta(hours=1)).isoformat(),
            "end": (end + timedelta(hours=1)).isoformat(),
        },
        "policy": {},
        "dependencies": [],
        "tags": ["export"],
    }

    async with api_client as client:
        main_resp = await client.post(
            "/recurrences",
            json={"type": "single", "payload": {"blob": base_blob}},
        )
        assert main_resp.status_code == 201

        custom_resp = await client.post(
            "/recurrences",
            json={
                "type": "single",
                "payload": {
                    "blob": {
                        **base_blob,
                        "name": "Custom export recurrence",
                    },
                    "calendar_view": {
                        "id": "custom:export-test",
                        "name": "Export test calendar",
                        "source": "custom",
                        "is_main": False,
                    },
                },
            },
        )
        assert custom_resp.status_code == 201

        export_resp = await client.post(
            "/integrations/calendars/export",
            json={"calendar_view_ids": ["main", "custom:export-test"]},
        )
        assert export_resp.status_code == 200

    assert export_resp.headers["content-type"].startswith("application/x-ndjson")
    assert "attachment;" in export_resp.headers["content-disposition"]

    lines = [line for line in export_resp.text.splitlines() if line.strip()]
    assert len(lines) == 2

    exported = [json.loads(line) for line in lines]
    assert {item["calendar_view"]["id"] for item in exported} == {"main", "custom:export-test"}
    assert {item["recurrence"]["type"] for item in exported} == {"single"}
