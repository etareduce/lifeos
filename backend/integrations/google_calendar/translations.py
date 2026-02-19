from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..primitives import EventPrimitive, RecurrencePrimitive


def translate_google_events_to_primitives(
    events: list[dict],
    *,
    calendar_id: str,
    calendar_name: str,
    calendar_time_zone: str = "UTC",
) -> list[RecurrencePrimitive]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for event in events or []:
        if event.get("status") == "cancelled":
            continue
        recurrence_key = str(event.get("recurringEventId") or event.get("id") or "").strip()
        if not recurrence_key:
            continue
        grouped[recurrence_key].append(event)

    recurrences: list[RecurrencePrimitive] = []
    for key, members in grouped.items():
        primitives = []
        for raw in members:
            primitive = _translate_google_event(
                raw,
                default_time_zone=raw.get("start", {}).get("timeZone")
                or raw.get("end", {}).get("timeZone")
                or calendar_time_zone,
            )
            if primitive is not None:
                primitives.append(primitive)
        if not primitives:
            continue
        primitives.sort(key=lambda item: item.default_start)
        first = members[0]
        title = str(first.get("summary") or primitives[0].name or "Untitled event").strip()
        description = str(first.get("description") or "").strip() or None
        recurrence = RecurrencePrimitive(
            key=f"{calendar_id}:{key}",
            provider="google",
            calendar_id=calendar_id,
            calendar_name=calendar_name,
            title=title,
            description=description,
            events=primitives,
        )
        recurrences.append(recurrence)

    recurrences.sort(
        key=lambda item: (
            item.events[0].default_start if item.events else datetime.max.replace(tzinfo=timezone.utc),
            item.title.lower(),
            item.key,
        )
    )
    return recurrences


def _translate_google_event(raw_event: dict, *, default_time_zone: str) -> EventPrimitive | None:
    start = _parse_google_datetime(raw_event.get("start"), default_time_zone)
    end = _parse_google_datetime(raw_event.get("end"), default_time_zone)
    if start is None or end is None or end <= start:
        return None
    return EventPrimitive(
        name=str(raw_event.get("summary") or "Untitled event").strip() or "Untitled event",
        description=str(raw_event.get("description") or "").strip() or None,
        default_start=start,
        default_end=end,
        timezone=default_time_zone or "UTC",
        external_event_id=str(raw_event.get("id") or "").strip() or None,
    )


def _parse_google_datetime(
    raw: dict | None,
    default_time_zone: str,
) -> datetime | None:
    if not isinstance(raw, dict):
        return None
    date_time_value = raw.get("dateTime")
    if isinstance(date_time_value, str) and date_time_value:
        return _parse_iso_datetime(date_time_value)
    date_value = raw.get("date")
    if isinstance(date_value, str) and date_value:
        try:
            date_obj = datetime.fromisoformat(date_value)
        except ValueError:
            return None
        tzinfo = _safe_zoneinfo(default_time_zone)
        return datetime(
            year=date_obj.year,
            month=date_obj.month,
            day=date_obj.day,
            tzinfo=tzinfo,
        )
    return None


def _parse_iso_datetime(value: str) -> datetime | None:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _safe_zoneinfo(value: str | None):
    try:
        return ZoneInfo(value or "UTC")
    except ZoneInfoNotFoundError:
        return timezone.utc
