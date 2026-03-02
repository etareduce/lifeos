from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from math import ceil

from .constants import *

def round_datetime_future_bias(dt: datetime, granularity: timedelta) -> datetime:
    """
    Round datetime to nearest granularity with future bias.
    If exactly between two granularity points, round to the future one.
    """
    if granularity <= timedelta(0):
        raise ValueError("Granularity must be positive timedelta")

    # Create a reference point (start of day) to align boundaries properly
    start_of_day = dt.replace(hour=0, minute=0, second=0, microsecond=0)

    # Calculate seconds elapsed since start of day
    elapsed = (dt - start_of_day).total_seconds()
    granularity_seconds = granularity.total_seconds()

    # Calculate how many granularity units have passed since start of day
    units_passed = elapsed / granularity_seconds

    # Always round up to next boundary
    rounded_units = ceil(units_passed)

    # Calculate the rounded time
    rounded_elapsed = rounded_units * granularity_seconds
    result = start_of_day + timedelta(seconds=rounded_elapsed)

    return result
