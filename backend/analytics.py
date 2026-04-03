import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from backend.analytics_db import AnalyticsSessionLocal
from backend.analytics_models import (
    OccurrenceCompletionEventModel,
    ScheduleFeedbackBatchModel,
)
from backend.config import get_preference_batch_size
from backend.models import RecurrenceModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _is_main_recurrence_payload(payload: dict | None) -> bool:
    if not isinstance(payload, dict):
        return True
    calendar_view = payload.get("calendar_view")
    if not isinstance(calendar_view, dict):
        return True
    value = str(calendar_view.get("id") or "").strip()
    return not value or value == "main"


def _normalize_datetime(value) -> str | None:
    if not value:
        return None
    if isinstance(value, datetime):
        target = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return target.astimezone(timezone.utc).isoformat()
    if isinstance(value, str):
        return value
    return None


def _normalize_payload_snapshot(payload: dict | None) -> dict:
    return dict(payload or {})


def _serialize_recurrence_row(
    recurrence_id: str,
    recurrence_type: str,
    payload: dict | None,
    created_at: datetime | None,
    updated_at: datetime | None,
) -> dict:
    return {
        "id": recurrence_id,
        "type": recurrence_type,
        "created_at": _normalize_datetime(created_at),
        "updated_at": _normalize_datetime(updated_at),
        "payload": _normalize_payload_snapshot(payload),
    }


async def _build_calendar_snapshot(
    session,
    *,
    current_recurrence_id: str | None = None,
    current_recurrence_type: str | None = None,
    current_payload: dict | None = None,
    current_updated_at: datetime | None = None,
) -> dict:
    rows = (await session.execute(select(RecurrenceModel))).scalars().all()
    recurrences = []
    seen_current = False
    for row in rows:
        row_type = row.type
        row_payload = row.payload or {}
        row_updated_at = row.updated_at
        if row.id == current_recurrence_id:
            row_type = current_recurrence_type or row_type
            row_payload = current_payload if current_payload is not None else row_payload
            row_updated_at = current_updated_at or row_updated_at
            seen_current = True
        if not _is_main_recurrence_payload(row_payload):
            continue
        recurrences.append(
            _serialize_recurrence_row(
                row.id,
                row_type,
                row_payload,
                row.created_at,
                row_updated_at,
            )
        )
    if (
        current_recurrence_id
        and not seen_current
        and _is_main_recurrence_payload(current_payload)
    ):
        recurrences.append(
            _serialize_recurrence_row(
                current_recurrence_id,
                current_recurrence_type or "single",
                current_payload,
                None,
                current_updated_at,
            )
        )
    recurrences.sort(key=lambda item: item["id"])
    return {
        "captured_at": _normalize_datetime(_utcnow()),
        "recurrence_count": len(recurrences),
        "recurrences": recurrences,
    }


def _parse_occurrence_key(value: str):
    from backend.recurrence_router import _parse_datetime

    parsed = _parse_datetime(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _materialize_occurrence_snapshot(
    recurrence_id: str,
    recurrence_type: str,
    payload: dict,
    occurrence_key: str,
) -> dict | None:
    from backend.recurrence_router import (
        _normalize_recurrence_type,
        _occurrence_id,
        _recurrence_from_payload,
        _recurrence_tzinfo,
        _serialize_tags,
        _to_occurrence_schema,
        _coerce_timerange,
    )
    from core.timerange import TimeRange

    normalized_type = _normalize_recurrence_type(recurrence_type)
    recurrence_obj = _recurrence_from_payload(normalized_type, payload or {})
    recurrence_tz = _recurrence_tzinfo(recurrence_obj)
    target = _parse_occurrence_key(occurrence_key)
    if recurrence_tz is not None:
        target = target.astimezone(recurrence_tz) if target.tzinfo else target.replace(tzinfo=recurrence_tz)
    search_range = _coerce_timerange(
        TimeRange(start=target - timedelta(days=2), end=target + timedelta(days=2)),
        recurrence_tz,
    )
    target_ts = int(target.timestamp())
    for blob in recurrence_obj.all_occurrences(search_range):
        blob_start = blob.get_schedulable_timerange().start
        if blob_start.tzinfo is None:
            blob_start = blob_start.replace(tzinfo=target.tzinfo or timezone.utc)
        else:
            blob_start = blob_start.astimezone(target.tzinfo or timezone.utc)
        if int(blob_start.timestamp()) != target_ts:
            continue
        occurrence = _to_occurrence_schema(recurrence_id, normalized_type, payload, blob)
        snapshot = occurrence.model_dump(mode="json")
        snapshot["occurrence_key"] = occurrence_key
        snapshot["occurrence_id"] = _occurrence_id(recurrence_id, blob)
        snapshot["tags"] = _serialize_tags(blob.tags)
        return snapshot
    return None


def _changed_overrides(previous_payload: dict | None, next_payload: dict | None) -> set[str]:
    previous = (
        previous_payload.get("occurrence_overrides")
        if isinstance(previous_payload, dict)
        else None
    )
    current = (
        next_payload.get("occurrence_overrides") if isinstance(next_payload, dict) else None
    )
    keys = set(previous.keys() if isinstance(previous, dict) else [])
    keys.update(current.keys() if isinstance(current, dict) else [])
    return keys


def _normalize_occurrence_key(value) -> str | None:
    if not value:
        return None
    try:
        return _parse_occurrence_key(str(value)).astimezone(timezone.utc).isoformat()
    except Exception:
        return None


def _normalize_recurrence_type_value(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    aliases = {
        "one_time": "single",
        "weekly_cadence": "weekly",
        "fixed_interval": "delta",
        "annual_date": "date",
    }
    return aliases.get(normalized, normalized)


def _payload_default_ranges_by_occurrence_key(
    recurrence_type: str | None, payload: dict | None
) -> dict[str, dict]:
    if not isinstance(payload, dict):
        return {}

    normalized_type = _normalize_recurrence_type_value(recurrence_type)
    blob_candidates = []
    if normalized_type in {"single", "date"}:
        blob_candidates = [payload.get("blob")]
    elif normalized_type == "multiple":
        blob_candidates = payload.get("blobs") or []
    elif normalized_type == "weekly":
        blob_candidates = payload.get("blobs_of_week") or []
    elif normalized_type == "delta":
        blob_candidates = [payload.get("start_blob")]

    result: dict[str, dict] = {}
    for blob_payload in blob_candidates:
        if not isinstance(blob_payload, dict):
            continue
        default_range = blob_payload.get("default_scheduled_timerange")
        schedulable_range = blob_payload.get("schedulable_timerange")
        if not isinstance(default_range, dict) or not isinstance(schedulable_range, dict):
            continue
        occurrence_key = _normalize_occurrence_key(schedulable_range.get("start"))
        if not occurrence_key:
            continue
        if default_range.get("start") is None or default_range.get("end") is None:
            continue
        result[occurrence_key] = {
            "occurrence_key": occurrence_key,
            "default_scheduled_timerange": {
                "start": default_range.get("start"),
                "end": default_range.get("end"),
            },
        }
    return result


def _completion_events(previous_payload: dict | None, next_payload: dict | None) -> list[dict]:
    previous = (
        previous_payload.get("occurrence_overrides")
        if isinstance(previous_payload, dict)
        else None
    )
    current = (
        next_payload.get("occurrence_overrides") if isinstance(next_payload, dict) else None
    )
    events = []
    for key in _changed_overrides(previous_payload, next_payload):
        before = previous.get(key) if isinstance(previous, dict) else None
        after = current.get(key) if isinstance(current, dict) else None
        before_finish = before.get("finished_at") if isinstance(before, dict) else None
        after_finish = after.get("finished_at") if isinstance(after, dict) else None
        if not after_finish or after_finish == before_finish:
            continue
        events.append({"occurrence_key": key, "finished_at": after_finish})
    return events


def _preference_edits(
    previous_type: str,
    previous_payload: dict | None,
    next_type: str,
    next_payload: dict | None,
) -> list[dict]:
    previous = (
        previous_payload.get("occurrence_overrides")
        if isinstance(previous_payload, dict)
        else None
    )
    current = (
        next_payload.get("occurrence_overrides") if isinstance(next_payload, dict) else None
    )
    edits = []
    for key in _changed_overrides(previous_payload, next_payload):
        before = previous.get(key) if isinstance(previous, dict) else None
        after = current.get(key) if isinstance(current, dict) else None
        before_range = before.get("schedulable_timerange") if isinstance(before, dict) else None
        after_range = after.get("schedulable_timerange") if isinstance(after, dict) else None
        if not after_range or after_range == before_range:
            pass
        else:
            edits.append(
                {
                    "occurrence_key": key,
                    "before_override": dict(before or {}),
                    "after_override": dict(after or {}),
                    "before_schedulable_timerange": dict(before_range or {}) if before_range else None,
                    "after_schedulable_timerange": dict(after_range or {}),
                    "change_kind": "override_schedulable_timerange",
                }
            )
        before_default_range = (
            before.get("default_scheduled_timerange") if isinstance(before, dict) else None
        )
        after_default_range = (
            after.get("default_scheduled_timerange") if isinstance(after, dict) else None
        )
        if not after_default_range or after_default_range == before_default_range:
            continue
        edits.append(
            {
                "occurrence_key": key,
                "before_override": dict(before or {}),
                "after_override": dict(after or {}),
                "before_default_scheduled_timerange": (
                    dict(before_default_range or {}) if before_default_range else None
                ),
                "after_default_scheduled_timerange": dict(after_default_range or {}),
                "change_kind": "override_default_scheduled_timerange",
            }
        )

    previous_defaults = _payload_default_ranges_by_occurrence_key(previous_type, previous_payload)
    current_defaults = _payload_default_ranges_by_occurrence_key(next_type, next_payload)
    occurrence_keys = set(previous_defaults.keys())
    occurrence_keys.update(current_defaults.keys())
    for key in occurrence_keys:
        before_item = previous_defaults.get(key) or {}
        after_item = current_defaults.get(key) or {}
        before_default_range = before_item.get("default_scheduled_timerange")
        after_default_range = after_item.get("default_scheduled_timerange")
        if not after_default_range or after_default_range == before_default_range:
            continue
        edits.append(
            {
                "occurrence_key": key,
                "before_default_scheduled_timerange": (
                    dict(before_default_range or {}) if before_default_range else None
                ),
                "after_default_scheduled_timerange": dict(after_default_range or {}),
                "change_kind": "payload_default_scheduled_timerange",
            }
        )
    return edits


async def record_recurrence_update_signals(
    session,
    *,
    recurrence_id: str,
    previous_type: str,
    previous_payload: dict | None,
    previous_created_at: datetime | None,
    previous_updated_at: datetime | None,
    next_type: str,
    next_payload: dict | None,
    next_updated_at: datetime,
) -> None:
    completion_events = _completion_events(previous_payload, next_payload)
    preference_edits = _preference_edits(
        previous_type, previous_payload, next_type, next_payload
    )
    if not completion_events and not preference_edits:
        return

    before_state = None
    after_state = None
    if preference_edits:
        before_state = await _build_calendar_snapshot(
            session,
            current_recurrence_id=recurrence_id,
            current_recurrence_type=previous_type,
            current_payload=previous_payload,
            current_updated_at=previous_updated_at,
        )
        after_state = await _build_calendar_snapshot(
            session,
            current_recurrence_id=recurrence_id,
            current_recurrence_type=next_type,
            current_payload=next_payload,
            current_updated_at=next_updated_at,
        )

    async with AnalyticsSessionLocal() as analytics_session:
        now = _utcnow()
        for event in completion_events:
            occurrence_key = event["occurrence_key"]
            finished_at = _parse_occurrence_key(event["finished_at"])
            occurrence_snapshot = _materialize_occurrence_snapshot(
                recurrence_id, next_type, next_payload or {}, occurrence_key
            ) or _materialize_occurrence_snapshot(
                recurrence_id, previous_type, previous_payload or {}, occurrence_key
            )
            sched_start_raw = (
                occurrence_snapshot.get("schedulable_timerange", {}).get("start")
                if occurrence_snapshot
                else None
            )
            sched_start = _parse_occurrence_key(sched_start_raw) if sched_start_raw else finished_at
            duration_seconds = max(0, int((finished_at - sched_start).total_seconds()))
            completion_kind = (
                "retroactive" if finished_at < now - timedelta(seconds=60) else "immediate"
            )
            analytics_session.add(
                OccurrenceCompletionEventModel(
                    id=str(uuid.uuid4()),
                    recurrence_id=recurrence_id,
                    recurrence_type=next_type,
                    occurrence_key=occurrence_key,
                    logged_at=now,
                    finished_at=finished_at,
                    duration_seconds=duration_seconds,
                    completion_kind=completion_kind,
                    recurrence_created_at=previous_created_at,
                    recurrence_updated_at=next_updated_at or previous_updated_at,
                    occurrence_snapshot={
                        "before": _materialize_occurrence_snapshot(
                            recurrence_id,
                            previous_type,
                            previous_payload or {},
                            occurrence_key,
                        ),
                        "after": occurrence_snapshot,
                    },
                    recurrence_snapshot={
                        "before": _serialize_recurrence_row(
                            recurrence_id,
                            previous_type,
                            previous_payload or {},
                            previous_created_at,
                            previous_updated_at,
                        ),
                        "after": _serialize_recurrence_row(
                            recurrence_id,
                            next_type,
                            next_payload or {},
                            previous_created_at,
                            next_updated_at,
                        ),
                    },
                )
            )

        if preference_edits:
            detailed_edits = []
            for edit in preference_edits:
                occurrence_key = edit["occurrence_key"]
                detailed_edits.append(
                    {
                        **edit,
                        "recurrence_id": recurrence_id,
                        "recurrence_type_before": previous_type,
                        "recurrence_type_after": next_type,
                        "occurrence_before": _materialize_occurrence_snapshot(
                            recurrence_id,
                            previous_type,
                            previous_payload or {},
                            occurrence_key,
                        ),
                        "occurrence_after": _materialize_occurrence_snapshot(
                            recurrence_id,
                            next_type,
                            next_payload or {},
                            occurrence_key,
                        ),
                    }
                )

            batch_size = get_preference_batch_size()
            result = await analytics_session.execute(
                select(ScheduleFeedbackBatchModel)
                .where(ScheduleFeedbackBatchModel.closed_at.is_(None))
                .order_by(ScheduleFeedbackBatchModel.opened_at.desc())
            )
            batch = result.scalars().first()
            if batch is None:
                batch = ScheduleFeedbackBatchModel(
                    id=str(uuid.uuid4()),
                    opened_at=now,
                    updated_at=now,
                    closed_at=None,
                    batch_size=batch_size,
                    edit_count=0,
                    before_state=before_state or {},
                    after_state=before_state or {},
                    edits=[],
                )
                analytics_session.add(batch)
            edits = list(batch.edits or [])
            edits.extend(detailed_edits)
            batch.edits = edits
            batch.edit_count = len(edits)
            batch.after_state = after_state or {}
            batch.updated_at = now
            if batch.edit_count >= batch.batch_size:
                batch.closed_at = now

        await analytics_session.commit()


async def flush_open_preference_batches() -> int:
    async with AnalyticsSessionLocal() as analytics_session:
        now = _utcnow()
        result = await analytics_session.execute(
            select(ScheduleFeedbackBatchModel).where(
                ScheduleFeedbackBatchModel.closed_at.is_(None)
            )
        )
        batches = result.scalars().all()
        flushed = 0
        for batch in batches:
            batch.closed_at = now
            batch.updated_at = now
            flushed += 1
        if flushed:
            await analytics_session.commit()
        return flushed
