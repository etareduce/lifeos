from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from .client import GoogleCalendarClient
from .translations import (
    translate_google_events_to_primitives,
)
from ..primitives import RecurrencePrimitive


class GoogleCalendarAdapter:
    provider = "google"

    def __init__(self, access_token: str) -> None:
        self._client = GoogleCalendarClient(access_token)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get_account_info(self) -> dict:
        return await self._client.get_account_info()

    async def list_calendars(self) -> list[dict]:
        calendars = await self._client.list_calendars()
        normalized: list[dict] = []
        for calendar in calendars:
            cal_id = str(calendar.get("id") or "").strip()
            if not cal_id:
                continue
            normalized.append(
                {
                    "id": cal_id,
                    "name": str(calendar.get("summary") or cal_id),
                    "description": str(calendar.get("description") or "").strip() or None,
                    "time_zone": str(calendar.get("timeZone") or "UTC"),
                    "primary": bool(calendar.get("primary")),
                    "selected": bool(calendar.get("selected", True)),
                    "access_role": str(calendar.get("accessRole") or "reader"),
                }
            )
        return normalized

    async def list_recurrence_primitives(
        self,
        *,
        calendar_ids: list[str],
        start: datetime,
        end: datetime,
    ) -> list[RecurrencePrimitive]:
        calendars = await self.list_calendars()
        calendars_by_id = {item["id"]: item for item in calendars}
        selected_ids = [item for item in calendar_ids if item in calendars_by_id]
        if not selected_ids:
            return []

        semaphore = asyncio.Semaphore(6)

        async def _load_calendar_recurrences(calendar_id: str) -> list[RecurrencePrimitive]:
            calendar = calendars_by_id[calendar_id]
            async with semaphore:
                events = await self._client.list_events(
                    calendar_id=calendar_id,
                    start=start,
                    end=end,
                )
            return translate_google_events_to_primitives(
                events,
                calendar_id=calendar_id,
                calendar_name=calendar.get("name") or calendar_id,
                calendar_time_zone=calendar.get("time_zone") or "UTC",
            )

        groups = await asyncio.gather(*(_load_calendar_recurrences(item) for item in selected_ids))
        recurrences = [recurrence for group in groups for recurrence in group]
        recurrences.sort(
            key=lambda item: (
                item.events[0].default_start
                if item.events
                else datetime.max.replace(tzinfo=timezone.utc),
                item.title.lower(),
                item.key,
            )
        )
        return recurrences
