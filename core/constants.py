import os
from enum import Enum

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

PROJECT_TIMEZONE = os.getenv("ELASTISCHED_PROJECT_TZ", "UTC")
try:
    DEFAULT_TZ = ZoneInfo(PROJECT_TIMEZONE)
except ZoneInfoNotFoundError:
    DEFAULT_TZ = timezone.utc

DEFAULT_START_DATE = datetime(
    date.min.year, date.min.month, date.min.day, tzinfo=timezone.utc
)
DEFAULT_END_DATE = datetime(
    date.max.year, date.max.month, date.max.day, tzinfo=timezone.utc
)
MIN_DATE = date.min
MAX_DATE = date.max

DEFAULT_BLOB_DURATION = timedelta(minutes=30)
DEFAULT_BLOB_SCHEDULED_AFTER_NOW = timedelta(minutes=60)
DEFAULT_BLOB_SCHEDULABLE_AFTER_NOW = timedelta(minutes=120)

MINIMUM_BLOB_SPLIT_DURATION = timedelta(minutes=15)

GRANULARITY = timedelta(minutes=5)

class Day(Enum):
    MONDAY = 0
    TUESDAY = 1
    WEDNESDAY = 2
    THURSDAY = 3
    FRIDAY = 4
    SATURDAY = 5
    SUNDAY = 6
