#ifndef ELASTISCHED_JOB_HPP
#define ELASTISCHED_JOB_HPP

#include "policy.hpp"
#include "tag.hpp"
#include "types.hpp"

#include <vector>
#include <set>

class Job {
public:
    sec_t duration;
    TimeRange schedulable_time_range;
    TimeRange scheduled_time_range;
    std::vector<TimeRange> scheduled_time_ranges;
    ID id;
    Policy policy;
    std::set<ID> dependencies;
    std::set<Tag> tags;
    ID recurrence_id;

    Job(sec_t duration,
        TimeRange schedulable_time_range,
        TimeRange scheduled_time_range,
        ID id,
        Policy policy,
        std::set<ID> dependencies,
        std::set<Tag> tags,
        ID recurrence_id = "");

    bool is_rigid() const;
    const std::vector<TimeRange>& get_scheduled_time_ranges() const;
    void set_scheduled_time_ranges(std::vector<TimeRange> ranges);
    std::string to_string() const;
};

#endif // ELASTISCHED_JOB_HPP
