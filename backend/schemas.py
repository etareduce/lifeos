from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TimeRangeSchema(BaseModel):
    start: datetime
    end: datetime


class BlobBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    location: str | None = Field(default=None, max_length=500)
    default_scheduled_timerange: TimeRangeSchema
    schedulable_timerange: TimeRangeSchema
    realized_timerange: TimeRangeSchema | None = None
    tz: str = "UTC"
    policy: dict = Field(default_factory=dict)
    dependencies: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class BlobCreate(BlobBase):
    pass


class BlobUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    location: str | None = Field(default=None, max_length=500)
    default_scheduled_timerange: TimeRangeSchema | None = None
    schedulable_timerange: TimeRangeSchema | None = None
    realized_timerange: TimeRangeSchema | None = None
    tz: str | None = None
    policy: dict | None = None
    dependencies: list[str] | None = None
    tags: list[str] | None = None


class BlobRead(BlobBase):
    id: str

    model_config = ConfigDict(from_attributes=True)


class RecurrenceBase(BaseModel):
    type: str = Field(min_length=1, max_length=32)
    payload: dict = Field(default_factory=dict)


class RecurrenceCreate(RecurrenceBase):
    pass


class RecurrenceUpdate(BaseModel):
    type: str | None = Field(default=None, min_length=1, max_length=32)
    payload: dict | None = None


class RecurrenceRead(RecurrenceBase):
    id: str


class OccurrenceRead(BlobBase):
    id: str
    recurrence_id: str
    recurrence_type: str
    recurrence_payload: dict | None = None


class ScheduleStatus(BaseModel):
    dirty: bool
    last_run: datetime | None = None


class ScheduleRequest(BaseModel):
    granularity_minutes: int | None = Field(default=None, ge=1)
    lookahead_seconds: int | None = Field(default=None, ge=1)
    user_timezone: str | None = Field(default=None, max_length=64)
    include_active_occurrences: bool | None = None
    initial_temp: float | None = Field(default=None, gt=0)
    final_temp: float | None = Field(default=None, gt=0)
    num_iters: int | None = Field(default=None, ge=1)
    illegal_schedule_weight: float | None = Field(default=None, ge=0)
    overlap_cost_weight: float | None = Field(default=None, ge=0)
    split_cost_weight: float | None = Field(default=None, ge=0)
    consistency_cost_weight: float | None = Field(default=None, ge=0)
    granularity_cost_weight: float | None = Field(default=None, ge=0)


class ScheduleResponse(ScheduleStatus):
    occurrences: list[OccurrenceRead]


class PreviewOccurrence(OccurrenceRead):
    preview: bool = True
