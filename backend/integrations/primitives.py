from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True, slots=True)
class EventPrimitive:
    name: str
    default_start: datetime
    default_end: datetime
    description: str | None = None
    timezone: str = "UTC"
    external_event_id: str | None = None


@dataclass(slots=True)
class RecurrencePrimitive:
    key: str
    provider: str
    calendar_id: str
    calendar_name: str
    title: str
    description: str | None = None
    is_recurring: bool = False
    identifiers: list[str] = field(default_factory=list)
    events: list[EventPrimitive] = field(default_factory=list)

    def sort_events(self) -> None:
        self.events.sort(key=lambda item: item.default_start)
