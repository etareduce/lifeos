# Tests

`tests/` contains Python integration and behavior tests for API, recurrence logic, scheduling flow, and utility behavior.

## Coverage Areas
- API contract and route-level flows.
- Recurrence expansion (`single`, `multiple`, `weekly`, `delta`, `date`).
- Engine integration and scheduling workflows.
- Timezone/datetime utility behavior.
- Integration helpers (merge/translations).

## Run
- Full suite: `pytest -q`
- Single file example: `pytest tests/test_schedule_workflow.py -q`
