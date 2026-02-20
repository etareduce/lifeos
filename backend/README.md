# Backend

`backend/` contains the FastAPI service layer for Elastisched.

## Responsibilities
- API routing for blobs, recurrences, occurrences, scheduling, integrations, and LLM workflows.
- Database session management and schema initialization.
- Persistence models for recurrences, scheduled outputs, and integration state.
- Translation between API payloads and `core`/`engine` scheduling primitives.

## Entry Point
- App: [`backend/main.py`](main.py)
- Local run: `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`

## Route Groups
- `/blobs` in [`backend/router.py`](router.py)
- `/recurrences` and `/occurrences` in [`backend/recurrence_router.py`](recurrence_router.py)
- `/schedule` in [`backend/schedule_router.py`](schedule_router.py)
- `/integrations` in [`backend/integrations/router.py`](integrations/router.py)
- `/llm` in [`backend/llm_router.py`](llm_router.py)

## Key Subfolders
- [`backend/integrations/`](integrations): sync + OAuth flows (Google Calendar adapter included).
- [`backend/llm/`](llm): model provider interfaces, tool execution runtime, and OpenAPI-based tool registry.

## Configuration
Primary env vars are read in [`backend/config.py`](config.py):
- `DATABASE_URL`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_OAUTH_SCOPES`
