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

class Schedule {
public:
    std::vector<Job> scheduled_jobs;

    Schedule() = default;
    Schedule(std::vector<Job> scheduled_jobs);
    void add_job(const Job& job);
    void clear();

private:
    friend std::ostream& operator<<(std::ostream& os, const Schedule& schedule);
};

std::ostream& operator<<(std::ostream& os, const Schedule& schedule);

struct DependencyViolation {
    ID job_id;
    std::set<ID> violated_dependencies; // Dependencies that haven't been scheduled before this job

    DependencyViolation(ID job_id, const std::set<ID>& violated_dependencies);
};

struct DependencyCheckResult {
    bool has_violations;
    std::vector<DependencyViolation> violations;
    bool has_cyclic_dependencies;

    DependencyCheckResult();
};

DependencyCheckResult check_dependency_violations(const Schedule& schedule);

class ScheduleCostFunction {
private:
    const Schedule& schedule_ref;
    const sec_t granularity;
    const double illegal_schedule_weight;
    const double overlap_cost_weight;
    const double split_cost_weight;
    const std::set<Tag> rest_tags{};
    IntervalTree<sec_t, std::optional<std::vector<Job>>> day_based_schedule;
    std::optional<sec_t> min_time = std::nullopt;
    std::optional<sec_t> max_time = std::nullopt;

public:
    double context_switch_cost() const;
    double illegal_schedule_cost() const;
    double overlap_cost() const;
    double split_cost() const;
    double schedule_cost() const;

    ScheduleCostFunction(
        const Schedule& schedule,
        sec_t granularity,
        double illegal_schedule_weight = 1.0,
        double overlap_cost_weight = 1.0,
        double split_cost_weight = 1.0);
};

struct EngineConfig {
    uint64_t granularity = 300;
    double initial_temp = 10.0;
    double final_temp = 1e-4;
    uint64_t num_iters = 1000000;
    uint64_t num_workers = 1;
    double illegal_schedule_weight = 1.0;
    double overlap_cost_weight = 1.0;
    double split_cost_weight = 1.0;
    bool log_engine_run = false;
    std::string output_file = "";
};

Schedule schedule(std::vector<Job> jobs, const uint64_t granularity);
Schedule schedule(std::vector<Job> jobs, const EngineConfig& config);
std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const uint64_t granularity,
    const double initial_temp,
    const double final_temp,
    const uint64_t num_iters);
std::pair<Schedule, std::vector<double>> schedule_jobs(
    std::vector<Job> jobs,
    const EngineConfig& config);

#endif // ELASTISCHED_ENGINE_HPP
