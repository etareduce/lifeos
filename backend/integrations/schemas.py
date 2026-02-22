from __future__ import annotations

from datetime import datetime
from typing import Literal

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


class GoogleSyncPreviewRequest(BaseModel):
    calendar_ids: list[str] = Field(default_factory=list)
    range_start: datetime
    range_end: datetime


class SyncEventPreview(BaseModel):
    name: str
    start: datetime
    end: datetime


class MergeCandidatePreview(BaseModel):
    recurrence_id: str
    recurrence_name: str
    event_count: int


class GoogleSyncPreviewItem(BaseModel):
    item_id: str
    provider: str
    account_key: str
    account_name: str | None = None
    calendar_view_id: str
    calendar_id: str
    calendar_name: str
    recurrence_name: str
    recurrence_description: str | None = None
    event_count: int
    suggested_action: Literal["merge", "create", "review"]
    events: list[SyncEventPreview] = Field(default_factory=list)
    match_candidates: list[MergeCandidatePreview] = Field(default_factory=list)


class GoogleSyncPreviewResponse(BaseModel):
    preview_id: str
    name_distance_threshold: int
    calendar_ids: list[str] = Field(default_factory=list)
    items: list[GoogleSyncPreviewItem] = Field(default_factory=list)


class SyncDecision(BaseModel):
    item_id: str
    action: Literal["merge", "create", "skip"]
    merge_recurrence_id: str | None = None


class GoogleSyncApplyRequest(BaseModel):
    preview_id: str
    decisions: list[SyncDecision] = Field(default_factory=list)


class GoogleSyncApplyResponse(BaseModel):
    created_count: int
    merged_count: int
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


class CopyToMainResponse(BaseModel):
    created_count: int
    merged_count: int
