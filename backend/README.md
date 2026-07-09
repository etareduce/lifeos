# Backend

`backend/` contains the FastAPI service layer for Elastisched.

## Responsibilities
- API routing for blobs, recurrences, occurrences, scheduling, and analytics.
- Database session management and schema initialization.
- Persistence models for recurrences and scheduled outputs.
- Translation between API payloads and `core`/`engine` scheduling primitives.

## Entry Point
- App: [`backend/main.py`](main.py)
- Local run: `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`

## Route Groups
- `/blobs` in [`backend/router.py`](router.py)
- `/recurrences` and `/occurrences` in [`backend/recurrence_router.py`](recurrence_router.py)
- `/schedule` in [`backend/schedule_router.py`](schedule_router.py)
- `/analytics` in [`backend/analytics_router.py`](analytics_router.py)

## Configuration
Primary env vars are read in [`backend/config.py`](config.py):
- `DATABASE_URL`
- `ANALYTICS_DATABASE_URL`
- `PREFERENCE_BATCH_SIZE`
