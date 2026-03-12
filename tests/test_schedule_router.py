from datetime import datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from backend.schedule_router import (
    _epoch_start_utc,
    _occurrence_consistency_group_id,
    _to_epoch_seconds,
)


def test_epoch_anchor_moves_back_to_earliest_occurrence_week():
    user_tz = ZoneInfo("UTC")
    current_reference = datetime(2026, 3, 2, 19, 9, 26, tzinfo=timezone.utc)
    earliest_occurrence_start = datetime(2026, 2, 26, 6, 24, 22, tzinfo=timezone.utc)

    epoch_start = _epoch_start_utc(earliest_occurrence_start, user_tz)

    assert epoch_start == datetime(2026, 2, 23, 0, 0, tzinfo=timezone.utc)
    assert _to_epoch_seconds(earliest_occurrence_start, epoch_start) >= 0
    assert _to_epoch_seconds(current_reference, epoch_start) >= 0


def _mock_occurrence(
    *,
    occurrence_key: str,
    sched_start: datetime,
    sched_end: datetime,
    default_start: datetime,
    default_end: datetime,
    recurrence_id: str = "recurrence-1",
    name: str = "Japanese Study",
    policy: dict | None = None,
):
    return SimpleNamespace(
        id=f"{recurrence_id}:{occurrence_key}",
        recurrence_id=recurrence_id,
        schedulable_timerange=SimpleNamespace(start=sched_start, end=sched_end),
        default_scheduled_timerange=SimpleNamespace(start=default_start, end=default_end),
        policy=policy or {"scheduling_policies": 0},
        tags=[],
        dependencies=[],
        name=name,
    )


def test_consistency_group_id_ignores_dst_schedulable_span_variation():
    normal = _mock_occurrence(
        occurrence_key="2026-03-16T04:00:00+00:00",
        sched_start=datetime(2026, 3, 16, 4, 0, tzinfo=timezone.utc),
        sched_end=datetime(2026, 3, 17, 3, 59, tzinfo=timezone.utc),
        default_start=datetime(2026, 3, 16, 17, 0, tzinfo=timezone.utc),
        default_end=datetime(2026, 3, 16, 17, 15, tzinfo=timezone.utc),
    )
    dst_shifted = _mock_occurrence(
        occurrence_key="2026-03-15T04:00:00+00:00",
        sched_start=datetime(2026, 3, 15, 4, 0, tzinfo=timezone.utc),
        sched_end=datetime(2026, 3, 16, 2, 59, tzinfo=timezone.utc),
        default_start=datetime(2026, 3, 15, 17, 0, tzinfo=timezone.utc),
        default_end=datetime(2026, 3, 15, 17, 15, tzinfo=timezone.utc),
    )

    assert _occurrence_consistency_group_id(normal) == _occurrence_consistency_group_id(dst_shifted)


def test_consistency_group_id_still_separates_different_policies():
    base = _mock_occurrence(
        occurrence_key="2026-03-16T04:00:00+00:00",
        sched_start=datetime(2026, 3, 16, 4, 0, tzinfo=timezone.utc),
        sched_end=datetime(2026, 3, 17, 3, 59, tzinfo=timezone.utc),
        default_start=datetime(2026, 3, 16, 17, 0, tzinfo=timezone.utc),
        default_end=datetime(2026, 3, 16, 17, 15, tzinfo=timezone.utc),
        policy={"scheduling_policies": 0},
    )
    different_policy = _mock_occurrence(
        occurrence_key="2026-03-17T04:00:00+00:00",
        sched_start=datetime(2026, 3, 17, 4, 0, tzinfo=timezone.utc),
        sched_end=datetime(2026, 3, 18, 3, 59, tzinfo=timezone.utc),
        default_start=datetime(2026, 3, 17, 17, 0, tzinfo=timezone.utc),
        default_end=datetime(2026, 3, 17, 17, 15, tzinfo=timezone.utc),
        policy={"scheduling_policies": 2},
    )

    assert _occurrence_consistency_group_id(base) != _occurrence_consistency_group_id(different_policy)
