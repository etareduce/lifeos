import os
import importlib

import pytest
from httpx import ASGITransport, AsyncClient


async def _client(tmp_path):
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{tmp_path / 'lifeos.db'}"
    os.environ["ANALYTICS_DATABASE_URL"] = f"sqlite+aiosqlite:///{tmp_path / 'analytics.db'}"

    from backend import db as db_module
    from backend import lifeos_router as lifeos_router_module
    from backend import main as main_module
    from backend import models as models_module

    importlib.reload(db_module)
    importlib.reload(models_module)
    importlib.reload(lifeos_router_module)
    importlib.reload(main_module)
    await db_module.init_db()
    return AsyncClient(transport=ASGITransport(app=main_module.app), base_url="http://test")


@pytest.mark.asyncio
async def test_capture_starts_as_page_and_can_convert_to_goal(tmp_path):
    async with await _client(tmp_path) as client:
        types_resp = await client.get("/lifeos/types")
        assert types_resp.status_code == 200
        assert {"Page", "Goal", "Daily Log"}.issubset(
            {type_def["name"] for type_def in types_resp.json()}
        )

        capture_resp = await client.post(
            "/lifeos/capture",
            json={"text": "Finish LifeOS MVP before August."},
        )
        assert capture_resp.status_code == 201
        page = capture_resp.json()
        assert page["type_name"] == "Page"
        assert page["fields"]["content"] == "Finish LifeOS MVP before August."

        convert_resp = await client.post(
            f"/lifeos/objects/{page['id']}/convert",
            json={
                "type_name": "Goal",
                "fields": {
                    "title": "Finish LifeOS MVP",
                    "description": "Finish LifeOS MVP before August.",
                    "progress": 0,
                    "deadline": "2026-08-01",
                    "related_objects": [],
                },
            },
        )
        assert convert_resp.status_code == 200
        goal = convert_resp.json()

    assert goal["id"] == page["id"]
    assert goal["type_name"] == "Goal"
    assert goal["fields"]["title"] == "Finish LifeOS MVP"
