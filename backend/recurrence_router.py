import uuid
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_session
from backend.models import (
    IntegrationConnectionModel,
    RecurrenceModel,
    ScheduledOccurrenceModel,
    ScheduleStateModel,
)
from backend.schemas import (
    OccurrenceRead,
    RecurrenceCreate,
    RecurrenceRead,
    RecurrenceUpdate,
    TimeRangeSchema,
)
from core.blob import Blob
from core.recurrence import (
    DateBlobRecurrence,
    DeltaBlobRecurrence,
    MultipleBlobOccurrence,
    SingleBlobOccurrence,
    WeeklyBlobRecurrence,
)
from core.timerange import TimeRange
from core.constants import DEFAULT_TZ
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from engine import Tag


recurrence_router = APIRouter(prefix="/recurrences", tags=["recurrences"])
occurrence_router = APIRouter(prefix="/occurrences", tags=["occurrences"])
MAX_OCCURRENCES_RESPONSE = 15000
logger = logging.getLogger(__name__)


async def _mark_schedule_dirty(session: AsyncSession) -> None:
    result = await session.execute(select(ScheduleStateModel))
    state = result.scalar_one_or_none()
    if state is None:
        state = ScheduleStateModel(dirty=True)
        session.add(state)
    else:
        state.dirty = True
    await session.execute(delete(ScheduledOccurrenceModel))
    await session.commit()


def _normalize_recurrence_type(value: str | None) -> str:
    raw = (value or "").strip().lower()
    raw = raw.replace("-", "_").replace(" ", "_")
    aliases = {
        "single_occurrence": "single",
        "weekly_cadence": "weekly",
        "fixed_interval": "delta",
        "annual_date": "date",
        "multiple_occurrence": "multiple",
    }
    return aliases.get(raw, raw)


def _parse_datetime(value: str) -> datetime:
    if isinstance(value, datetime):
        return value
    if not value:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Missing datetime in recurrence payload",
        )
    if isinstance(value, str) and value.endswith("Z"):
        value = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid datetime format in recurrence payload",
        ) from exc


def _parse_timerange(data: dict, tzinfo) -> TimeRange:
    start = _parse_datetime(data.get("start"))
    end = _parse_datetime(data.get("end"))
    if tzinfo:
        if start.tzinfo is None:
            start = start.replace(tzinfo=tzinfo)
        else:
            start = start.astimezone(tzinfo)
        if end.tzinfo is None:
            end = end.replace(tzinfo=tzinfo)
        else:
            end = end.astimezone(tzinfo)
    return TimeRange(start=start, end=end)


def _resolve_payload_tz(value: str | None):
    if not value:
        return DEFAULT_TZ
    try:
        return ZoneInfo(value)
    except ZoneInfoNotFoundError:
        return DEFAULT_TZ


def _serialize_tags(raw_tags) -> list[str]:
    tags = []
    for tag in raw_tags or []:
        if isinstance(tag, Tag):
            name = tag.get_name()
            if name:
                tags.append(name)
            continue
        if isinstance(tag, dict):
            name = str(tag.get("name") or "").strip()
            if name:
                tags.append(name)
            continue
        if isinstance(tag, str):
            name = tag.strip()
            if name:
                tags.append(name)
    return tags


def _payload_end_datetime(payload: dict, tzinfo) -> datetime | None:
    if not payload:
        return None
    raw = payload.get("end_date")
    if not raw:
        return None
    end_date = _parse_datetime(raw)
    if tzinfo:
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=tzinfo)
        else:
            end_date = end_date.astimezone(tzinfo)
    return end_date


def _blob_from_payload(data: dict) -> Blob:
    tzinfo = _resolve_payload_tz(data.get("tz"))
    default_tr = _parse_timerange(data.get("default_scheduled_timerange", {}), tzinfo)
    schedulable_tr = _parse_timerange(data.get("schedulable_timerange", {}), tzinfo)
    return Blob(
        default_scheduled_timerange=default_tr,
        schedulable_timerange=schedulable_tr,
        name=data.get("name") or "Unnamed Blob",
        description=data.get("description"),
        tz=tzinfo,
        policy=data.get("policy") or {},
        dependencies=set(data.get("dependencies") or []),
        tags=data.get("tags") or [],
    )


def _recurrence_from_payload(recurrence_type: str, payload: dict):
    recurrence_type = _normalize_recurrence_type(recurrence_type)
    payload = payload or {}
    if payload.get("end_date"):
        _parse_datetime(payload.get("end_date"))
    if recurrence_type == "single":
        blob = _blob_from_payload(payload.get("blob") or {})
        return SingleBlobOccurrence(blob=blob)
    if recurrence_type == "weekly":
        interval = int(payload.get("interval") or 1)
        blobs = [_blob_from_payload(blob) for blob in payload.get("blobs_of_week") or []]
        if not blobs:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Weekly recurrence requires blobs_of_week",
            )
        return WeeklyBlobRecurrence(blobs_of_week=blobs, interval=interval)
    if recurrence_type == "delta":
        delta_seconds = payload.get("delta_seconds")
        if delta_seconds is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Delta recurrence requires delta_seconds",
            )
        start_blob = _blob_from_payload(payload.get("start_blob") or {})
        return DeltaBlobRecurrence(
            delta=timedelta(seconds=float(delta_seconds)),
            start_blob=start_blob,
        )
    if recurrence_type == "date":
        blob = _blob_from_payload(payload.get("blob") or {})
        default_tr = blob.get_default_scheduled_timerange()
        tzinfo = blob.tz or default_tr.start.tzinfo
        start_local = default_tr.start.astimezone(tzinfo) if tzinfo else default_tr.start
        day_start = datetime(
            year=start_local.year,
            month=start_local.month,
            day=start_local.day,
            hour=0,
            minute=0,
            second=0,
            tzinfo=tzinfo,
        )
        day_end = datetime(
            year=start_local.year,
            month=start_local.month,
            day=start_local.day,
            hour=23,
            minute=59,
            second=59,
            tzinfo=tzinfo,
        )
        if default_tr.start.tzinfo:
            day_start = day_start.astimezone(default_tr.start.tzinfo)
            day_end = day_end.astimezone(default_tr.start.tzinfo)
        blob.set_default_scheduled_timerange(TimeRange(start=day_start, end=day_end))
        blob.set_schedulable_timerange(TimeRange(start=day_start, end=day_end))
        return DateBlobRecurrence(blob=blob)
    if recurrence_type == "multiple":
        blobs = [_blob_from_payload(blob) for blob in payload.get("blobs") or []]
        if not blobs:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Multiple occurrence requires blobs",
            )
        return MultipleBlobOccurrence(blobs=blobs)
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="Unsupported recurrence type",
    )


def _occurrence_id(recurrence_id: str, blob: Blob) -> str:
    start = blob.get_schedulable_timerange().start
    return f"{recurrence_id}:{start.isoformat()}"


def _recurrence_tzinfo(recurrence_obj):
    if isinstance(recurrence_obj, WeeklyBlobRecurrence):
        base_start = recurrence_obj.blobs_of_week[0].get_schedulable_timerange().start
        return base_start.tzinfo
    if isinstance(recurrence_obj, DeltaBlobRecurrence):
        return recurrence_obj.start_blob.get_schedulable_timerange().start.tzinfo
    if isinstance(recurrence_obj, DateBlobRecurrence):
        return recurrence_obj.blob.get_schedulable_timerange().start.tzinfo
    if isinstance(recurrence_obj, SingleBlobOccurrence):
        return recurrence_obj.blob.get_schedulable_timerange().start.tzinfo
    if isinstance(recurrence_obj, MultipleBlobOccurrence):
        return recurrence_obj.blobs[0].get_schedulable_timerange().start.tzinfo
    return None


def _coerce_timerange(timerange: TimeRange, tzinfo) -> TimeRange:
    if tzinfo is None:
        return timerange
    start = timerange.start
    end = timerange.end
    if start.tzinfo:
        start = start.astimezone(tzinfo)
    else:
        start = start.replace(tzinfo=tzinfo)
    if end.tzinfo:
        end = end.astimezone(tzinfo)
    else:
        end = end.replace(tzinfo=tzinfo)
    return TimeRange(start=start, end=end)


def _exclusion_set(payload: dict) -> set[int]:
    raw = payload.get("exclusions") or []
    exclusions = set()
    for item in raw:
        try:
            value = _parse_datetime(item)
        except HTTPException:
            continue
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        exclusions.add(int(value.timestamp()))
    return exclusions


def _calendar_view_id(payload: dict | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    calendar_view = payload.get("calendar_view")
    if not isinstance(calendar_view, dict):
        return None
    value = str(calendar_view.get("id") or "").strip()
    return value or None


async def _calendar_visibility_map(session: AsyncSession) -> dict[str, bool]:
    result = await session.execute(
        select(IntegrationConnectionModel).where(
            IntegrationConnectionModel.provider == "google"
        )
    )
    connection = result.scalar_one_or_none()
    if connection is None:
        return {}
    metadata = dict(connection.metadata_json or {})
    raw = metadata.get("calendar_visibility")
    if not isinstance(raw, dict):
        return {}
    return {str(key): bool(value) for key, value in raw.items()}


def _is_visible_recurrence(payload: dict | None, visibility_map: dict[str, bool]) -> bool:
    view_id = _calendar_view_id(payload)
    if not view_id:
        return True
    if view_id == "main":
        return True
    return visibility_map.get(view_id, True)


def _to_occurrence_schema(
    recurrence_id: str, recurrence_type: str, payload: dict, blob: Blob
) -> OccurrenceRead:
    default_tr = blob.get_default_scheduled_timerange()
    schedulable_tr = blob.get_schedulable_timerange()
    overrides = payload.get("occurrence_overrides") if isinstance(payload, dict) else None
    if isinstance(overrides, dict):
        occurrence_start = schedulable_tr.start
        occurrence_ts = int(occurrence_start.timestamp())
        override = None
        for key, value in overrides.items():
            if not isinstance(value, dict):
                continue
            try:
                key_dt = _parse_datetime(key)
            except HTTPException:
                continue
            if key_dt.tzinfo is None:
                key_dt = key_dt.replace(tzinfo=occurrence_start.tzinfo)
            else:
                key_dt = key_dt.astimezone(occurrence_start.tzinfo)
            if int(key_dt.timestamp()) == occurrence_ts:
                override = value
                break
        if override:
            tzinfo = blob.tz or occurrence_start.tzinfo
            sched_override = override.get("schedulable_timerange")
            if isinstance(sched_override, dict):
                candidate = _parse_timerange(sched_override, tzinfo)
                if candidate.start < candidate.end:
                    schedulable_tr = candidate
    return OccurrenceRead(
        id=_occurrence_id(recurrence_id, blob),
        recurrence_id=recurrence_id,
        recurrence_type=recurrence_type,
        recurrence_payload=payload,
        name=blob.name,
        description=blob.description,
        default_scheduled_timerange=TimeRangeSchema(
            start=default_tr.start, end=default_tr.end
        ),
        schedulable_timerange=TimeRangeSchema(
            start=schedulable_tr.start, end=schedulable_tr.end
        ),
        realized_timerange=None,
        tz=blob.tz.key if hasattr(blob.tz, "key") else str(blob.tz),
        policy=blob.policy or {},
        dependencies=list(blob.dependencies or []),
        tags=_serialize_tags(blob.tags),
    )


@recurrence_router.post(
    "",
    response_model=RecurrenceRead | list[RecurrenceRead],
    status_code=status.HTTP_201_CREATED,
    operation_id="create_recurrence",
)
async def create_recurrence(
    payload: RecurrenceCreate | list[RecurrenceCreate],
    session: AsyncSession = Depends(get_session),
) -> RecurrenceRead | list[RecurrenceRead]:
    if isinstance(payload, list):
        if not payload:
            return []
        recurrences = []
        for item in payload:
            normalized_type = _normalize_recurrence_type(item.type)
            _recurrence_from_payload(normalized_type, item.payload)
            recurrences.append(
                RecurrenceModel(
                    id=str(uuid.uuid4()),
                    type=normalized_type,
                    payload=item.payload,
                )
            )
        session.add_all(recurrences)
        await session.commit()
        await _mark_schedule_dirty(session)
        return [
            RecurrenceRead(id=item.id, type=item.type, payload=item.payload)
            for item in recurrences
        ]
    normalized_type = _normalize_recurrence_type(payload.type)
    _recurrence_from_payload(normalized_type, payload.payload)
    recurrence = RecurrenceModel(
        id=str(uuid.uuid4()),
        type=normalized_type,
        payload=payload.payload,
    )
    session.add(recurrence)
    await session.commit()
    await session.refresh(recurrence)
    await _mark_schedule_dirty(session)
    return RecurrenceRead(id=recurrence.id, type=recurrence.type, payload=recurrence.payload)


@recurrence_router.post(
    "/bulk", response_model=list[RecurrenceRead], operation_id="create_recurrences_bulk"
)
async def create_recurrences_bulk(
    payload: list[RecurrenceCreate], session: AsyncSession = Depends(get_session)
) -> list[RecurrenceRead]:
    if not payload:
        return []
    recurrences = []
    for item in payload:
        normalized_type = _normalize_recurrence_type(item.type)
        _recurrence_from_payload(normalized_type, item.payload)
        recurrences.append(
            RecurrenceModel(
                id=str(uuid.uuid4()),
                type=normalized_type,
                payload=item.payload,
            )
        )
    session.add_all(recurrences)
    await session.commit()
    await _mark_schedule_dirty(session)
    return [
        RecurrenceRead(id=item.id, type=item.type, payload=item.payload)
        for item in recurrences
    ]


@recurrence_router.get(
    "", response_model=list[RecurrenceRead], operation_id="list_recurrences"
)
async def list_recurrences(
    session: AsyncSession = Depends(get_session),
) -> list[RecurrenceRead]:
    result = await session.execute(select(RecurrenceModel))
    return [
        RecurrenceRead(id=item.id, type=item.type, payload=item.payload)
        for item in result.scalars().all()
    ]


@recurrence_router.get(
    "/{recurrence_id}", response_model=RecurrenceRead, operation_id="get_recurrence"
)
async def get_recurrence(
    recurrence_id: str, session: AsyncSession = Depends(get_session)
) -> RecurrenceRead:
    result = await session.execute(
        select(RecurrenceModel).where(RecurrenceModel.id == recurrence_id)
    )
    recurrence = result.scalar_one_or_none()
    if not recurrence:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurrence not found")
    return RecurrenceRead(id=recurrence.id, type=recurrence.type, payload=recurrence.payload)


@recurrence_router.put(
    "/{recurrence_id}", response_model=RecurrenceRead, operation_id="update_recurrence"
)
async def update_recurrence(
    recurrence_id: str, payload: RecurrenceUpdate, session: AsyncSession = Depends(get_session)
) -> RecurrenceRead:
    result = await session.execute(
        select(RecurrenceModel).where(RecurrenceModel.id == recurrence_id)
    )
    recurrence = result.scalar_one_or_none()
    if not recurrence:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurrence not found")

    new_type = _normalize_recurrence_type(payload.type or recurrence.type)
    new_payload = payload.payload if payload.payload is not None else recurrence.payload
    _recurrence_from_payload(new_type, new_payload)
    recurrence.type = new_type
    recurrence.payload = new_payload
    await session.commit()
    await session.refresh(recurrence)
    await _mark_schedule_dirty(session)
    return RecurrenceRead(id=recurrence.id, type=recurrence.type, payload=recurrence.payload)


@recurrence_router.delete(
    "/{recurrence_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    operation_id="delete_recurrence",
)
async def delete_recurrence(
    recurrence_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    result = await session.execute(
        select(RecurrenceModel).where(RecurrenceModel.id == recurrence_id)
    )
    recurrence = result.scalar_one_or_none()
    if not recurrence:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurrence not found")
    await session.delete(recurrence)
    await session.commit()
    await _mark_schedule_dirty(session)


@occurrence_router.get(
    "", response_model=list[OccurrenceRead], operation_id="list_occurrences"
)
async def list_occurrences(
    start: datetime = Query(..., description="Range start"),
    end: datetime = Query(..., description="Range end"),
    session: AsyncSession = Depends(get_session),
) -> list[OccurrenceRead]:
    if start.tzinfo and not end.tzinfo:
        end = end.replace(tzinfo=start.tzinfo)
    elif end.tzinfo and not start.tzinfo:
        start = start.replace(tzinfo=end.tzinfo)
    elif start.tzinfo and end.tzinfo and start.tzinfo != end.tzinfo:
        end = end.astimezone(start.tzinfo)
    timerange = TimeRange(start=start, end=end)
    visibility_map = await _calendar_visibility_map(session)
    result = await session.execute(select(RecurrenceModel))
    occurrences: list[OccurrenceRead] = []
    for recurrence in result.scalars().all():
        if not _is_visible_recurrence(recurrence.payload or {}, visibility_map):
            continue
        recurrence_type = _normalize_recurrence_type(recurrence.type)
        exclusions = _exclusion_set(recurrence.payload or {})
        recurrence_obj = _recurrence_from_payload(recurrence_type, recurrence.payload)
        recurrence_tz = _recurrence_tzinfo(recurrence_obj)
        recurrence_range = _coerce_timerange(timerange, recurrence_tz)
        end_date = _payload_end_datetime(recurrence.payload or {}, recurrence_tz)
        if end_date and end_date < recurrence_range.start:
            continue
        if end_date and end_date < recurrence_range.end:
            recurrence_range = TimeRange(start=recurrence_range.start, end=end_date)
        try:
            blobs = recurrence_obj.all_occurrences(recurrence_range)
        except Exception:
            logger.exception(
                "Skipping invalid recurrence during /occurrences: id=%s type=%s",
                recurrence.id,
                recurrence_type,
            )
            continue
        for blob in blobs:
            start = blob.get_schedulable_timerange().start
            if end_date and start > end_date:
                continue
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if int(start.timestamp()) in exclusions:
                continue
            occurrences.append(
                _to_occurrence_schema(
                    recurrence.id, recurrence_type, recurrence.payload, blob
                )
            )
            if len(occurrences) >= MAX_OCCURRENCES_RESPONSE:
                break
        if len(occurrences) >= MAX_OCCURRENCES_RESPONSE:
            break
    if occurrences:
        occurrence_ids = [occurrence.id for occurrence in occurrences]
        scheduled_result = await session.execute(
            select(ScheduledOccurrenceModel).where(
                ScheduledOccurrenceModel.id.in_(occurrence_ids)
            )
        )
        scheduled: dict[str, list[ScheduledOccurrenceModel]] = {}
        for item in scheduled_result.scalars().all():
            scheduled.setdefault(item.id, []).append(item)
        if scheduled:
            def _coerce_project(value: datetime) -> datetime:
                if value.tzinfo is None:
                    return value.replace(tzinfo=DEFAULT_TZ)
                return value.astimezone(DEFAULT_TZ)

            expanded = []
            for occurrence in occurrences:
                rows = scheduled.get(occurrence.id)
                if not rows:
                    expanded.append(occurrence)
                    continue
                for row in rows:
                    realized_start = _coerce_project(row.realized_start)
                    realized_end = _coerce_project(row.realized_end)
                    if (
                        _coerce_project(occurrence.schedulable_timerange.start)
                        <= realized_start
                        <= realized_end
                        <= _coerce_project(occurrence.schedulable_timerange.end)
                    ):
                        expanded.append(
                            occurrence.model_copy(
                                update={
                                    "realized_timerange": TimeRangeSchema(
                                        start=realized_start,
                                        end=realized_end,
                                    )
                                }
                            )
                        )
                    else:
                        expanded.append(occurrence)
            occurrences = expanded
    occurrences.sort(key=lambda item: item.default_scheduled_timerange.start)
    return occurrences
