from fastapi import APIRouter, Response, status

from backend.analytics import flush_open_preference_batches


analytics_router = APIRouter(prefix="/analytics", tags=["analytics"])


@analytics_router.post(
    "/flush-preference-batches",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="flush_preference_batches",
)
async def flush_preference_batches() -> Response:
    await flush_open_preference_batches()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
