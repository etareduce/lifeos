import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_session
from backend.models import BlobModel
from backend.schemas import BlobCreate, BlobRead, BlobUpdate, TimeRangeSchema
from core.constants import DEFAULT_TZ, PROJECT_TIMEZONE


router = APIRouter(prefix="/blobs", tags=["blobs"])


def _validate_timeranges(
    default_tr: TimeRangeSchema, schedulable_tr: TimeRangeSchema
) -> None:
    if default_tr.start > default_tr.end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="default_scheduled_timerange.start must be before default_scheduled_timerange.end",
        )
    if schedulable_tr.start > schedulable_tr.end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="schedulable_timerange.start must be before schedulable_timerange.end",
        )
    if not (
        schedulable_tr.start <= default_tr.start <= default_tr.end <= schedulable_tr.end
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="default_scheduled_timerange must be within schedulable_timerange",
        )


def _coerce_datetime_to_project(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=DEFAULT_TZ)
    return value.astimezone(DEFAULT_TZ)


def _coerce_timerange_to_project(timerange: TimeRangeSchema) -> TimeRangeSchema:
    return TimeRangeSchema(
        start=_coerce_datetime_to_project(timerange.start),
        end=_coerce_datetime_to_project(timerange.end),
    )


def _to_schema(blob: BlobModel) -> BlobRead:
    return BlobRead(
        id=blob.id,
        name=blob.name,
        description=blob.description,
        location=blob.location,
        default_scheduled_timerange=TimeRangeSchema(
            start=blob.default_scheduled_start, end=blob.default_scheduled_end
        ),
        schedulable_timerange=TimeRangeSchema(
            start=blob.schedulable_start, end=blob.schedulable_end
        ),
        realized_timerange=TimeRangeSchema(
            start=blob.realized_start, end=blob.realized_end
        )
        if blob.realized_start and blob.realized_end
        else None,
        tz=blob.tz,
        policy=blob.policy or {},
        dependencies=blob.dependencies or [],
        tags=blob.tags or [],
    )


@router.post(
    "",
    response_model=BlobRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_blob",
)
async def create_blob(
    payload: BlobCreate, session: AsyncSession = Depends(get_session)
) -> BlobRead:
    default_tr = _coerce_timerange_to_project(payload.default_scheduled_timerange)
    schedulable_tr = _coerce_timerange_to_project(payload.schedulable_timerange)
    realized_tr = (
        _coerce_timerange_to_project(payload.realized_timerange)
        if payload.realized_timerange
        else None
    )
    _validate_timeranges(default_tr, schedulable_tr)
    if realized_tr:
        _validate_timeranges(realized_tr, schedulable_tr)
    blob = BlobModel(
        id=str(uuid.uuid4()),
        name=payload.name,
        description=payload.description,
        location=payload.location,
        tz=PROJECT_TIMEZONE,
        default_scheduled_start=default_tr.start,
        default_scheduled_end=default_tr.end,
        schedulable_start=schedulable_tr.start,
        schedulable_end=schedulable_tr.end,
        realized_start=realized_tr.start if realized_tr else None,
        realized_end=realized_tr.end if realized_tr else None,
        policy=payload.policy,
        dependencies=payload.dependencies,
        tags=payload.tags,
    )
    session.add(blob)
    await session.commit()
    await session.refresh(blob)
    return _to_schema(blob)


@router.get("", response_model=list[BlobRead], operation_id="list_blobs")
async def list_blobs(
    overlaps_start: datetime | None = Query(default=None),
    overlaps_end: datetime | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[BlobRead]:
    if (overlaps_start is None) != (overlaps_end is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Both overlaps_start and overlaps_end are required to filter by overlap",
        )
    query = select(BlobModel)
    if overlaps_start and overlaps_end:
        query = query.where(
            BlobModel.schedulable_start < overlaps_end,
            BlobModel.schedulable_end > overlaps_start,
        )
    result = await session.execute(query)
    return [_to_schema(blob) for blob in result.scalars().all()]


@router.get("/{blob_id}", response_model=BlobRead, operation_id="get_blob")
async def get_blob(
    blob_id: str, session: AsyncSession = Depends(get_session)
) -> BlobRead:
    result = await session.execute(select(BlobModel).where(BlobModel.id == blob_id))
    blob = result.scalar_one_or_none()
    if not blob:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Blob not found")
    return _to_schema(blob)


@router.put("/{blob_id}", response_model=BlobRead, operation_id="update_blob")
async def update_blob(
    blob_id: str, payload: BlobUpdate, session: AsyncSession = Depends(get_session)
) -> BlobRead:
    result = await session.execute(select(BlobModel).where(BlobModel.id == blob_id))
    blob = result.scalar_one_or_none()
    if not blob:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Blob not found")

    default_tr = (
        _coerce_timerange_to_project(payload.default_scheduled_timerange)
        if payload.default_scheduled_timerange
        else TimeRangeSchema(start=blob.default_scheduled_start, end=blob.default_scheduled_end)
    )
    schedulable_tr = (
        _coerce_timerange_to_project(payload.schedulable_timerange)
        if payload.schedulable_timerange
        else TimeRangeSchema(start=blob.schedulable_start, end=blob.schedulable_end)
    )
    _validate_timeranges(default_tr, schedulable_tr)
    realized_tr = (
        _coerce_timerange_to_project(payload.realized_timerange)
        if payload.realized_timerange
        else None
    )
    if realized_tr:
        _validate_timeranges(realized_tr, schedulable_tr)

    if payload.name is not None:
        blob.name = payload.name
    if payload.description is not None:
        blob.description = payload.description
    if payload.location is not None:
        blob.location = payload.location
    blob.tz = PROJECT_TIMEZONE
    if payload.policy is not None:
        blob.policy = payload.policy
    if payload.dependencies is not None:
        blob.dependencies = payload.dependencies
    if payload.tags is not None:
        blob.tags = payload.tags
    blob.default_scheduled_start = default_tr.start
    blob.default_scheduled_end = default_tr.end
    blob.schedulable_start = schedulable_tr.start
    blob.schedulable_end = schedulable_tr.end
    if payload.realized_timerange is not None:
        blob.realized_start = realized_tr.start
        blob.realized_end = realized_tr.end

    await session.commit()
    await session.refresh(blob)
    return _to_schema(blob)


@router.delete("/{blob_id}", status_code=status.HTTP_204_NO_CONTENT, operation_id="delete_blob")
async def delete_blob(
    blob_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    result = await session.execute(select(BlobModel).where(BlobModel.id == blob_id))
    blob = result.scalar_one_or_none()
    if not blob:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Blob not found")
    await session.delete(blob)
    await session.commit()
