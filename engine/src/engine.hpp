#ifndef ELASTISCHED_ENGINE_HPP
#define ELASTISCHED_ENGINE_HPP

#include "types.hpp"
#include "job.hpp"
#include "interval_tree.hpp"

#include <optional>
#include <set>
#include <utility>
#include <vector>
#include <ostream>

/**
 * @brief Mutable collection of scheduled jobs.
 */
class Schedule {
public:
    /** @brief Jobs currently placed into the schedule. */
    std::vector<Job> scheduled_jobs;

    /** @brief Construct an empty schedule. */
    Schedule() = default;
    /** @brief Construct a schedule from an existing job vector. */
    Schedule(std::vector<Job> scheduled_jobs);
    /** @brief Append a job to the schedule. */
    void add_job(const Job& job);
    /** @brief Remove all jobs from the schedule. */
    void clear();

private:
    friend std::ostream& operator<<(std::ostream& os, const Schedule& schedule);
};

/** @brief Stream serialization helper for Schedule. */
std::ostream& operator<<(std::ostream& os, const Schedule& schedule);

/**
 * @brief Dependency violations for a job placement.
 */
struct DependencyViolation {
    /** @brief Job that violates dependency constraints. */
    ID job_id;
    /** @brief Dependencies that were not scheduled before this job. */
    std::set<ID> violated_dependencies;

    /** @brief Construct a dependency violation record. */
    DependencyViolation(ID job_id, const std::set<ID>& violated_dependencies);
};

/**
 * @brief Result of dependency validation for a schedule.
 */
struct DependencyCheckResult {
    /** @brief True when one or more dependency ordering violations exist. */
    bool has_violations;
    /** @brief Detailed violation records by job. */
    std::vector<DependencyViolation> violations;
    /** @brief True when a cyclic dependency graph is detected. */
    bool has_cyclic_dependencies;

    DependencyCheckResult();
};

/**
 * @brief Validate dependency ordering and cycle constraints.
 * @param schedule Schedule to validate.
 * @return Structured dependency check result.
 */
DependencyCheckResult check_dependency_violations(const Schedule& schedule);

/**
 * @brief Weighted cost model used by the optimizer.
 */
class ScheduleCostFunction {
private:
    const Schedule& schedule_ref;
    const sec_t granularity;
    const double illegal_schedule_weight;
    const double overlap_cost_weight;
    const double split_cost_weight;
    const double consistency_cost_weight;
    const double granularity_cost_weight;
    const std::set<Tag> rest_tags{};
    IntervalTree<sec_t, std::optional<std::vector<Job>>> day_based_schedule;
    std::optional<sec_t> min_time = std::nullopt;
    std::optional<sec_t> max_time = std::nullopt;

public:
    /** @brief Cost for context switches between dissimilar jobs. */
    double context_switch_cost() const;
    /** @brief Cost for violating hard/soft schedule constraints. */
    double illegal_schedule_cost() const;
    /** @brief Cost from overlapping jobs. */
    double overlap_cost() const;
    /** @brief Cost from fragmented split placements. */
    double split_cost() const;
    /** @brief Cost for inconsistent recurring placement patterns. */
    double consistency_cost() const;
    /** @brief Cost for violating configured granularity. */
    double granularity_cost() const;
    /** @brief Weighted aggregate schedule cost. */
    double schedule_cost() const;

    /**
     * @brief Construct cost function with per-component weights.
     */
    ScheduleCostFunction(
        const Schedule& schedule,
        sec_t granularity,
        double illegal_schedule_weight = 1.0,
        double overlap_cost_weight = 1.0,
        double split_cost_weight = 1.0,
        double consistency_cost_weight = 1.0,
        double granularity_cost_weight = 1.0);
};

/**
 * @brief End-to-end engine configuration.
 */
struct EngineConfig {
    /** @brief Schedule grid granularity in seconds. */
    uint64_t granularity = 300;
    /** @brief Initial annealing temperature. */
    double initial_temp = 10.0;
    /** @brief Final annealing temperature threshold. */
    double final_temp = 1e-4;
    /** @brief Maximum simulated annealing iterations. */
    uint64_t num_iters = 1000000;
    /** @brief Worker count for parallel scheduling runs. */
    uint64_t num_workers = 1;
    /** @brief Weight for illegal schedule penalties. */
    double illegal_schedule_weight = 1.0;
    /** @brief Weight for overlap penalties. */
    double overlap_cost_weight = 1.0;
    /** @brief Weight for split penalties. */
    double split_cost_weight = 1.0;
    /** @brief Weight for consistency penalties. */
    double consistency_cost_weight = 1.0;
    /** @brief Weight for granularity penalties. */
    double granularity_cost_weight = 1.0;
    /** @brief Whether to write engine run diagnostics. */
    bool log_engine_run = false;
    /** @brief Output file path used when logging is enabled. */
    std::string output_file = "";
};

/**
 * @brief Generate a schedule using a granularity-only configuration.
 */
Schedule schedule(std::vector<Job> jobs, const uint64_t granularity);
/**
 * @brief Generate a schedule using full engine configuration.
 */
Schedule schedule(std::vector<Job> jobs, const EngineConfig& config);

/**
 * @brief Optimize jobs and return schedule plus cost trace.
 */
std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const uint64_t granularity,
    const double initial_temp,
    const double final_temp,
    const uint64_t num_iters);

/**
 * @brief Optimize jobs and return schedule plus cost trace using full config.
 */
std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const EngineConfig& config);

#endif // ELASTISCHED_ENGINE_HPP
