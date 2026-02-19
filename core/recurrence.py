from abc import ABC, abstractmethod
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional
import uuid

from .blob import Blob
from .daytime import daytime
from .timerange import TimeRange

MAX_OCCURRENCES_PER_QUERY = 10000


def has_overlapping_blobs(blobs: List[Blob]) -> bool:
    sorted_blobs = sorted(blobs, key=lambda b: b.schedulable_timerange.start)

    for i in range(len(sorted_blobs) - 1):
        if sorted_blobs[i].overlaps(sorted_blobs[i + 1]):
            return True

    return False


def _coerce_datetime(value: datetime, tzinfo) -> datetime:
    if tzinfo is None:
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=tzinfo)
    return value.astimezone(tzinfo)


def _coerce_datetime_local_naive(value: datetime, tzinfo) -> datetime:
    if tzinfo is None:
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=tzinfo).replace(tzinfo=None)
    return value.astimezone(tzinfo).replace(tzinfo=None)


def _resolve_local_datetime(
    target_local_naive: datetime, tzinfo, reference_project: Optional[datetime] = None
) -> datetime:
    if tzinfo is None:
        return target_local_naive

    candidate0 = target_local_naive.replace(tzinfo=tzinfo, fold=0)
    candidate1 = target_local_naive.replace(tzinfo=tzinfo, fold=1)

    if candidate0.utcoffset() == candidate1.utcoffset():
        return candidate0

    roundtrip0 = candidate0.astimezone(timezone.utc).astimezone(tzinfo)
    roundtrip1 = candidate1.astimezone(timezone.utc).astimezone(tzinfo)

    if roundtrip0 != candidate0 and roundtrip1 != candidate1:
        # Spring-forward gap: roll forward to the first valid local time.
        return roundtrip0

    # Fall-back ambiguity: choose the earliest candidate not before the reference.
    if reference_project is None:
        return candidate0

    ref = (
        reference_project
        if reference_project.tzinfo is not None
        else reference_project.replace(tzinfo=tzinfo)
    )
    cand0_proj = candidate0.astimezone(ref.tzinfo)
    cand1_proj = candidate1.astimezone(ref.tzinfo)

    if cand0_proj >= ref and cand1_proj >= ref:
        return candidate0 if cand0_proj <= cand1_proj else candidate1
    if cand0_proj >= ref:
        return candidate0
    if cand1_proj >= ref:
        return candidate1
    return candidate1 if cand1_proj >= cand0_proj else candidate0


def _delta_from_local(
    start: datetime,
    tzinfo,
    target_local_naive: datetime,
    reference_project: Optional[datetime] = None,
) -> timedelta:
    target_local = _resolve_local_datetime(
        target_local_naive, tzinfo, reference_project
    )
    target_project = (
        target_local.astimezone(start.tzinfo) if start.tzinfo else target_local
    )
    return target_project - start


def _project_datetime_from_local(
    base_project: datetime,
    tzinfo,
    target_local_naive: datetime,
    reference_project: Optional[datetime] = None,
) -> datetime:
    target_local = _resolve_local_datetime(
        target_local_naive, tzinfo, reference_project
    )
    if base_project.tzinfo:
        return target_local.astimezone(base_project.tzinfo)
    return target_local


def _timerange_shift_local(
    timerange: TimeRange,
    tzinfo,
    delta_local: timedelta,
    reference_project: Optional[datetime] = None,
) -> TimeRange:
    start_local = _coerce_datetime_local_naive(timerange.start, tzinfo)
    end_local = _coerce_datetime_local_naive(timerange.end, tzinfo)
    local_duration = end_local - start_local
    target_local_start = start_local + delta_local
    target_local_end = target_local_start + local_duration

    target_start = _project_datetime_from_local(
        timerange.start, tzinfo, target_local_start, reference_project
    )
    target_end = _project_datetime_from_local(
        timerange.end, tzinfo, target_local_end, target_start
    )
    return TimeRange(start=target_start, end=target_end)


def blob_copy_with_local_delta(
    blob: Blob,
    tzinfo,
    delta_local: timedelta,
    reference_project: Optional[datetime] = None,
):
    blob_copy = deepcopy(blob)
    default_tr = blob_copy.get_default_scheduled_timerange()
    schedulable_tr = blob_copy.get_schedulable_timerange()

    blob_copy.set_default_scheduled_timerange(
        _timerange_shift_local(default_tr, tzinfo, delta_local, reference_project)
    )
    blob_copy.set_schedulable_timerange(
        _timerange_shift_local(schedulable_tr, tzinfo, delta_local, reference_project)
    )

    return blob_copy


def blob_copy_with_delta_future(blob: Blob, td: timedelta):
    blob_copy = deepcopy(blob)

    curr_default_scheduled_timerange = blob_copy.get_default_scheduled_timerange()
    blob_copy.set_default_scheduled_timerange(curr_default_scheduled_timerange + td)

    curr_schedulable_timerange = blob_copy.get_schedulable_timerange()
    blob_copy.set_schedulable_timerange(curr_schedulable_timerange + td)

    return blob_copy


@dataclass
class BlobRecurrence(ABC):
    """Abstract base class for recurrence rules"""

    _id: str = field(default_factory=lambda: str(uuid.uuid4()), init=False)

    @abstractmethod
    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        """Generate the next occurrence after the given datetime"""
        pass

    @abstractmethod
    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        """Generate all occurrences within the given time range"""
        pass

    def __eq__(self, other):
        if not isinstance(other, BlobRecurrence):
            return False
        return self._id == other.get_id()

    def get_id(self):
        return self._id

    def __hash__(self):
        return hash(self._id)


@dataclass
class SingleBlobOccurrence(BlobRecurrence):
    blob: Blob

    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        timerange = self.blob.get_schedulable_timerange()

        current_local = _coerce_datetime(current, timerange.start.tzinfo)
        if current_local < timerange.start:
            return self.blob

        return None

    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        if timerange.overlaps(self.blob.get_schedulable_timerange()):
            return [deepcopy(self.blob)]

        return []


@dataclass
class MultipleBlobOccurrence(BlobRecurrence):
    blobs: List[Blob]

    def __post_init__(self):
        if not self.blobs:
            raise ValueError("Multiple occurrence requires at least one blob")
        self.blobs.sort(key=lambda blob: blob.get_schedulable_timerange().start)

    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        candidates = []
        for blob in self.blobs:
            timerange = blob.get_schedulable_timerange()
            current_local = _coerce_datetime(current, timerange.start.tzinfo)
            if current_local < timerange.start:
                candidates.append(blob)
        if not candidates:
            return None
        candidates.sort(key=lambda item: item.get_schedulable_timerange().start)
        return deepcopy(candidates[0])

    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        occurrences = []
        for blob in self.blobs:
            if timerange.overlaps(blob.get_schedulable_timerange()):
                occurrences.append(deepcopy(blob))
        occurrences.sort(key=lambda item: item.get_schedulable_timerange().start)
        return occurrences


@dataclass
class WeeklyBlobRecurrence(BlobRecurrence):
    """Weekly recurrence rule"""

    blobs_of_week: List[Blob]
    interval: int = 1  # Every N weeks

    def __post_init__(self):
        if len(self.blobs_of_week) == 0:
            raise ValueError(
                "There must be at least one occurrence in a weekly recurrence"
            )

        if has_overlapping_blobs(self.blobs_of_week):
            raise ValueError("Weekly blob recurrence requires non-overlapping blobs")

        self.blobs_of_week.sort()
        self.__days_of_week = []
        for blob in self.blobs_of_week:
            base_start = blob.get_schedulable_timerange().start
            tzinfo = blob.tz or base_start.tzinfo
            base_start_local = base_start.astimezone(tzinfo) if tzinfo else base_start
            self.__days_of_week.append(
                daytime(base_start_local.weekday(), base_start_local.time())
            )

    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        occurrences = []

        for blob, day in zip(self.blobs_of_week, self.__days_of_week):
            base_start = blob.get_schedulable_timerange().start
            tzinfo = blob.tz or base_start.tzinfo
            current_local = current
            base_start_local = base_start
            if tzinfo:
                current_local = _coerce_datetime(current, tzinfo)
                base_start_local = base_start.astimezone(tzinfo)

            total_days = (current_local - base_start_local).days
            weeks_since_start = max(0, total_days // 7)  # clamp to 0 if before start
            interval_start = (weeks_since_start // self.interval) * self.interval

            candidate_weeks = [
                interval_start,
                interval_start + self.interval,
            ]

            for week_offset in candidate_weeks:
                days_since_base = week_offset * 7 + (
                    day.day_of_week - base_start_local.weekday()
                )
                occurrence_date = base_start_local + timedelta(days=days_since_base)
                occurrence_datetime = datetime.combine(
                    occurrence_date.date(), day.time, tzinfo=tzinfo
                )

                if occurrence_datetime < base_start_local:
                    continue

                if occurrence_datetime > current_local:
                    occurrence_project = (
                        occurrence_datetime.astimezone(base_start.tzinfo)
                        if base_start.tzinfo
                        else occurrence_datetime
                    )
                    delta = occurrence_project - base_start
                    future_blob = blob_copy_with_delta_future(blob, delta)
                    occurrences.append((occurrence_datetime, future_blob))
                    break

        if not occurrences:
            return None

        occurrences.sort(key=lambda tup: tup[0])
        return occurrences[0][1]

    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        occurrences = []
        current = timerange.start

        while True:
            next_blob = self.next_occurrence(current)
            if next_blob is None:
                break

            occurrence_range = next_blob.get_schedulable_timerange()
            if not timerange.overlaps(occurrence_range):
                break

            next_start = occurrence_range.start
            if next_start > timerange.end:
                break

            occurrences.append(next_blob)
            if len(occurrences) >= MAX_OCCURRENCES_PER_QUERY:
                break
            current = next_start + timedelta(microseconds=1)

        return occurrences


@dataclass
class DeltaBlobRecurrence(BlobRecurrence):
    """Delta recurrence rule - recurring events at fixed time intervals"""

    delta: timedelta
    start_blob: Blob

    def __post_init__(self):
        schedulable_timerange = self.start_blob.get_schedulable_timerange()
        if schedulable_timerange.duration() > self.delta:
            raise ValueError(
                "Blob schedulable timerange duration should not be larger than delta"
            )

    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        start = self.start_blob.get_schedulable_timerange().start
        tzinfo = self.start_blob.tz or start.tzinfo
        current_project = _coerce_datetime(current, start.tzinfo)
        start_local = _coerce_datetime_local_naive(start, tzinfo)
        current_local = _coerce_datetime_local_naive(current, tzinfo)
        if current_local < start_local:
            return deepcopy(self.start_blob)

        time_diff = current_local - start_local
        intervals_passed = time_diff // self.delta
        target_local = start_local + (intervals_passed + 1) * self.delta
        delta_local = target_local - start_local

        return blob_copy_with_local_delta(
            self.start_blob, tzinfo, delta_local, current_project
        )

    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        occurrences = []

        start_schedulable_timerange = self.start_blob.get_schedulable_timerange()
        start = timerange.start
        end = timerange.end
        base_start = start_schedulable_timerange.start
        tzinfo = self.start_blob.tz or base_start.tzinfo

        # Determine the first occurrence to consider
        start_local = _coerce_datetime_local_naive(base_start, tzinfo)
        range_start_local = _coerce_datetime_local_naive(start, tzinfo)
        range_end_local = _coerce_datetime_local_naive(end, tzinfo)

        if range_start_local <= start_local:
            curr_local = start_local
        else:
            time_diff = range_start_local - start_local
            intervals_passed = time_diff // self.delta
            curr_local = start_local + intervals_passed * self.delta

        while curr_local <= range_end_local:
            time_diff = curr_local - start_local
            intervals_passed = time_diff // self.delta
            target_local = start_local + intervals_passed * self.delta
            delta_local = target_local - start_local

            blob_copy = blob_copy_with_local_delta(
                self.start_blob, tzinfo, delta_local, start
            )

            occurrence_range = blob_copy.get_schedulable_timerange()
            if timerange.overlaps(occurrence_range):
                occurrences.append(blob_copy)
                if len(occurrences) >= MAX_OCCURRENCES_PER_QUERY:
                    break
            elif occurrence_range.end <= start:
                curr_local += self.delta
                continue
            else:
                break

            curr_local += self.delta

        return occurrences


@dataclass
class DateBlobRecurrence(BlobRecurrence):
    blob: Blob

    def __post_init__(self):
        timerange = self.blob.get_schedulable_timerange()
        start: datetime = timerange.start
        end: datetime = timerange.end
        tzinfo = self.blob.tz or start.tzinfo
        start_local = start.astimezone(tzinfo) if tzinfo else start
        end_local = end.astimezone(tzinfo) if tzinfo else end

        if start_local.weekday() != end_local.weekday():
            raise ValueError(
                "Date blob recurrence should have a blob with timerange that starts and ends on the same day"
            )

        if start_local.year != end_local.year:
            raise ValueError(
                "Date blob recurrence should have a blob with timerange that starts and ends on the same year"
            )

    def next_occurrence(self, current: datetime) -> Optional[Blob]:
        schedulable_timerange = self.blob.get_schedulable_timerange()
        start = schedulable_timerange.start
        tzinfo = self.blob.tz or start.tzinfo
        dt: datetime = schedulable_timerange.start
        start_local = start.astimezone(tzinfo) if tzinfo else start
        current_local = _coerce_datetime(current, tzinfo)
        dt_local = dt.astimezone(tzinfo) if tzinfo else dt
        date = dt_local.date()
        time = dt_local.time()

        if start_local.date().month == 2 and start_local.date().day == 29:
            return self._next_leap_day(current_local)

        try:
            target_this_year = datetime(
                year=current_local.year,
                month=date.month,
                day=date.day,
                hour=time.hour,
                minute=time.minute,
                second=time.second,
                microsecond=time.microsecond,
                tzinfo=tzinfo,
            )

            if target_this_year > current_local:
                if current_local.year >= start_local.year:
                    years_diff = current_local.year - start_local.year
                    actual_target = datetime(
                        year=start_local.year + years_diff,
                        month=date.month,
                        day=date.day,
                        hour=time.hour,
                        minute=time.minute,
                        second=time.second,
                        microsecond=time.microsecond,
                        tzinfo=tzinfo,
                    )
                    actual_target_project = (
                        actual_target.astimezone(start.tzinfo)
                        if start.tzinfo
                        else actual_target
                    )
                    delta_to_occurrence = actual_target_project - start
                    return blob_copy_with_delta_future(self.blob, delta_to_occurrence)
                else:
                    return self.blob

        except ValueError:
            # This shouldn't happen for non-leap days, but handle it just in case
            pass

        if current_local.year >= start_local.year:
            years_diff = (current_local.year + 1) - start_local.year
        else:
            return self.blob

        target_next_year = datetime(
            year=start_local.year + years_diff,
            month=date.month,
            day=date.day,
            hour=time.hour,
            minute=time.minute,
            second=time.second,
            microsecond=time.microsecond,
            tzinfo=tzinfo,
        )

        target_next_project = (
            target_next_year.astimezone(start.tzinfo) if start.tzinfo else target_next_year
        )
        delta_to_occurrence = target_next_project - start
        return blob_copy_with_delta_future(self.blob, delta_to_occurrence)

    def _next_leap_day(self, current: datetime) -> Blob:
        """Find the next Feb 29 after the current datetime"""
        schedulable_timerange = self.blob.get_schedulable_timerange()
        start = schedulable_timerange.start
        tzinfo = self.blob.tz or start.tzinfo
        start_local = start.astimezone(tzinfo) if tzinfo else start
        dt = schedulable_timerange.start
        dt_local = dt.astimezone(tzinfo) if tzinfo else dt
        date = dt_local.date()
        time = dt_local.time()

        def is_leap_year(year):
            return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

        # Check if current year is a leap year and Feb 29 hasn't passed yet
        if is_leap_year(current.year):
            feb29_this_year = datetime(
                year=current.year,
                month=2,
                day=29,
                hour=time.hour,
                minute=time.minute,
                second=time.second,
                microsecond=time.microsecond,
                tzinfo=tzinfo,
            )
            if feb29_this_year > current:
                if current.year >= start_local.year:
                    # Current year is same or after the original blob's year
                    years_diff = current.year - start_local.year
                    actual_target = datetime(
                        year=start_local.year + years_diff,
                        month=2,
                        day=29,
                        hour=time.hour,
                        minute=time.minute,
                        second=time.second,
                        microsecond=time.microsecond,
                        tzinfo=tzinfo,
                    )
                    actual_target_project = (
                        actual_target.astimezone(start.tzinfo)
                        if start.tzinfo
                        else actual_target
                    )
                    delta_to_occurrence = actual_target_project - start
                    return blob_copy_with_delta_future(self.blob, delta_to_occurrence)
                else:
                    # Current year is before the original blob's year, return original blob
                    return self.blob

        # Find the next leap year
        next_year = current.year + 1
        while not is_leap_year(next_year):
            next_year += 1

        if next_year >= start_local.year:
            years_diff = next_year - start_local.year
        else:
            # If next leap year is before original blob's year, return original blob
            return self.blob

        feb29_next = datetime(
            year=start_local.year + years_diff,
            month=2,
            day=29,
            hour=time.hour,
            minute=time.minute,
            second=time.second,
            microsecond=time.microsecond,
            tzinfo=tzinfo,
        )
        feb29_next_project = (
            feb29_next.astimezone(start.tzinfo) if start.tzinfo else feb29_next
        )
        delta_to_occurrence = feb29_next_project - start
        return blob_copy_with_delta_future(self.blob, delta_to_occurrence)

    def all_occurrences(self, timerange: TimeRange) -> List[Blob]:
        occurrences = []
        start = timerange.start
        end = timerange.end
        schedulable_timerange = self.blob.get_schedulable_timerange()
        schedulable_timerange_start = schedulable_timerange.start
        tzinfo = self.blob.tz or schedulable_timerange_start.tzinfo

        dt = schedulable_timerange_start
        dt_local = dt.astimezone(tzinfo) if tzinfo else dt
        date = dt_local.date()
        time = dt_local.time()

        if date.month == 2 and date.day == 29:
            return self._all_leap_day_occurrences(timerange)

        start_local = start.astimezone(tzinfo) if tzinfo else start
        end_local = end.astimezone(tzinfo) if tzinfo else end
        current_year = start_local.year

        while True:
            try:
                target_date = datetime(
                    year=current_year,
                    month=date.month,
                    day=date.day,
                    hour=time.hour,
                    minute=time.minute,
                    second=time.second,
                    microsecond=time.microsecond,
                    tzinfo=tzinfo,
                )
            except ValueError:
                current_year += 1
                continue

            target_project = (
                target_date.astimezone(schedulable_timerange_start.tzinfo)
                if schedulable_timerange_start.tzinfo
                else target_date
            )
            delta_to_occurrence = target_project - schedulable_timerange_start
            blob_copy = blob_copy_with_delta_future(self.blob, delta_to_occurrence)

            # Stop once the next occurrence starts after the range end.
            if target_date > end_local:
                break

            if timerange.overlaps(blob_copy.get_schedulable_timerange()):
                occurrences.append(blob_copy)
                if len(occurrences) >= MAX_OCCURRENCES_PER_QUERY:
                    break

            current_year += 1

        return occurrences

    def _all_leap_day_occurrences(self, timerange: TimeRange) -> List[Blob]:
        """Get all Feb 29 occurrences between start and end datetimes"""

        def is_leap_year(year):
            return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

        occurrences = []
        start = timerange.start
        end = timerange.end
        schedulable_timerange = self.blob.get_schedulable_timerange()
        tzinfo = self.blob.tz or schedulable_timerange.start.tzinfo
        start_local = start.astimezone(tzinfo) if tzinfo else start
        end_local = end.astimezone(tzinfo) if tzinfo else end

        dt = schedulable_timerange.start
        dt_local = dt.astimezone(tzinfo) if tzinfo else dt
        date = dt_local.date()
        time = dt_local.time()

        current_year = start_local.year

        while current_year <= end_local.year:
            if is_leap_year(current_year):
                target_date = datetime(
                    year=current_year,
                    month=2,
                    day=29,
                    hour=time.hour,
                    minute=time.minute,
                    second=time.second,
                    microsecond=time.microsecond,
                    tzinfo=tzinfo,
                )

                target_project = (
                    target_date.astimezone(schedulable_timerange.start.tzinfo)
                    if schedulable_timerange.start.tzinfo
                    else target_date
                )
                delta_to_occurrence = target_project - schedulable_timerange.start

                blob_copy = blob_copy_with_delta_future(self.blob, delta_to_occurrence)

                if target_date <= end_local and timerange.overlaps(
                    blob_copy.get_schedulable_timerange()
                ):
                    occurrences.append(blob_copy)
                    if len(occurrences) >= MAX_OCCURRENCES_PER_QUERY:
                        break

            current_year += 1

        return occurrences
