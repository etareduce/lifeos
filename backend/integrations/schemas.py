from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class GoogleConnectedAccountRead(BaseModel):
    id: str
    account_id: str | None = None
    account_name: str | None = None


class GoogleConnectionStatus(BaseModel):
    connected: bool
    account_id: str | None = None
    account_name: str | None = None
    accounts: list[GoogleConnectedAccountRead] = Field(default_factory=list)
    provider: str = "google"


class GoogleConnectRequest(BaseModel):
    access_token: str = Field(min_length=1)


class GoogleCalendarSelectionUpdateRequest(BaseModel):
    selected: bool
    visible: bool | None = None
    related_view_ids: list[str] = Field(default_factory=list)


class IntegrationCalendarRead(BaseModel):
    id: str
    calendar_id: str
    account_key: str
    account_id: str | None = None
    account_name: str | None = None
    name: str
    description: str | None = None
    time_zone: str
    primary: bool = False
    selected: bool = True
    access_role: str = "reader"


class GoogleSyncRequest(BaseModel):
    calendar_ids: list[str] = Field(default_factory=list)
    range_start: datetime
    range_end: datetime


class GoogleSyncResponse(BaseModel):
    created_count: int
    updated_count: int
    skipped_count: int
    deleted_count: int = 0


class CalendarViewRead(BaseModel):
    id: str
    name: str
    source: str
    is_main: bool = False
    visible: bool = True
    account_key: str | None = None
    account_name: str | None = None
    calendar_id: str | None = None
    recurrence_count: int = 0


class CalendarVisibilityUpdateRequest(BaseModel):
    visible: bool


class CalendarViewCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class CalendarExportRequest(BaseModel):
    calendar_view_ids: list[str] = Field(default_factory=list)


class UserDataExportRequest(BaseModel):
    client_settings: dict = Field(default_factory=dict)


class CopyToMainResponse(BaseModel):
    created_count: int
    merged_count: int
    skipped_count: int = 0


class MoveOccurrenceToMainRequest(BaseModel):
    occurrence_start: datetime
