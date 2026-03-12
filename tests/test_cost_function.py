from .constants import *
import engine
import pytest


def _make_job(
    schedulable_low,
    schedulable_high,
    scheduled_low,
    scheduled_high,
    policy=None,
    job_id="job",
    recurrence_id="",
    consistency_group_id="",
):
    policy = policy or engine.Policy(0, 0)
    tr_schedulable = engine.TimeRange(schedulable_low, schedulable_high)
    tr_scheduled = engine.TimeRange(scheduled_low, scheduled_high)
    duration = tr_scheduled.get_high() - tr_scheduled.get_low()
    return engine.Job(
        duration,
        tr_schedulable,
        tr_scheduled,
        job_id,
        policy,
        set(),
        set(),
        recurrence_id,
        consistency_group_id,
    )


"""
DEPRECATED COST FUNCTIONS TESTS

Note: currently the cost function only implements cost function primitives:

split cost
illegal schedule cost
overlap cost

Everything else is handled by preference learner
"""


def test_illegal_schedule_cost_outside_schedulable_range():
    job = _make_job(
        schedulable_low=0,
        schedulable_high=HOUR,
        scheduled_low=2 * HOUR,
        scheduled_high=3 * HOUR,
    )
    schedule = engine.Schedule([job])
    cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)

    assert cost_function.schedule_cost() == pytest.approx(1e12, rel=1e-6)


def test_overlap_cost_counts_overlap_duration():
    overlappable_policy = engine.Policy(0, 0, False, True)
    job_a = _make_job(
        schedulable_low=0,
        schedulable_high=4 * HOUR,
        scheduled_low=0,
        scheduled_high=HOUR,
        policy=overlappable_policy,
        job_id="job_a",
    )
    job_b = _make_job(
        schedulable_low=0,
        schedulable_high=4 * HOUR,
        scheduled_low=30 * MINUTE,
        scheduled_high=90 * MINUTE,
        policy=overlappable_policy,
        job_id="job_b",
    )
    schedule = engine.Schedule([job_a, job_b])
    cost_function = engine.ScheduleCostFunction(schedule, MINUTE)

    assert cost_function.schedule_cost() == 30.0


def test_overlap_with_single_non_overlappable_job_is_illegal():
    non_overlappable_policy = engine.Policy(0, 0, False, False)
    overlappable_policy = engine.Policy(0, 0, False, True)
    job_a = _make_job(
        schedulable_low=0,
        schedulable_high=4 * HOUR,
        scheduled_low=0,
        scheduled_high=HOUR,
        policy=non_overlappable_policy,
        job_id="job_a",
    )
    job_b = _make_job(
        schedulable_low=0,
        schedulable_high=4 * HOUR,
        scheduled_low=30 * MINUTE,
        scheduled_high=90 * MINUTE,
        policy=overlappable_policy,
        job_id="job_b",
    )
    schedule = engine.Schedule([job_a, job_b])
    cost_function = engine.ScheduleCostFunction(schedule, MINUTE)

    assert cost_function.schedule_cost() == pytest.approx(1e12, rel=1e-6)


def test_split_cost_counts_number_of_splits():
    job = _make_job(
        schedulable_low=0,
        schedulable_high=6 * HOUR,
        scheduled_low=HOUR,
        scheduled_high=2 * HOUR,
        job_id="split_job",
    )
    job.scheduled_time_ranges = [
        engine.TimeRange(HOUR, 2 * HOUR),
        engine.TimeRange(3 * HOUR, 4 * HOUR),
    ]
    schedule = engine.Schedule([job])
    cost_function = engine.ScheduleCostFunction(schedule, MINUTE)

    assert cost_function.schedule_cost() == 10.0


def test_consistency_cost_penalizes_same_recurrence_time_drift():
    schedulable_low = 0
    schedulable_high = 2 * WEEK
    job_a = _make_job(
        schedulable_low=schedulable_low,
        schedulable_high=schedulable_high,
        scheduled_low=Day.MONDAY * DAY + Hour.SIX_PM * HOUR,
        scheduled_high=Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR,
        job_id="job_a",
        recurrence_id="recurrence-1",
    )
    job_b = _make_job(
        schedulable_low=schedulable_low,
        schedulable_high=schedulable_high,
        scheduled_low=WEEK + Day.MONDAY * DAY + Hour.SIX_PM * HOUR,
        scheduled_high=WEEK + Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR,
        job_id="job_b",
        recurrence_id="recurrence-1",
    )
    shifted_start = WEEK + Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR
    shifted_end = WEEK + Day.MONDAY * DAY + Hour.EIGHT_PM * HOUR
    job_b.scheduled_time_ranges = [engine.TimeRange(shifted_start, shifted_end)]
    job_b.scheduled_time_range = engine.TimeRange(shifted_start, shifted_end)
    schedule = engine.Schedule([job_a, job_b])

    cost_function = engine.ScheduleCostFunction(
        schedule,
        MINUTE,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
    )

    # One pair in the family is in different daily-phase slots.
    expected_mismatch_pairs = 1.0
    assert cost_function.schedule_cost() == pytest.approx(expected_mismatch_pairs, rel=1e-6)


def test_consistency_cost_scopes_to_recurrence_family_pattern():
    schedulable_low = 0
    schedulable_high = 2 * WEEK
    # Family A: Mondays at 6 PM.
    family_a_week_1 = _make_job(
        schedulable_low=schedulable_low,
        schedulable_high=schedulable_high,
        scheduled_low=Day.MONDAY * DAY + Hour.SIX_PM * HOUR,
        scheduled_high=Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR,
        job_id="family_a_week_1",
        recurrence_id="recurrence-1",
    )
    family_a_week_2 = _make_job(
        schedulable_low=schedulable_low,
        schedulable_high=schedulable_high,
        scheduled_low=WEEK + Day.MONDAY * DAY + Hour.SIX_PM * HOUR,
        scheduled_high=WEEK + Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR,
        job_id="family_a_week_2",
        recurrence_id="recurrence-1",
    )
    moved_start = WEEK + Day.MONDAY * DAY + Hour.SEVEN_PM * HOUR
    moved_end = WEEK + Day.MONDAY * DAY + Hour.EIGHT_PM * HOUR
    family_a_week_2.scheduled_time_ranges = [engine.TimeRange(moved_start, moved_end)]
    family_a_week_2.scheduled_time_range = engine.TimeRange(moved_start, moved_end)

    # Family B: Tuesdays at 9 AM (should not be cross-coupled with Family A).
    family_b_week_1 = _make_job(
        schedulable_low=schedulable_low + DAY,
        schedulable_high=schedulable_high + DAY,
        scheduled_low=Day.TUESDAY * DAY + Hour.NINE_AM * HOUR,
        scheduled_high=Day.TUESDAY * DAY + Hour.TEN_AM * HOUR,
        job_id="family_b_week_1",
        recurrence_id="recurrence-1",
    )
    family_b_week_2 = _make_job(
        schedulable_low=schedulable_low + DAY,
        schedulable_high=schedulable_high + DAY,
        scheduled_low=WEEK + Day.TUESDAY * DAY + Hour.NINE_AM * HOUR,
        scheduled_high=WEEK + Day.TUESDAY * DAY + Hour.TEN_AM * HOUR,
        job_id="family_b_week_2",
        recurrence_id="recurrence-1",
    )

    schedule = engine.Schedule(
        [family_a_week_1, family_a_week_2, family_b_week_1, family_b_week_2]
    )
    cost_function = engine.ScheduleCostFunction(
        schedule,
        MINUTE,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
    )

    # Family A contributes one mismatched pair; Family B remains aligned.
    expected_mismatch_pairs = 1.0
    assert cost_function.schedule_cost() == pytest.approx(expected_mismatch_pairs, rel=1e-6)


def test_consistency_cost_penalizes_daily_time_drift_within_recurrence_family():
    day_zero_start = Day.MONDAY * DAY + Hour.SIX_PM * HOUR

    day_1 = _make_job(
        schedulable_low=day_zero_start,
        schedulable_high=day_zero_start + 3 * HOUR,
        scheduled_low=day_zero_start,
        scheduled_high=day_zero_start + HOUR,
        job_id="day_1",
        recurrence_id="recurrence-daily",
    )
    day_2 = _make_job(
        schedulable_low=day_zero_start + DAY,
        schedulable_high=day_zero_start + DAY + 3 * HOUR,
        scheduled_low=day_zero_start + DAY,
        scheduled_high=day_zero_start + DAY + HOUR,
        job_id="day_2",
        recurrence_id="recurrence-daily",
    )
    day_3 = _make_job(
        schedulable_low=day_zero_start + 2 * DAY,
        schedulable_high=day_zero_start + 2 * DAY + 3 * HOUR,
        scheduled_low=day_zero_start + 2 * DAY,
        scheduled_high=day_zero_start + 2 * DAY + HOUR,
        job_id="day_3",
        recurrence_id="recurrence-daily",
    )
    shifted_day_2_start = day_zero_start + DAY + HOUR
    shifted_day_2_end = day_zero_start + DAY + 2 * HOUR
    day_2.scheduled_time_ranges = [engine.TimeRange(shifted_day_2_start, shifted_day_2_end)]
    day_2.scheduled_time_range = engine.TimeRange(shifted_day_2_start, shifted_day_2_end)

    schedule = engine.Schedule([day_1, day_2, day_3])
    cost_function = engine.ScheduleCostFunction(
        schedule,
        MINUTE,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
    )

    # day_2 is in a different slot than day_1/day_3, producing two mismatched pairs.
    expected_mismatch_pairs = 2.0
    assert cost_function.schedule_cost() == pytest.approx(expected_mismatch_pairs, rel=1e-6)


def test_consistency_cost_uses_stable_group_even_if_default_start_is_overridden():
    schedulable_low = 0
    schedulable_high = 2 * DAY
    anchor_group = "phase=14400|dur=900|policy=0|name=japanese study|tags=|deps="

    job_a = _make_job(
        schedulable_low=schedulable_low,
        schedulable_high=schedulable_high,
        scheduled_low=Hour.FOUR_PM * HOUR,
        scheduled_high=Hour.FOUR_PM * HOUR + 15 * MINUTE,
        job_id="job_a",
        recurrence_id="recurrence-override",
        consistency_group_id=anchor_group,
    )
    job_b = _make_job(
        schedulable_low=schedulable_low + DAY,
        schedulable_high=schedulable_high + DAY,
        scheduled_low=DAY + Hour.EIGHT_PM * HOUR,
        scheduled_high=DAY + Hour.EIGHT_PM * HOUR + 15 * MINUTE,
        job_id="job_b",
        recurrence_id="recurrence-override",
        consistency_group_id=anchor_group,
    )

    schedule = engine.Schedule([job_a, job_b])
    cost_function = engine.ScheduleCostFunction(
        schedule,
        MINUTE,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
    )

    expected_mismatch_pairs = 1.0
    assert cost_function.schedule_cost() == pytest.approx(expected_mismatch_pairs, rel=1e-6)


def test_granularity_cost_penalizes_off_half_hour_starts():
    job = _make_job(
        schedulable_low=0,
        schedulable_high=2 * DAY,
        scheduled_low=Day.MONDAY * DAY + Hour.THREE_PM * HOUR + 5 * MINUTE,
        scheduled_high=Day.MONDAY * DAY + Hour.FOUR_PM * HOUR + 5 * MINUTE,
        job_id="job_granularity",
    )
    schedule = engine.Schedule([job])

    cost_function = engine.ScheduleCostFunction(
        schedule,
        MINUTE,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
    )

    assert cost_function.schedule_cost() == pytest.approx(5.0 / 30.0, rel=1e-6)
# def test_thursday_no_cost():
#     # Given
#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(Day.THURSDAY * DAY + Hour.TWELVE_AM * HOUR, 
#                                     Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(Day.THURSDAY * DAY + Hour.ELEVEN_PM * HOUR, 
#                                     Day.THURSDAY * DAY + Hour.ELEVEN_PM * HOUR + 30 * MINUTE)
#     duration = tr_scheduled.get_high() - tr_scheduled.get_low()

#     job = engine.Job(
#         duration,
#         tr_schedulable,
#         tr_scheduled,
#         "test_job",
#         policy,
#         set(),  # dependencies
#         {tag},  # tags
#     )
    
#     schedule = engine.Schedule([job])

#     cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)

#     # Assert that
#     assert(cost_function.schedule_cost() < EPSILON)

# def test_busy_day_constant_cost():
#     # Given
#     for day in range(5):
#         tag = engine.Tag(WORK_TAG)
#         policy = engine.Policy(0, 0, 0)
#         tr_schedulable = engine.TimeRange(day * DAY + Hour.TWELVE_AM * HOUR, 
#                                         (day + 1) * DAY + Hour.ELEVEN_PM * HOUR)
#         tr_scheduled = engine.TimeRange(day * DAY + Hour.ELEVEN_PM * HOUR, 
#                                         day * DAY + Hour.ELEVEN_PM * HOUR + 30 * MINUTE)
#         duration = tr_scheduled.get_high() - tr_scheduled.get_low()

#         job = engine.Job(
#             duration,
#             tr_schedulable,
#             tr_scheduled,
#             "test_job",
#             policy,
#             set(),  # dependencies
#             {tag},  # tags
#         )

#         schedule = engine.Schedule([job])

#         cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)

#         # Assert that
#         assert(abs(cost_function.busy_day_constant_cost(day) - 0.5) < EPSILON)


# def test_next_saturday_cost():
#     # Given
#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(WEEK + Day.SATURDAY * DAY + Hour.TWELVE_AM * HOUR, 
#                                       WEEK + Day.SUNDAY * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(WEEK + Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR, 
#                                     WEEK + Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR + 30 * MINUTE)
#     duration = tr_scheduled.get_high() - tr_scheduled.get_low()

#     job = engine.Job(
#         duration,
#         tr_schedulable,
#         tr_scheduled,
#         "test_job",
#         policy,
#         set(),  # dependencies
#         {tag},  # tags
#     )

#     schedule = engine.Schedule([job])

#     cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)

#     # Assert that
#     assert(abs(cost_function.schedule_cost() - 0.5) < EPSILON)

# def test_busy_afternoon_cost():
#     # Given
#     day = Day.MONDAY

#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(day * DAY + Hour.TWELVE_AM * HOUR, 
#                                     (day + 1) * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(day * DAY + Hour.ELEVEN_PM * HOUR, 
#                                     day * DAY + Hour.ELEVEN_PM * HOUR + 30 * MINUTE)
#     duration = tr_scheduled.get_high() - tr_scheduled.get_low()

#     job = engine.Job(
#         duration,
#         tr_schedulable,
#         tr_scheduled,
#         "test_job",
#         policy,
#         set(),  # dependencies
#         {tag},  # tags
#     )

#     schedule = engine.Schedule([job])

#     cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)
#     print(cost_function.busy_afternoon_exponential_cost(day.value))

#     # Assert that
#     assert(abs(cost_function.busy_afternoon_exponential_cost(day.value) - math.exp(EXP_DOWNFACTOR * tr_scheduled.length() / HOUR)) < EPSILON)

# def test_fri_cost():
#     # Given
#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(Day.THURSDAY * DAY + Hour.TWELVE_AM * HOUR, 
#                                     Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(Day.FRIDAY * DAY + 1 * MINUTE, 
#                                     Day.FRIDAY * DAY + 30 * MINUTE)
#     duration = tr_scheduled.get_high() - tr_scheduled.get_low()

#     job = engine.Job(
#         duration,
#         tr_schedulable,
#         tr_scheduled,
#         "test_job",
#         policy,
#         set(),  # dependencies
#         {tag},  # tags
#     )

#     schedule = engine.Schedule([job])

#     cost_function = engine.ScheduleCostFunction(schedule, GRANULARITY)
#     print(cost_function.busy_afternoon_exponential_cost(Day.FRIDAY.value))

#     assert(cost_function.schedule_cost() < EPSILON)
