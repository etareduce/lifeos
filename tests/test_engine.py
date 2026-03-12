import engine
from collections import Counter
from .constants import *
from .constants import RANDOM_TEST_ITERATIONS
import pytest

# @pytest.mark.repeat(RANDOM_TEST_ITERATIONS)
# def test_fri_sat_cost():
#     # Given
#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(Day.THURSDAY * DAY + Hour.TWELVE_AM * HOUR, 
#                                     Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(Day.FRIDAY * DAY, 
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

#     schedule, cost_history = engine.schedule_jobs([job], GRANULARITY, 1000.0, 1.0, 10000000000)
#     print(cost_history)

#     # Assert that
#     for job in schedule.scheduled_jobs:
#         curr_scheduled_tr = job.scheduled_time_range
#         curr_schedulable_tr = job.schedulable_time_range
#         assert(curr_scheduled_tr.get_low() <= Day.FRIDAY * DAY + AFTERNOON_START * HOUR)
#         assert(curr_schedulable_tr.contains(curr_scheduled_tr))


# @pytest.mark.repeat(RANDOM_TEST_ITERATIONS)
# def test_friday_exponential_cost():
#     # Given
#     tag = engine.Tag(WORK_TAG)
#     policy = engine.Policy(0, 0, 0)
#     tr_schedulable = engine.TimeRange(Day.FRIDAY * DAY, 
#                                       Day.FRIDAY * DAY + Hour.ELEVEN_PM * HOUR)
#     tr_scheduled = engine.TimeRange(Day.FRIDAY * DAY + Hour.SEVEN_PM * HOUR, 
#                                     Day.FRIDAY * DAY + Hour.SEVEN_PM * HOUR + 30 * MINUTE)
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

#     schedule, cost_history = engine.schedule_jobs([job], GRANULARITY, 1000.0, 1.0, 100000)
#     print(cost_history)

#     print(Day.FRIDAY * DAY + Hour.SEVEN_PM * HOUR)
#     # Assert that
#     for job in schedule.scheduled_jobs:
#         curr_scheduled_tr = job.scheduled_time_range
#         curr_schedulable_tr = job.schedulable_time_range

#         # Friday jobs are exponentially discounted
#         # Singleton friday jobs should be scheduled before the
#         # afternoon cutoff time
#         assert(not ((curr_scheduled_tr.get_low() // HOUR) % 24) > AFTERNOON_START)
#         assert(curr_schedulable_tr.contains(curr_scheduled_tr))


@pytest.mark.repeat(RANDOM_TEST_ITERATIONS)
def test_scheduler_invariance_cost():
    # Given
    tag = engine.Tag(WORK_TAG)
    policy = engine.Policy(0, 0)
    tr_schedulable = engine.TimeRange(Day.FRIDAY * DAY, 
                                      Day.FRIDAY * DAY + Hour.ELEVEN_PM * HOUR)
    tr_scheduled = engine.TimeRange(Day.FRIDAY * DAY + Hour.FOUR_PM * HOUR, 
                                    Day.FRIDAY * DAY + Hour.FOUR_PM * HOUR + 30 * MINUTE)
    duration = tr_scheduled.get_high() - tr_scheduled.get_low()

    job = engine.Job(
        duration,
        tr_schedulable,
        tr_scheduled,
        "test_job",
        policy,
        set(),  # dependencies
        {tag},  # tags
    )

    schedule, cost_history = engine.schedule_jobs([job], GRANULARITY, 1000.0, 1.0, 100000000)
    print(cost_history)

    job = schedule.scheduled_jobs[0]
    curr_scheduled_tr = job.scheduled_time_range
    curr_schedulable_tr = job.schedulable_time_range
    assert(curr_schedulable_tr.contains(curr_scheduled_tr))
    assert(curr_scheduled_tr.get_low() == tr_scheduled.get_low())


def test_force_split_schedule(monkeypatch):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "4242")
    split_policy = engine.Policy(1, HOUR, True, False, False, True)
    rigid_policy = engine.Policy(0, 0)

    schedulable = engine.TimeRange(Day.MONDAY * DAY + Hour.NINE_AM * HOUR,
                                   Day.MONDAY * DAY + Hour.TWELVE_PM * HOUR)
    rigid_range = engine.TimeRange(Day.MONDAY * DAY + Hour.TEN_AM * HOUR,
                                   Day.MONDAY * DAY + Hour.ELEVEN_AM * HOUR)

    split_job = engine.Job(
        2 * HOUR,
        schedulable,
        engine.TimeRange(Day.MONDAY * DAY + Hour.NINE_AM * HOUR,
                         Day.MONDAY * DAY + Hour.ELEVEN_AM * HOUR),
        "split_job",
        split_policy,
        set(),
        set(),
    )

    rigid_job = engine.Job(
        HOUR,
        rigid_range,
        rigid_range,
        "rigid_job",
        rigid_policy,
        set(),
        set(),
    )

    schedule, _ = engine.schedule_jobs([split_job, rigid_job], HOUR, 1000.0, 0.01, 50000)
    scheduled_split = next(job for job in schedule.scheduled_jobs if job.id == "split_job")
    ranges = list(scheduled_split.scheduled_time_ranges)

    assert len(ranges) == 2
    total_duration = sum(r.get_high() - r.get_low() for r in ranges)
    assert total_duration == split_job.duration
    assert all((r.get_high() - r.get_low()) >= HOUR for r in ranges)
    assert all(r.get_low() % HOUR == 0 for r in ranges)


def _make_job(
    schedulable_low,
    schedulable_high,
    scheduled_low,
    scheduled_high,
    policy=None,
    job_id="job",
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
    )


def test_timerange_overlap_contains_length():
    range_a = engine.TimeRange(0, 2 * HOUR)
    range_b = engine.TimeRange(HOUR, 3 * HOUR)
    range_c = engine.TimeRange(2 * HOUR, 3 * HOUR)
    range_inside = engine.TimeRange(30 * MINUTE, HOUR)

    assert range_a.overlaps(range_b)
    assert not range_a.overlaps(range_c)
    assert range_a.contains(range_inside)
    assert range_a.length() == 2 * HOUR


def test_tag_equality_and_hashing():
    tag_a = engine.Tag("work", "primary")
    tag_b = engine.Tag("work", "secondary")
    tag_c = engine.Tag("rest", "secondary")

    assert tag_a == tag_b
    assert tag_a != tag_c
    assert len({tag_a, tag_b, tag_c}) == 2


def test_schedule_jobs_preserves_rigid_times():
    rigid_schedulable = engine.TimeRange(Day.MONDAY * DAY + Hour.NINE_AM * HOUR,
                                         Day.MONDAY * DAY + Hour.TEN_AM * HOUR)
    rigid_scheduled = engine.TimeRange(Day.MONDAY * DAY + Hour.TEN_AM * HOUR,
                                       Day.MONDAY * DAY + Hour.ELEVEN_AM * HOUR)
    rigid_job = engine.Job(
        HOUR,
        rigid_schedulable,
        rigid_scheduled,
        "rigid_job",
        engine.Policy(0, 0),
        set(),
        set(),
    )

    schedule, _ = engine.schedule_jobs([rigid_job], HOUR, 10.0, 0.1, 500)
    scheduled_job = schedule.scheduled_jobs[0]

    assert scheduled_job.scheduled_time_range == rigid_schedulable
    assert scheduled_job.scheduled_time_ranges[0] == rigid_schedulable


def test_scheduler_prefers_single_consistent_daily_phase_with_one_conflict(monkeypatch):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "20260311")

    policy = engine.Policy(0, 0)
    family_jobs = []
    for index, day in enumerate(
        [Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY], start=1
    ):
        schedulable_start = day * DAY + Hour.EIGHT_AM * HOUR
        schedulable_end = day * DAY + Hour.TWELVE_PM * HOUR
        default_start = day * DAY + Hour.EIGHT_AM * HOUR
        default_end = default_start + HOUR
        family_jobs.append(
            engine.Job(
                HOUR,
                engine.TimeRange(schedulable_start, schedulable_end),
                engine.TimeRange(default_start, default_end),
                f"family_job_{index}",
                policy,
                set(),
                set(),
                "recurrence-family",
            )
        )

    # Thursday at 08:00 is blocked, so the family should coalesce on another shared phase.
    blocker_start = Day.THURSDAY * DAY + Hour.EIGHT_AM * HOUR
    blocker_end = blocker_start + HOUR
    blocker = engine.Job(
        HOUR,
        engine.TimeRange(blocker_start, blocker_end),
        engine.TimeRange(blocker_start, blocker_end),
        "blocker",
        policy,
        set(),
        set(),
    )

    schedule, _ = engine.schedule_jobs(
        [*family_jobs, blocker],
        HOUR,
        20.0,
        1e-4,
        200000,
    )

    scheduled_family = [
        job for job in schedule.scheduled_jobs if job.id.startswith("family_job_")
    ]
    phases = {job.scheduled_time_range.get_low() % DAY for job in scheduled_family}

    assert len(phases) == 1
    assert next(iter(phases)) != Hour.EIGHT_AM * HOUR


def test_scheduler_keeps_majority_daily_family_aligned_under_one_day_conflict(monkeypatch):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "20260311")

    policy = engine.Policy(0, 0)
    family_jobs = []
    for day in [
        Day.MONDAY,
        Day.TUESDAY,
        Day.WEDNESDAY,
        Day.THURSDAY,
        Day.FRIDAY,
        Day.SATURDAY,
        Day.SUNDAY,
    ]:
        schedulable_start = day * DAY + Hour.TWELVE_PM * HOUR
        schedulable_end = day * DAY + Hour.EIGHT_PM * HOUR
        default_start = day * DAY + Hour.FOUR_PM * HOUR
        default_end = default_start + 30 * MINUTE
        family_jobs.append(
            engine.Job(
                30 * MINUTE,
                engine.TimeRange(schedulable_start, schedulable_end),
                engine.TimeRange(default_start, default_end),
                f"family_job_{day}",
                policy,
                set(),
                set(),
                "recurrence-family-daily",
            )
        )

    # Saturday cannot occupy 16:00 due to this fixed blocker.
    saturday_blocker_start = Day.SATURDAY * DAY + Hour.FOUR_PM * HOUR
    saturday_blocker = engine.Job(
        2 * HOUR,
        engine.TimeRange(saturday_blocker_start, saturday_blocker_start + 2 * HOUR),
        engine.TimeRange(saturday_blocker_start, saturday_blocker_start + 2 * HOUR),
        "saturday_blocker",
        policy,
        set(),
        set(),
    )
    # Additional fixed jobs add search pressure to avoid trivial alignment by chance.
    context_blockers = []
    for day, hour in [
        (Day.MONDAY, Hour.TWO_PM),
        (Day.TUESDAY, Hour.THREE_PM),
        (Day.WEDNESDAY, Hour.ONE_PM),
        (Day.THURSDAY, Hour.FIVE_PM),
        (Day.FRIDAY, Hour.TWO_PM),
        (Day.SUNDAY, Hour.SIX_PM),
    ]:
        start = day * DAY + hour * HOUR
        context_blockers.append(
            engine.Job(
                HOUR,
                engine.TimeRange(start, start + HOUR),
                engine.TimeRange(start, start + HOUR),
                f"context_blocker_{day}_{hour}",
                policy,
                set(),
                set(),
            )
        )

    schedule, _ = engine.schedule_jobs(
        [*family_jobs, saturday_blocker, *context_blockers],
        5 * MINUTE,
        20.0,
        1e-4,
        120000,
    )

    scheduled_family = [
        job for job in schedule.scheduled_jobs if job.id.startswith("family_job_")
    ]
    phases = [job.scheduled_time_range.get_low() % DAY for job in scheduled_family]
    most_common_phase_count = Counter(phases).most_common(1)[0][1]

    assert most_common_phase_count >= 6


def test_scheduler_forms_maximal_consistent_subsets_across_weeks_when_global_phase_impossible(
    monkeypatch,
):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "20260312")

    policy = engine.Policy(0, 0)
    family_jobs = []

    # Six occurrences (across two weeks) share only an early-afternoon window.
    for week_offset in [0, WEEK]:
        for day in [Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY]:
            schedulable_start = week_offset + day * DAY + Hour.TWELVE_PM * HOUR
            schedulable_end = week_offset + day * DAY + Hour.TWO_PM * HOUR
            default_start = week_offset + day * DAY + Hour.ONE_PM * HOUR
            default_end = default_start + 30 * MINUTE
            family_jobs.append(
                engine.Job(
                    30 * MINUTE,
                    engine.TimeRange(schedulable_start, schedulable_end),
                    engine.TimeRange(default_start, default_end),
                    f"family_early_{week_offset}_{day}",
                    policy,
                    set(),
                    set(),
                    "recurrence-two-phase",
                )
            )

    # Two additional occurrences (across two weeks) can only be scheduled in late afternoon.
    for week_offset in [0, WEEK]:
        day = Day.THURSDAY
        schedulable_start = week_offset + day * DAY + Hour.FOUR_PM * HOUR
        schedulable_end = week_offset + day * DAY + Hour.SIX_PM * HOUR
        default_start = week_offset + day * DAY + Hour.FIVE_PM * HOUR
        default_end = default_start + 30 * MINUTE
        family_jobs.append(
            engine.Job(
                30 * MINUTE,
                engine.TimeRange(schedulable_start, schedulable_end),
                engine.TimeRange(default_start, default_end),
                f"family_late_{week_offset}",
                policy,
                set(),
                set(),
                "recurrence-two-phase",
            )
        )

    schedule, _ = engine.schedule_jobs(
        family_jobs,
        5 * MINUTE,
        20.0,
        1e-4,
        180000,
    )

    scheduled_family = [
        job for job in schedule.scheduled_jobs if job.recurrence_id == "recurrence-two-phase"
    ]
    phase_counts = Counter(job.scheduled_time_range.get_low() % DAY for job in scheduled_family)

    # No single phase can satisfy both windows, so the family should collapse into two maximal subsets.
    assert len(phase_counts) == 2
    assert sorted(phase_counts.values()) == [2, 6]


def test_scheduler_aligns_all_legal_days_across_weeks_when_only_saturday_conflicts(monkeypatch):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "20260313")

    policy = engine.Policy(0, 0)
    family_jobs = []

    for week_offset in [0, WEEK]:
        for day in [
            Day.MONDAY,
            Day.TUESDAY,
            Day.WEDNESDAY,
            Day.THURSDAY,
            Day.FRIDAY,
            Day.SATURDAY,
            Day.SUNDAY,
        ]:
            schedulable_start = week_offset + day * DAY + Hour.TWELVE_PM * HOUR
            schedulable_end = week_offset + day * DAY + Hour.EIGHT_PM * HOUR
            default_start = week_offset + day * DAY + Hour.ONE_PM * HOUR
            default_end = default_start + 30 * MINUTE
            family_jobs.append(
                engine.Job(
                    30 * MINUTE,
                    engine.TimeRange(schedulable_start, schedulable_end),
                    engine.TimeRange(default_start, default_end),
                    f"family_day_{week_offset}_{day}",
                    policy,
                    set(),
                    set(),
                    "recurrence-sat-conflict",
                )
            )

    blockers = []
    for week_offset in [0, WEEK]:
        saturday_start = week_offset + Day.SATURDAY * DAY + Hour.ONE_PM * HOUR
        blockers.append(
            engine.Job(
                2 * HOUR,
                engine.TimeRange(saturday_start, saturday_start + 2 * HOUR),
                engine.TimeRange(saturday_start, saturday_start + 2 * HOUR),
                f"saturday_blocker_{week_offset}",
                policy,
                set(),
                set(),
            )
        )

    schedule, _ = engine.schedule_jobs(
        [*family_jobs, *blockers],
        5 * MINUTE,
        20.0,
        1e-4,
        200000,
    )

    scheduled_family = [
        job for job in schedule.scheduled_jobs if job.recurrence_id == "recurrence-sat-conflict"
    ]
    phase_counts = Counter(job.scheduled_time_range.get_low() % DAY for job in scheduled_family)

    # Both Saturdays are constrained away from the dominant phase; all other days should align.
    assert len(phase_counts) == 2
    assert sorted(phase_counts.values()) == [2, 12]


def test_scheduler_finds_legal_slot_when_default_overlaps_fixed_blocker(monkeypatch):
    monkeypatch.setenv("ELASTISCHED_RNG_SEED", "20260312")

    policy = engine.Policy(0, 0, False, False)
    flexible = engine.Job(
        15 * MINUTE,
        engine.TimeRange(Day.SATURDAY * DAY + Hour.TWELVE_PM * HOUR,
                         Day.SATURDAY * DAY + Hour.ELEVEN_PM * HOUR),
        engine.TimeRange(Day.SATURDAY * DAY + Hour.FIVE_PM * HOUR,
                         Day.SATURDAY * DAY + Hour.FIVE_PM * HOUR + 15 * MINUTE),
        "flexible",
        policy,
        set(),
        set(),
        "recurrence-flex",
    )
    blocker = engine.Job(
        170 * MINUTE,
        engine.TimeRange(Day.SATURDAY * DAY + Hour.FOUR_PM * HOUR + 30 * MINUTE,
                         Day.SATURDAY * DAY + Hour.SEVEN_PM * HOUR + 20 * MINUTE),
        engine.TimeRange(Day.SATURDAY * DAY + Hour.FOUR_PM * HOUR + 30 * MINUTE,
                         Day.SATURDAY * DAY + Hour.SEVEN_PM * HOUR + 20 * MINUTE),
        "blocker",
        policy,
        set(),
        set(),
    )

    schedule, _ = engine.schedule_jobs(
        [flexible, blocker],
        5 * MINUTE,
        10.0,
        1e-4,
        20000,
    )

    flexible_job = next(job for job in schedule.scheduled_jobs if job.id == "flexible")
    blocker_job = next(job for job in schedule.scheduled_jobs if job.id == "blocker")

    assert not flexible_job.scheduled_time_range.overlaps(blocker_job.scheduled_time_range)
