from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.analytics_router import analytics_router
from backend.analytics_db import init_analytics_db
from backend.db import init_db
from backend.router import router as blob_router
from backend.recurrence_router import (
    occurrence_router,
    recurrence_router,
)
from backend.schedule_router import schedule_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    await init_analytics_db()
    yield


app = FastAPI(title="Elastisched API", lifespan=lifespan)
_UI_DIR = Path(__file__).resolve().parents[2] / "frontend"
if _UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=_UI_DIR, html=True), name="ui")


@app.get("/health", operation_id="health_check")
async def health() -> dict:
    return {"status": "ok"}


app.include_router(blob_router)
app.include_router(recurrence_router)
app.include_router(occurrence_router)
app.include_router(schedule_router)
app.include_router(analytics_router)
