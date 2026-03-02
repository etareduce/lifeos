from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class AnalyticsBase(DeclarativeBase):
    pass


class OccurrenceCompletionEventModel(AnalyticsBase):
    __tablename__ = "occurrence_completion_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    recurrence_id: Mapped[str] = mapped_column(String(36), index=True)
    recurrence_type: Mapped[str] = mapped_column(String(32))
    occurrence_key: Mapped[str] = mapped_column(String(128), index=True)
    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_seconds: Mapped[int] = mapped_column(Integer)
    completion_kind: Mapped[str] = mapped_column(String(32), default="immediate")
    recurrence_created_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    recurrence_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    occurrence_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    recurrence_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)


class ScheduleFeedbackBatchModel(AnalyticsBase):
    __tablename__ = "schedule_feedback_batches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    batch_size: Mapped[int] = mapped_column(Integer, default=20)
    edit_count: Mapped[int] = mapped_column(Integer, default=0)
    before_state: Mapped[dict] = mapped_column(JSON, default=dict)
    after_state: Mapped[dict] = mapped_column(JSON, default=dict)
    edits: Mapped[list] = mapped_column(JSON, default=list)
