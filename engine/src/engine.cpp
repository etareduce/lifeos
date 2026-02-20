#include "engine.hpp"

#include "constants.hpp"
#include "policy.hpp"
#include "optimizer.hpp"

#include <algorithm>
#include <cstddef>
#include <iostream>
#include <optional>
#include <queue>
#include <random>
#include <set>
#include <unordered_map>
#include <utility>

namespace {

template<typename T>
std::optional<T> safe_min(std::optional<T> u, std::optional<T> v) {
    if (u.has_value() && v.has_value()) {
        return (u.value() < v.value() ? u : v);
    } else if (u.has_value()) {
        return u;
    } else if (v.has_value()) {
        return v;
    }
    return std::nullopt;
}

template<typename T>
std::optional<T> safe_max(std::optional<T> u, std::optional<T> v) {
    if (u.has_value() && v.has_value()) {
        return (u.value() > v.value() ? u : v);
    } else if (u.has_value()) {
        return u;
    } else if (v.has_value()) {
        return v;
    }
    return std::nullopt;
}

std::vector<TimeRange> get_job_scheduled_ranges(const Job& job) {
    if (!job.scheduled_time_ranges.empty()) {
        return job.scheduled_time_ranges;
    }
    return {job.scheduled_time_range};
}

sec_t get_job_anchor_start(const Job& job) {
    const auto ranges = get_job_scheduled_ranges(job);
    if (ranges.empty()) {
        return job.scheduled_time_range.get_low();
    }
    sec_t earliest = ranges.front().get_low();
    for (const auto& range : ranges) {
        if (range.get_low() < earliest) {
            earliest = range.get_low();
        }
    }
    return earliest;
}

double normalized_weekly_distance(sec_t a, sec_t b) {
    const sec_t week_seconds = static_cast<sec_t>(7) * constants::DAY;
    if (week_seconds == 0) {
        return 0.0;
    }
    const sec_t phase_a = a % week_seconds;
    const sec_t phase_b = b % week_seconds;
    const sec_t direct = (phase_a >= phase_b) ? (phase_a - phase_b) : (phase_b - phase_a);
    const sec_t wrapped = week_seconds - direct;
    const sec_t distance = std::min(direct, wrapped);
    return static_cast<double>(distance) / static_cast<double>(week_seconds);
}

double normalized_half_hour_distance(sec_t t) {
    const sec_t half_hour_seconds = static_cast<sec_t>(30) * static_cast<sec_t>(60);
    if (half_hour_seconds == 0) {
        return 0.0;
    }
    const sec_t phase = t % half_hour_seconds;
    const sec_t to_prev_mark = phase;
    const sec_t to_next_mark = half_hour_seconds - phase;
    const sec_t distance = std::min(to_prev_mark, to_next_mark);
    return static_cast<double>(distance) / static_cast<double>(half_hour_seconds);
}

std::vector<std::vector<Job>> get_disjoint_intervals(std::vector<Job> jobs) {
    if (jobs.empty()) {
        return {};
    }

    std::vector<std::vector<Job>> disjoint_intervals;

    std::sort(jobs.begin(), jobs.end(), [](const Job& a, const Job& b) {
        return a.schedulable_time_range.get_low() < b.schedulable_time_range.get_low();
    });

    sec_t curr_end = jobs[0].schedulable_time_range.get_high();
    disjoint_intervals.push_back({jobs[0]});

    for (size_t i = 1; i < jobs.size(); ++i) {
        auto& job = jobs[i];

        if (job.schedulable_time_range.get_low() >= curr_end) {
            disjoint_intervals.push_back({job});
            curr_end = disjoint_intervals.back().back().schedulable_time_range.get_high();
        } else {
            disjoint_intervals.back().push_back(std::move(job));
            curr_end = std::max(curr_end, disjoint_intervals.back().back().schedulable_time_range.get_high());
        }
    }

    return disjoint_intervals;
}

TimeRange generate_random_time_range_within(
    const TimeRange& schedulable_time_range,
    sec_t duration,
    sec_t granularity,
    std::mt19937& gen)
{
    sec_t earliest_start = ((schedulable_time_range.get_low() + granularity - 1) / granularity) * granularity;
    sec_t raw_latest_start = schedulable_time_range.get_high() - duration;
    sec_t latest_start = (raw_latest_start / granularity) * granularity;

    if (latest_start < earliest_start) {
        throw std::invalid_argument("Schedulable timerange too small for the job duration");
    }

    size_t num_slots = (latest_start - earliest_start) / granularity + 1;

    std::uniform_int_distribution<size_t> dis(0, num_slots - 1);
    size_t random_slot = dis(gen);

    sec_t start = earliest_start + random_slot * granularity;
    return TimeRange(start, start + duration);
}

bool ranges_overlap(const TimeRange& candidate, const std::vector<TimeRange>& ranges) {
    for (const auto& range : ranges) {
        if (candidate.overlaps(range)) {
            return true;
        }
    }
    return false;
}

std::vector<sec_t> generate_split_durations(
    sec_t duration,
    size_t segment_count,
    sec_t min_split_duration,
    sec_t granularity,
    bool round_to_granularity,
    std::mt19937& gen
) {
    if (segment_count <= 1) {
        return {duration};
    }

    sec_t unit = 1;
    if (round_to_granularity && granularity > 0 && duration % granularity == 0) {
        unit = granularity;
    } else {
        round_to_granularity = false;
    }

    sec_t min_split = min_split_duration > 0 ? min_split_duration : 1;
    if (round_to_granularity && unit > 1) {
        min_split = ((min_split + unit - 1) / unit) * unit;
    }

    if (min_split * segment_count > duration) {
        return {};
    }

    std::vector<sec_t> durations(segment_count, min_split);
    sec_t remaining = duration - min_split * segment_count;

    if (round_to_granularity && unit > 1) {
        if (remaining % unit != 0) {
            return {};
        }
        size_t increments = remaining / unit;
        std::uniform_int_distribution<size_t> dist(0, segment_count - 1);
        for (size_t i = 0; i < increments; ++i) {
            durations[dist(gen)] += unit;
        }
        return durations;
    }

    if (remaining > 0) {
        std::vector<sec_t> cuts;
        cuts.reserve(segment_count + 1);
        std::uniform_int_distribution<sec_t> dist(0, remaining);
        cuts.push_back(0);
        cuts.push_back(remaining);
        for (size_t i = 0; i < segment_count - 1; ++i) {
            cuts.push_back(dist(gen));
        }
        std::sort(cuts.begin(), cuts.end());
        for (size_t i = 0; i < segment_count; ++i) {
            durations[i] += (cuts[i + 1] - cuts[i]);
        }
    }
    return durations;
}

std::vector<TimeRange> place_split_segments(
    const TimeRange& schedulable_time_range,
    const std::vector<sec_t>& durations,
    sec_t granularity,
    std::mt19937& gen
) {
    std::vector<TimeRange> segments;
    std::vector<sec_t> durations_copy = durations;
    std::shuffle(durations_copy.begin(), durations_copy.end(), gen);
    for (const auto& duration : durations_copy) {
        bool placed = false;
        const int max_attempts = 50;
        for (int attempt = 0; attempt < max_attempts; ++attempt) {
            TimeRange candidate = generate_random_time_range_within(
                schedulable_time_range,
                duration,
                granularity,
                gen
            );
            if (!ranges_overlap(candidate, segments)) {
                segments.push_back(candidate);
                placed = true;
                break;
            }
        }
        if (!placed) {
            return {};
        }
    }
    std::sort(segments.begin(), segments.end(), [](const TimeRange& a, const TimeRange& b) {
        return a.get_low() < b.get_low();
    });
    return segments;
}

Schedule generate_random_schedule_neighbor(
    Schedule s,
    const sec_t granularity,
    std::mt19937& gen
) {
    std::vector<Job>& jobs = s.scheduled_jobs;
    std::vector<size_t> flexible_indices;

    for (size_t i = 0; i < jobs.size(); ++i) {
        if (!jobs[i].is_rigid()) {
            flexible_indices.push_back(i);
        }
    }

    if (flexible_indices.empty()) {
        return s;
    }

    std::uniform_int_distribution<> dist(0, flexible_indices.size() - 1);
    size_t chosen_index = flexible_indices[dist(gen)];

    Job& random_flexible_job = jobs[chosen_index];
    Policy policy = random_flexible_job.policy;
    bool can_split = policy.is_splittable() && policy.get_max_splits() > 0;
    sec_t min_split_duration = policy.get_min_split_duration();
    sec_t min_split = min_split_duration > 0 ? min_split_duration : 1;
    bool round_to_granularity = policy.get_round_to_granularity()
        && granularity > 0
        && (random_flexible_job.duration % granularity == 0);
    if (round_to_granularity && granularity > 1) {
        min_split = ((min_split + granularity - 1) / granularity) * granularity;
    }
    size_t max_segments = static_cast<size_t>(policy.get_max_splits()) + 1;
    size_t max_segments_by_duration = static_cast<size_t>(random_flexible_job.duration / min_split);
    size_t possible_segments = std::min(max_segments, max_segments_by_duration);
    const bool is_currently_split = random_flexible_job.get_scheduled_time_ranges().size() > 1;

    if (is_currently_split) {
        constexpr double merge_probability = 0.3;
        std::bernoulli_distribution merge_decision(merge_probability);
        if (merge_decision(gen)) {
            TimeRange random_time_range = generate_random_time_range_within(
                random_flexible_job.schedulable_time_range,
                random_flexible_job.duration,
                granularity,
                gen
            );
            random_flexible_job.set_scheduled_time_ranges({random_time_range});
            return s;
        }
    }

    bool attempt_split = false;
    if (can_split && possible_segments >= 2) {
        std::uniform_int_distribution<int> split_decision(0, 1);
        attempt_split = (split_decision(gen) == 1);
    }

    if (attempt_split) {
        std::uniform_int_distribution<size_t> split_count_dist(2, possible_segments);
        size_t segment_count = split_count_dist(gen);
        std::vector<sec_t> split_durations = generate_split_durations(
            random_flexible_job.duration,
            segment_count,
            min_split_duration,
            granularity,
            round_to_granularity,
            gen
        );

        if (!split_durations.empty()) {
            std::vector<TimeRange> split_ranges = place_split_segments(
                random_flexible_job.schedulable_time_range,
                split_durations,
                granularity,
                gen
            );
            if (!split_ranges.empty()) {
                random_flexible_job.set_scheduled_time_ranges(split_ranges);
                return s;
            }
        }
    }

    TimeRange random_time_range = generate_random_time_range_within(
        random_flexible_job.schedulable_time_range,
        random_flexible_job.duration,
        granularity,
        gen
    );

    random_flexible_job.set_scheduled_time_ranges({random_time_range});

    return s;
}
} // namespace

Schedule::Schedule(std::vector<Job> scheduled_jobs) : scheduled_jobs(scheduled_jobs) {}

void Schedule::add_job(const Job& job) {
    scheduled_jobs.push_back(job);
}

void Schedule::clear() {
    scheduled_jobs.clear();
}

std::ostream& operator<<(std::ostream& os, const Schedule& schedule) {
    const auto& jobs = schedule.scheduled_jobs;
    os << "Schedule contains " << jobs.size() << " job(s):\n";
    for (const auto& job : jobs) {
        os << "  - Job Name: " << job.id << ", Scheduled Time: " << job.scheduled_time_range << "\n";
    }
    return os;
}

DependencyViolation::DependencyViolation(ID job_id, const std::set<ID>& violated_dependencies)
    : job_id(std::move(job_id)), violated_dependencies(violated_dependencies) {}

DependencyCheckResult::DependencyCheckResult()
    : has_violations(false), has_cyclic_dependencies(false) {}

DependencyCheckResult check_dependency_violations(const Schedule& schedule) {
    DependencyCheckResult result;

    if (schedule.scheduled_jobs.empty()) {
        return result;
    }

    std::unordered_map<ID, const Job*> job_map;
    std::unordered_map<ID, sec_t> earliest_start;
    std::unordered_map<ID, sec_t> latest_end;
    for (const auto& job : schedule.scheduled_jobs) {
        job_map[job.id] = &job;
        sec_t min_start = job.scheduled_time_range.get_low();
        sec_t max_end = job.scheduled_time_range.get_high();
        if (!job.scheduled_time_ranges.empty()) {
            min_start = job.scheduled_time_ranges.front().get_low();
            max_end = job.scheduled_time_ranges.front().get_high();
            for (const auto& range : job.scheduled_time_ranges) {
                min_start = std::min(min_start, range.get_low());
                max_end = std::max(max_end, range.get_high());
            }
        }
        earliest_start[job.id] = min_start;
        latest_end[job.id] = max_end;
    }

    std::unordered_map<ID, std::vector<ID>> adj_list;
    std::unordered_map<ID, int> in_degree;

    for (const auto& job : schedule.scheduled_jobs) {
        in_degree[job.id] = 0;
        adj_list[job.id] = std::vector<ID>();
    }

    for (const auto& job : schedule.scheduled_jobs) {
        for (const ID& dep_id : job.dependencies) {
            if (job_map.find(dep_id) != job_map.end()) {
                adj_list[dep_id].push_back(job.id);
                in_degree[job.id]++;
            }
        }
    }

    std::queue<ID> queue;
    std::vector<ID> topological_order;

    for (const auto& pair : in_degree) {
        if (pair.second == 0) {
            queue.push(pair.first);
        }
    }

    while (!queue.empty()) {
        ID current_id = queue.front();
        queue.pop();
        topological_order.push_back(current_id);

        for (ID neighbor_id : adj_list[current_id]) {
            in_degree[neighbor_id]--;
            if (in_degree[neighbor_id] == 0) {
                queue.push(neighbor_id);
            }
        }
    }

    if (topological_order.size() != schedule.scheduled_jobs.size()) {
        result.has_cyclic_dependencies = true;
        result.has_violations = true;
        return result;
    }

    for (const auto& job : schedule.scheduled_jobs) {
        std::set<ID> violated_deps;

        for (const ID& dep_id : job.dependencies) {
            if (job_map.find(dep_id) != job_map.end()) {
                if (latest_end[dep_id] > earliest_start[job.id]) {
                    violated_deps.insert(dep_id);
                }
            }
        }

        if (!violated_deps.empty()) {
            result.violations.emplace_back(job.id, violated_deps);
            result.has_violations = true;
        }
    }

    return result;
}

ScheduleCostFunction::ScheduleCostFunction(
    const Schedule& schedule,
    sec_t granularity,
    double illegal_schedule_weight,
    double overlap_cost_weight,
    double split_cost_weight,
    double consistency_cost_weight,
    double granularity_cost_weight)
    :
schedule_ref(schedule),
granularity(granularity),
illegal_schedule_weight(illegal_schedule_weight),
overlap_cost_weight(overlap_cost_weight),
split_cost_weight(split_cost_weight),
consistency_cost_weight(consistency_cost_weight),
granularity_cost_weight(granularity_cost_weight)
{
    if (schedule.scheduled_jobs.size() == 0) {
        return;
    }

    for (const auto& job : schedule.scheduled_jobs) {
        for (const auto& range : get_job_scheduled_ranges(job)) {
            min_time = safe_min<sec_t>(min_time, range.get_low());
            max_time = safe_max<sec_t>(max_time, range.get_high());
        }
    }

    TimeRange curr = TimeRange(0, constants::DAY - 1);
    day_based_schedule.insert(curr, std::nullopt);

    while (curr.get_high() < max_time.value()) {
        sec_t next_low = curr.get_high() + 1;
        TimeRange next = TimeRange(next_low, next_low + constants::DAY - 1);
        day_based_schedule.insert(next, std::nullopt);
        curr = next;
    }

    for (const auto& job : schedule.scheduled_jobs) {
        for (const auto& range : get_job_scheduled_ranges(job)) {
            TimeRange curr_interval = TimeRange(range.get_low()); // TimeRange representing unit of time
            std::optional<std::vector<Job>>* curr_day_jobs = day_based_schedule.search_value(curr_interval);
            if (curr_day_jobs) {
                curr_day_jobs->emplace().push_back(job);
            }
        }
    }
}

double ScheduleCostFunction::context_switch_cost() const {
    return 0.0f;
}

double ScheduleCostFunction::illegal_schedule_cost() const {
    const std::vector<Job>& scheduled_jobs = schedule_ref.scheduled_jobs;
    IntervalTree<sec_t, size_t> non_overlappable_jobs;

    for (size_t i = 0; i < scheduled_jobs.size(); ++i) {
        const Job& curr = scheduled_jobs[i];
        Policy curr_policy = curr.policy;

        for (const auto& range : get_job_scheduled_ranges(curr)) {
            if (!curr.schedulable_time_range.contains(range)) {
                return constants::ILLEGAL_SCHEDULE_COST;
            }

            if (!curr_policy.is_overlappable()) {
                auto overlapping_interval = non_overlappable_jobs.search_overlap(
                    range
                );

                if (overlapping_interval != nullptr) {
                    return constants::ILLEGAL_SCHEDULE_COST;
                }

                non_overlappable_jobs.insert(
                    range,
                    i
                );
            }
        }
    }

    DependencyCheckResult dependency_check = check_dependency_violations(schedule_ref);
    if (dependency_check.has_cyclic_dependencies || dependency_check.has_violations) {
        return constants::ILLEGAL_SCHEDULE_COST;
    }

    return 0.0f;
}

double ScheduleCostFunction::overlap_cost() const {
    const std::vector<Job>& scheduled_jobs = schedule_ref.scheduled_jobs;
    if (scheduled_jobs.size() < 2) {
        return 0.0f;
    }
    const double granularity_value = granularity > 0 ? static_cast<double>(granularity) : 1.0;
    IntervalTree<sec_t, size_t> overlap_tree;
    double cost = 0.0f;
    for (size_t i = 0; i < scheduled_jobs.size(); ++i) {
        for (const auto& current : get_job_scheduled_ranges(scheduled_jobs[i])) {
            const auto overlaps = overlap_tree.find_overlapping(current);
            for (const auto* interval : overlaps) {
                cost += static_cast<double>(current.overlap_length(*interval)) / granularity_value;
            }
            overlap_tree.insert(current, i);
        }
    }
    return cost;
}

double ScheduleCostFunction::split_cost() const {
    const std::vector<Job>& scheduled_jobs = schedule_ref.scheduled_jobs;
    double cost = 0.0f;
    for (const auto& job : scheduled_jobs) {
        const auto ranges = get_job_scheduled_ranges(job);
        if (ranges.size() > 1) {
            cost += (static_cast<double>(ranges.size() - 1) * constants::SPLIT_COST_FACTOR);
        }
    }
    return cost;
}

double ScheduleCostFunction::consistency_cost() const {
    std::unordered_map<ID, std::vector<sec_t>> starts_by_recurrence;
    for (const auto& job : schedule_ref.scheduled_jobs) {
        if (job.recurrence_id.empty()) {
            continue;
        }
        starts_by_recurrence[job.recurrence_id].push_back(get_job_anchor_start(job));
    }

    double cost = 0.0;
    for (const auto& [recurrence_id, starts] : starts_by_recurrence) {
        (void)recurrence_id;
        if (starts.size() < 2) {
            continue;
        }
        for (size_t i = 0; i < starts.size(); ++i) {
            for (size_t j = i + 1; j < starts.size(); ++j) {
                cost += normalized_weekly_distance(starts[i], starts[j]);
            }
        }
    }
    return cost;
}

double ScheduleCostFunction::granularity_cost() const {
    double cost = 0.0;
    for (const auto& job : schedule_ref.scheduled_jobs) {
        for (const auto& range : get_job_scheduled_ranges(job)) {
            cost += normalized_half_hour_distance(range.get_low());
        }
    }
    return cost;
}

double ScheduleCostFunction::schedule_cost() const {
    double cost =
        (illegal_schedule_weight * illegal_schedule_cost()) +
        (overlap_cost_weight * overlap_cost()) +
        (split_cost_weight * split_cost()) +
        (consistency_cost_weight * consistency_cost()) +
        (granularity_cost_weight * granularity_cost());
    return cost;
}

/**
 *
 * @param rigid := a linked list containing nodes which cannot be moved
 * @param flexible := a linked list containing all flexible nodes
 * @param granularity := the smallest schedulable delta
 *
 * Returns the approximately best Schedule.
 *
 */
std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const sec_t granularity,
    const double initial_temp,
    const double final_temp,
    const uint64_t num_iters
) {
    EngineConfig config;
    config.granularity = granularity;
    config.initial_temp = initial_temp;
    config.final_temp = final_temp;
    config.num_iters = num_iters;
    return schedule_jobs(std::move(jobs), config);
}

std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const EngineConfig& config
) {
    if (jobs.size() == 0) {
        return std::make_pair<Schedule, std::vector<double>>(Schedule(), {});
    };

    for (auto& job : jobs) {
        if (job.is_rigid()) {
            job.scheduled_time_range = job.schedulable_time_range;
            job.set_scheduled_time_ranges({job.scheduled_time_range});
        }
    }

    std::vector<std::vector<Job>> disjoint_jobs = get_disjoint_intervals(jobs);
    (void)disjoint_jobs;
    std::mt19937 gen(constants::RNG_SEED());

    Schedule initial_schedule = Schedule(jobs);

    ScheduleCostFunction initial_cost_function = ScheduleCostFunction(
        initial_schedule,
        config.granularity,
        config.illegal_schedule_weight,
        config.overlap_cost_weight,
        config.split_cost_weight,
        config.consistency_cost_weight,
        config.granularity_cost_weight
    );
    (void)initial_cost_function;

    SimulatedAnnealingOptimizer<Schedule> optimizer = SimulatedAnnealingOptimizer<Schedule>(
        [config](Schedule s) {
            ScheduleCostFunction cost_function = ScheduleCostFunction(
                s,
                config.granularity,
                config.illegal_schedule_weight,
                config.overlap_cost_weight,
                config.split_cost_weight,
                config.consistency_cost_weight,
                config.granularity_cost_weight
            );
            return cost_function.schedule_cost();
        },
        [config, &gen](Schedule s) {
            return generate_random_schedule_neighbor(
                s,
                config.granularity,
                gen);
        },
        config.initial_temp,
        config.final_temp,
        config.num_iters
    );

    Schedule best_schedule = optimizer.optimize(initial_schedule);
    std::vector<double> cost_history = optimizer.get_cost_history();

    return std::make_pair(best_schedule, cost_history);
}

Schedule schedule(
    std::vector<Job> jobs,
    const uint64_t granularity
) {
    EngineConfig config;
    config.granularity = granularity;
    return schedule(std::move(jobs), config);
}

Schedule schedule(
    std::vector<Job> jobs,
    const EngineConfig& config
) {
    auto s = schedule_jobs(std::move(jobs), config);
    return s.first;
}
