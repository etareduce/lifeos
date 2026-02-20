#include "job.hpp"

Job::Job(sec_t duration, TimeRange schedulable_time_range, TimeRange scheduled_time_range,
        ID id, Policy policy, std::set<ID> dependencies, std::set<Tag> tags, ID recurrence_id)
:   duration(duration),
    schedulable_time_range(schedulable_time_range),
    scheduled_time_range(scheduled_time_range),
    scheduled_time_ranges({scheduled_time_range}),
    id(id),
    policy(policy),
    dependencies(dependencies),
    tags(tags),
    recurrence_id(recurrence_id)
{
        return;
};

bool Job::is_rigid() const {
    return duration == schedulable_time_range.length();
};

const std::vector<TimeRange>& Job::get_scheduled_time_ranges() const {
    return scheduled_time_ranges;
}

void Job::set_scheduled_time_ranges(std::vector<TimeRange> ranges) {
    scheduled_time_ranges = std::move(ranges);
    if (!scheduled_time_ranges.empty()) {
        scheduled_time_range = scheduled_time_ranges.front();
    }
}

std::string Job::to_string() const {
    std::ostringstream oss;
    
    oss << "Job(id=" << id << ", recurrence_id=" << recurrence_id << ")\n";
    oss << "├─ Duration: " << duration << " seconds\n";
    
    // Format schedulable time range
    oss << "├─ Schedulable: [" << schedulable_time_range.get_low() 
        << " - " << schedulable_time_range.get_high() << "]";
    if (schedulable_time_range.length() > 0) {
        oss << " (length: " << schedulable_time_range.length() << "s)";
    }
    oss << "\n";
    
    // Format scheduled time range
    oss << "├─ Scheduled: ";
    if (!scheduled_time_ranges.empty() || scheduled_time_range.length() > 0) {
        const auto& primary = scheduled_time_ranges.empty() ? scheduled_time_range : scheduled_time_ranges.front();
        oss << "[" << primary.get_low() 
            << " - " << primary.get_high() << "]";
        oss << " (length: " << primary.length() << "s)";
        if (scheduled_time_ranges.size() > 1) {
            oss << " (split segments: " << scheduled_time_ranges.size() << ")";
        }
    } else {
        oss << "Not scheduled";
    }
    oss << "\n";
    
    // Policy information
    oss << "├─ Policy: ";
    if (policy.is_splittable()) {
        oss << "Splittable (max: " << static_cast<int>(policy.get_max_splits()) 
            << ", min duration: " << policy.get_min_split_duration() << "s)";
    } else {
        oss << "Non-splittable";
    }
    if (policy.is_overlappable()) {
        oss << ", Overlappable";
    }
    oss << "\n";
    
    // Dependencies
    oss << "├─ Dependencies: ";
    if (dependencies.empty()) {
        oss << "None";
    } else {
        oss << "[";
        bool first = true;
        for (const auto& dep : dependencies) {
            if (!first) oss << ", ";
            oss << dep;
            first = false;
        }
        oss << "]";
    }
    oss << "\n";
    
    // Tags
    oss << "└─ Tags: ";
    if (tags.empty()) {
        oss << "None";
    } else {
        oss << "[";
        bool first = true;
        for (const auto& tag : tags) {
            if (!first) oss << ", ";
            oss << tag.get_name();
            first = false;
        }
        oss << "]";
    }
    
    return oss.str();
}
