from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class GoogleConnectionStatus(BaseModel):
    connected: bool
    account_id: str | None = None
    account_name: str | None = None
    provider: str = "google"


class GoogleConnectRequest(BaseModel):
    access_token: str = Field(min_length=1)


class IntegrationCalendarRead(BaseModel):
    id: str
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
