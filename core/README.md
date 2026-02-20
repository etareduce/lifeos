# Core

`core/` is the Python domain layer shared by the backend and tests.

## What Lives Here
- [`core/blob.py`](blob.py): Blob entity + policy/dependency/tag fields.
- [`core/timerange.py`](timerange.py): timezone-aware time-range operations.
- [`core/recurrence.py`](recurrence.py): recurrence implementations and occurrence expansion.
- [`core/schedule.py`](schedule.py): schedule container object.
- [`core/daytime.py`](daytime.py): time-of-day helper abstraction.
- [`core/constants.py`](constants.py): project timezone and scheduling defaults.
- [`core/utils.py`](utils.py): utility functions (including granularity rounding).

## Design Notes
- Timezone behavior is centralized via `ELASTISCHED_PROJECT_TZ` and `DEFAULT_TZ`.
- Recurrence types are designed to map cleanly into engine jobs.
- Recurrences are "lazy". Since there can be an infinite number of occurrences spanned by a recurrence, we opt for runtime expansion. 
