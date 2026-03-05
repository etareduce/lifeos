import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, List, Optional, Set

from .timerange import TimeRange
from .constants import *
from engine import Policy, Tag, Job, TimeRange as tr


def _normalize_tags(raw_tags: Iterable) -> Set[Tag]:
    normalized: Set[Tag] = set()
    for tag in raw_tags or []:
        if isinstance(tag, Tag):
            normalized.add(tag)
            continue
        if isinstance(tag, dict):
            name = str(tag.get("name") or "").strip()
            if not name:
                continue
            description = str(tag.get("description") or "")
            normalized.add(Tag(name, description))
            continue
        if isinstance(tag, str):
            name = tag.strip()
            if not name:
                continue
            normalized.add(Tag(name))
    return normalized


def _clone_tags(raw_tags: Iterable) -> Set[Tag]:
    cloned: Set[Tag] = set()
    for tag in raw_tags or []:
        if isinstance(tag, Tag):
            cloned.add(Tag(tag.get_name(), tag.get_description()))
            continue
        if isinstance(tag, dict):
            name = str(tag.get("name") or "").strip()
            if not name:
                continue
            description = str(tag.get("description") or "")
            cloned.add(Tag(name, description))
            continue
        if isinstance(tag, str):
            name = tag.strip()
            if not name:
                continue
            cloned.add(Tag(name))
    return cloned


@dataclass
class Blob:
    """Core scheduling unit representing a task/event"""

    default_scheduled_timerange: TimeRange
    schedulable_timerange: TimeRange
    name: str = field(default="Unnamed Blob")
    description: Optional[str] = field(default=None)
    location: Optional[str] = field(default=None)
    tz: timezone = field(default_factory=lambda: DEFAULT_TZ)
    policy: Policy = field(default_factory=lambda: Policy)

    dependencies: Set[str] = field(default_factory=set)  # IDs of other blobs
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    tags: Set[Tag] = field(default_factory=set)

    def __post_init__(self):
        self.duration: timedelta = self.default_scheduled_timerange.duration()
        if not self.schedulable_timerange.contains(self.default_scheduled_timerange):
            raise ValueError(
                "Valid schedulable range must contain default scheduled timerange"
            )
        self.tags = _normalize_tags(self.tags)

    def __deepcopy__(self, memo):
        return Blob(
            default_scheduled_timerange=deepcopy(self.default_scheduled_timerange, memo),
            schedulable_timerange=deepcopy(self.schedulable_timerange, memo),
            name=deepcopy(self.name, memo),
            description=deepcopy(self.description, memo),
            location=deepcopy(self.location, memo),
            tz=self.tz,
            policy=deepcopy(self.policy, memo),
            dependencies=deepcopy(self.dependencies, memo),
            id=deepcopy(self.id, memo),
            tags=_clone_tags(self.tags),
        )

    def to_job(self, EPOCH_BEGIN: datetime) -> Job:
        schedulable_timerange_start = self.schedulable_timerange.start
        schedulable_timerange_end = self.schedulable_timerange.end
        schedulable_tr = tr(
            int((schedulable_timerange_start - EPOCH_BEGIN).total_seconds()),
            int((schedulable_timerange_end - EPOCH_BEGIN).total_seconds()),
        )

        scheduled_timerange_start = self.default_scheduled_timerange.start
        scheduled_timerange_end = self.default_scheduled_timerange.end
        scheduled_tr = tr(
            int((scheduled_timerange_start - EPOCH_BEGIN).total_seconds()),
            int((scheduled_timerange_end - EPOCH_BEGIN).total_seconds()),
        )

        return Job(
            int(self.duration.total_seconds()),
            schedulable_tr,
            scheduled_tr,
            self.id,
            self.policy,
            self.dependencies,
            self.tags,
        )
    
    @classmethod
    def from_job(cls, 
        job: Job, 
        EPOCH_BEGIN: datetime, 
        name: str,
        description: str,
        location: str | None,
        tz: timezone
    ) -> 'Blob':
        scheduled_tr_start_delta = job.schedulable_time_range.get_low()
        scheduled_tr_end_delta = job.schedulable_time_range.get_high()
        scheduled_timerange=  TimeRange(
            start=EPOCH_BEGIN + timedelta(seconds=scheduled_tr_start_delta),
            end=EPOCH_BEGIN + timedelta(seconds=scheduled_tr_end_delta)
        )

        schedulable_tr_start_delta = job.schedulable_time_range.get_low()
        schedulable_tr_end_delta = job.schedulable_time_range.get_high()
        schedulable_timerange = TimeRange(
            start=EPOCH_BEGIN + timedelta(seconds=schedulable_tr_start_delta),
            end=EPOCH_BEGIN + timedelta(seconds=schedulable_tr_end_delta)
        )

        return Blob(
            default_scheduled_timerange=scheduled_timerange,
            schedulable_timerange=schedulable_timerange,
            name=name,
            description=description,
            location=location,
            tz=tz,
            policy=job.policy,
            dependencies=job.dependencies,
            id=job.id,
            tags=job.tags
        )

    def __str__(self) -> str:
        """String representation"""
        return ""

    def __eq__(self, other) -> bool:
        """Check equality with another daytime object"""
        if not isinstance(other, Blob):
            return False
        return self.id == other.get_id()

    def __lt__(self, other) -> bool:
        if not isinstance(other, Blob):
            raise NotImplemented

        return self.schedulable_timerange < other.schedulable_timerange

    def __le__(self, other) -> bool:
        if not isinstance(other, Blob):
            raise NotImplemented

        return self.schedulable_timerange <= other.schedulable_timerange

    def __hash__(self) -> int:
        return hash(self.id)

    def get_id(self) -> str:
        return self.id

    def get_duration(self) -> timedelta:
        return self.duration

    def get_default_scheduled_timerange(self) -> TimeRange:
        return self.default_scheduled_timerange

    def get_schedulable_timerange(self) -> TimeRange:
        return self.schedulable_timerange

    def get_policy(self) -> Policy:
        return self.policy

    def set_default_scheduled_timerange(self, timerange: TimeRange):
        self.default_scheduled_timerange = timerange
        return

    def set_schedulable_timerange(self, timerange: TimeRange):
        self.schedulable_timerange = timerange
        return

    def overlaps(self, other) -> bool:
        return self.schedulable_timerange.overlaps(other.schedulable_timerange)
