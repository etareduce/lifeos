from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.db import Base


class BlobModel(Base):
    __tablename__ = "blobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    location: Mapped[str | None] = mapped_column(String(500), nullable=True)
    tz: Mapped[str] = mapped_column(String(64), default="UTC")
    default_scheduled_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    default_scheduled_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    schedulable_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    schedulable_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    realized_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    realized_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    policy: Mapped[dict] = mapped_column(JSON, default=dict)
    dependencies: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)


class RecurrenceModel(Base):
    __tablename__ = "recurrences"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=True
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=True
    )


class ScheduledOccurrenceModel(Base):
    __tablename__ = "scheduled_occurrences"

    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    segment_index: Mapped[int] = mapped_column(Integer, primary_key=True, default=0)
    realized_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    realized_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ScheduleStateModel(Base):
    __tablename__ = "schedule_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    dirty: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
