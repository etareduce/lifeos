#ifndef ELASTISCHED_JOB_HPP
#define ELASTISCHED_JOB_HPP

#include "policy.hpp"
#include "tag.hpp"
#include "types.hpp"

#include <vector>
#include <set>

/**
 * @brief Schedulable unit of work with constraints and metadata.
 */
class Job {
public:
    /** @brief Total required execution duration in seconds. */
    sec_t duration;
    /** @brief Allowed placement window. */
    TimeRange schedulable_time_range;
    /** @brief Primary scheduled placement window. */
    TimeRange scheduled_time_range;
    /** @brief Concrete scheduled pieces (for split jobs). */
    std::vector<TimeRange> scheduled_time_ranges;
    /** @brief Unique job identifier. */
    ID id;
    /** @brief Scheduling policy flags and split limits. */
    Policy policy;
    /** @brief IDs of jobs that must be scheduled first. */
    std::set<ID> dependencies;
    /** @brief Classification tags associated with this job. */
    std::set<Tag> tags;
    /** @brief Recurrence identifier grouping related occurrences. */
    ID recurrence_id;

    /**
     * @brief Construct a job from core scheduling attributes.
     */
    Job(sec_t duration,
        TimeRange schedulable_time_range,
        TimeRange scheduled_time_range,
        ID id,
        Policy policy,
        std::set<ID> dependencies,
        std::set<Tag> tags,
        ID recurrence_id = "");

    /** @brief Whether this job has a fixed duration and window. */
    bool is_rigid() const;
    /** @brief Access all scheduled segments for this job. */
    const std::vector<TimeRange>& get_scheduled_time_ranges() const;
    /** @brief Replace all scheduled segments for this job. */
    void set_scheduled_time_ranges(std::vector<TimeRange> ranges);
    /** @brief Serialize job state into a human-readable string. */
    std::string to_string() const;
};

#endif // ELASTISCHED_JOB_HPP
