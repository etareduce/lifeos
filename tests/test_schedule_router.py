from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from backend.schedule_router import _epoch_start_utc, _to_epoch_seconds


def test_epoch_anchor_moves_back_to_earliest_occurrence_week():
    user_tz = ZoneInfo("UTC")
    current_reference = datetime(2026, 3, 2, 19, 9, 26, tzinfo=timezone.utc)
    earliest_occurrence_start = datetime(2026, 2, 26, 6, 24, 22, tzinfo=timezone.utc)

    epoch_start = _epoch_start_utc(earliest_occurrence_start, user_tz)

    assert epoch_start == datetime(2026, 2, 23, 0, 0, tzinfo=timezone.utc)
    assert _to_epoch_seconds(earliest_occurrence_start, epoch_start) >= 0
    assert _to_epoch_seconds(current_reference, epoch_start) >= 0
