#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include "doctest.h"

#include "interval.hpp"
#include "interval_tree.hpp"
#include "job.hpp"
#include "policy.hpp"
#include "tag.hpp"
#include "constants.hpp"
#include "engine.hpp"

#include <cstdlib>
#include <string>

TEST_CASE("Interval basics") {
    Interval<int> a(1, 5);
    Interval<int> b(3, 7);
    Interval<int> c(5, 5); // zero length

    CHECK_EQ(a.get_low(), 1);
    CHECK_EQ(a.get_high(), 5);
    CHECK(a.overlaps(b));
    CHECK_EQ(a.overlap_length(b), 2);

    CHECK(a.contains(Interval<int>(2, 4)));
    CHECK(!a.contains(Interval<int>(0, 4)));

    // Zero-length overlaps: [5,5) overlaps with [1,5) should be false by implementation
    CHECK(!c.overlaps(a));
    CHECK(!a.overlaps(c));

    CHECK_THROWS_AS(Interval<int>(5, 3), std::invalid_argument);
}

TEST_CASE("Interval edge overlaps and lengths") {
    Interval<int> a(0, 10);
    Interval<int> b(10, 20);
    Interval<int> c(5, 10);
    Interval<int> d(0, 0);
    Interval<int> e(0, 1);

    CHECK(!a.overlaps(b)); // touching at endpoint is not overlap
    CHECK(c.overlaps(a));
    CHECK_EQ(a.overlap_length(c), 5);
    CHECK_EQ(a.overlap_length(b), 0);
    CHECK_EQ(d.length(), 0);
    CHECK(d.overlaps(e)); // zero-length inside [0,1)
}

TEST_CASE("IntervalTree insert and search") {
    IntervalTree<int, std::string> tree;
    tree.insert(0, 5, "A");
    tree.insert(10, 15, "B");
    tree.insert(3, 8, "C");

    auto* overlap = tree.search_overlap(4, 6);
    REQUIRE(overlap != nullptr);
    CHECK(overlap->overlaps(Interval<int>(4, 6)));

    auto* value = tree.search_value(11, 12);
    REQUIRE(value != nullptr);
    CHECK_EQ(*value, "B");

    auto overlaps = tree.find_overlapping(Interval<int>(2, 4));
    CHECK(overlaps.size() >= 1);
}

TEST_CASE("IntervalTree copy and is_in") {
    IntervalTree<int, int> tree;
    tree.insert(1, 3, 10);
    tree.insert(5, 8, 20);

    IntervalTree<int, int> copy = tree;
    CHECK(copy.is_in(Interval<int>(1, 2)));
    CHECK(!copy.is_in(Interval<int>(3, 5)));

    auto* missing = copy.search_value(100, 200);
    CHECK(missing == nullptr);
}

TEST_CASE("Policy flags and accessors") {
    Policy policy(3, 10, true, true, true, true);
    CHECK(policy.is_splittable());
    CHECK(policy.is_overlappable());
    CHECK(policy.is_invisible());
    CHECK(policy.get_round_to_granularity());
    CHECK_EQ(policy.get_max_splits(), 3);
    CHECK_EQ(policy.get_min_split_duration(), static_cast<sec_t>(10));
}

TEST_CASE("Policy default and selective flags") {
    Policy policy;
    CHECK(!policy.is_splittable());
    CHECK(!policy.is_overlappable());
    CHECK(!policy.is_invisible());
    CHECK(!policy.get_round_to_granularity());
    CHECK_EQ(policy.get_max_splits(), 0);
    CHECK_EQ(policy.get_min_split_duration(), static_cast<sec_t>(0));

    Policy round_only(0, 0, false, false, false, true);
    CHECK(!round_only.is_splittable());
    CHECK(round_only.get_round_to_granularity());
}

TEST_CASE("Tag equality and ordering") {
    Tag a("work", "desc1");
    Tag b("work", "desc2");
    Tag c("rest", "desc3");

    CHECK(a == b);
    CHECK(a != c);
    CHECK(c < a); // lexicographic by name
}

TEST_CASE("Tag setters") {
    Tag tag("name", "desc");
    tag.set_name("new");
    tag.set_description("newdesc");
    CHECK_EQ(tag.get_name(), std::string("new"));
    CHECK_EQ(tag.get_description(), std::string("newdesc"));
}

TEST_CASE("Job rigidity and scheduled ranges") {
    Policy policy;
    TimeRange schedulable(0, 10);
    TimeRange scheduled(2, 5);
    Job job(10, schedulable, scheduled, "job1", policy, {}, {});

    CHECK(!job.is_rigid());

    std::vector<TimeRange> ranges = {TimeRange(1, 3), TimeRange(6, 8)};
    job.set_scheduled_time_ranges(ranges);
    CHECK_EQ(job.get_scheduled_time_ranges().size(), static_cast<size_t>(2));
    CHECK_EQ(job.scheduled_time_range.get_low(), static_cast<sec_t>(1));
    CHECK_EQ(job.scheduled_time_range.get_high(), static_cast<sec_t>(3));
}

TEST_CASE("Job rigid and empty scheduled ranges") {
    Policy policy;
    TimeRange schedulable(0, 10);
    TimeRange scheduled(0, 10);
    Job job(10, schedulable, scheduled, "rigid", policy, {}, {});
    CHECK(job.is_rigid());

    job.set_scheduled_time_ranges({});
    CHECK_EQ(job.get_scheduled_time_ranges().size(), static_cast<size_t>(0));
    CHECK_EQ(job.scheduled_time_range.get_low(), static_cast<sec_t>(0));
    CHECK_EQ(job.scheduled_time_range.get_high(), static_cast<sec_t>(10));
}

TEST_CASE("Job to_string includes fields") {
    Policy policy(1, 2, true, false, false, false);
    TimeRange schedulable(0, 10);
    TimeRange scheduled(0, 2);
    std::set<ID> deps = {"a", "b"};
    std::set<Tag> tags = {Tag("t1"), Tag("t2")};
    Job job(2, schedulable, scheduled, "jobX", policy, deps, tags);

    std::string text = job.to_string();
    CHECK(text.find("jobX") != std::string::npos);
    CHECK(text.find("Duration") != std::string::npos);
    CHECK(text.find("Splittable") != std::string::npos);
    CHECK(text.find("Dependencies") != std::string::npos);
    CHECK(text.find("Tags") != std::string::npos);
}

TEST_CASE("Schedule add and clear") {
    Schedule schedule;
    Policy policy;
    TimeRange schedulable(0, 10);
    TimeRange scheduled(0, 2);
    Job job(2, schedulable, scheduled, "job1", policy, {}, {});

    schedule.add_job(job);
    CHECK_EQ(schedule.scheduled_jobs.size(), static_cast<size_t>(1));
    schedule.clear();
    CHECK_EQ(schedule.scheduled_jobs.size(), static_cast<size_t>(0));
}

TEST_CASE("Dependency check empty schedule") {
    Schedule schedule;
    auto result = check_dependency_violations(schedule);
    CHECK(!result.has_violations);
    CHECK(!result.has_cyclic_dependencies);
    CHECK_EQ(result.violations.size(), static_cast<size_t>(0));
}

TEST_CASE("Dependency violation detection") {
    Policy policy;
    TimeRange schedulable(0, 100);

    Job a(10, schedulable, TimeRange(50, 60), "A", policy, {}, {});
    Job b(10, schedulable, TimeRange(10, 20), "B", policy, {"A"}, {});

    Schedule schedule({a, b});
    auto result = check_dependency_violations(schedule);
    CHECK(result.has_violations);
    CHECK(!result.has_cyclic_dependencies);
    CHECK_EQ(result.violations.size(), static_cast<size_t>(1));
}

TEST_CASE("Dependency on missing job is ignored") {
    Policy policy;
    TimeRange schedulable(0, 100);
    Job a(10, schedulable, TimeRange(10, 20), "A", policy, {"MISSING"}, {});
    Schedule schedule({a});
    auto result = check_dependency_violations(schedule);
    CHECK(!result.has_violations);
    CHECK(!result.has_cyclic_dependencies);
}

TEST_CASE("Dependency cycle detection") {
    Policy policy;
    TimeRange schedulable(0, 100);

    Job a(10, schedulable, TimeRange(10, 20), "A", policy, {"B"}, {});
    Job b(10, schedulable, TimeRange(30, 40), "B", policy, {"A"}, {});

    Schedule schedule({a, b});
    auto result = check_dependency_violations(schedule);
    CHECK(result.has_cyclic_dependencies);
    CHECK(result.has_violations);
}

TEST_CASE("ScheduleCostFunction illegal schedule out of bounds") {
    Policy policy;
    TimeRange schedulable(0, 10);
    Job a(5, schedulable, TimeRange(8, 13), "A", policy, {}, {});
    Schedule schedule({a});
    ScheduleCostFunction cost(schedule, 1);
    CHECK_EQ(cost.illegal_schedule_cost(), constants::ILLEGAL_SCHEDULE_COST);
}

TEST_CASE("ScheduleCostFunction illegal schedule detection") {
    Policy non_overlappable(0, 0, false, false, false, false);
    TimeRange schedulable(0, 100);

    Job a(10, schedulable, TimeRange(10, 20), "A", non_overlappable, {}, {});
    Job b(10, schedulable, TimeRange(15, 25), "B", non_overlappable, {}, {});

    Schedule schedule({a, b});
    ScheduleCostFunction cost(schedule, 1);
    CHECK_EQ(cost.illegal_schedule_cost(), constants::ILLEGAL_SCHEDULE_COST);
}

TEST_CASE("ScheduleCostFunction overlap illegal if either job is non-overlappable") {
    Policy non_overlappable(0, 0, false, false, false, false);
    Policy overlappable(0, 0, false, true, false, false);
    TimeRange schedulable(0, 100);

    Job a(10, schedulable, TimeRange(10, 20), "A", non_overlappable, {}, {});
    Job b(10, schedulable, TimeRange(15, 25), "B", overlappable, {}, {});

    Schedule schedule({a, b});
    ScheduleCostFunction cost(schedule, 1);
    CHECK_EQ(cost.illegal_schedule_cost(), constants::ILLEGAL_SCHEDULE_COST);
}

TEST_CASE("ScheduleCostFunction dependency violation cost") {
    Policy policy;
    TimeRange schedulable(0, 100);
    Job a(10, schedulable, TimeRange(50, 60), "A", policy, {}, {});
    Job b(10, schedulable, TimeRange(10, 20), "B", policy, {"A"}, {});
    Schedule schedule({a, b});
    ScheduleCostFunction cost(schedule, 1);
    CHECK_EQ(cost.illegal_schedule_cost(), constants::ILLEGAL_SCHEDULE_COST);
}

TEST_CASE("ScheduleCostFunction overlap cost and split cost") {
    Policy overlappable(0, 0, false, true, false, false);
    TimeRange schedulable(0, 100);

    Job a(10, schedulable, TimeRange(10, 20), "A", overlappable, {}, {});
    Job b(10, schedulable, TimeRange(15, 25), "B", overlappable, {}, {});
    b.set_scheduled_time_ranges({TimeRange(15, 18), TimeRange(20, 27)});

    Schedule schedule({a, b});
    ScheduleCostFunction cost(schedule, 1);

    CHECK(cost.illegal_schedule_cost() == 0.0);
    CHECK(cost.overlap_cost() > 0.0);
    CHECK_EQ(cost.split_cost(), constants::SPLIT_COST_FACTOR);
    CHECK(cost.schedule_cost() > 0.0);
}

TEST_CASE("ScheduleCostFunction overlap cost honors granularity") {
    Policy overlappable(0, 0, false, true, false, false);
    TimeRange schedulable(0, 100);
    Job a(10, schedulable, TimeRange(10, 20), "A", overlappable, {}, {});
    Job b(10, schedulable, TimeRange(15, 25), "B", overlappable, {}, {});
    Schedule schedule({a, b});
    ScheduleCostFunction cost(schedule, 5);
    CHECK(cost.overlap_cost() > 0.0);
}

TEST_CASE("ScheduleCostFunction split cost zero for unsplit jobs") {
    Policy policy;
    TimeRange schedulable(0, 100);
    Job a(10, schedulable, TimeRange(10, 20), "A", policy, {}, {});
    Schedule schedule({a});
    ScheduleCostFunction cost(schedule, 1);
    CHECK_EQ(cost.split_cost(), 0.0);
}

TEST_CASE("RNG seed parsing fallback") {
    unsetenv("ELASTISCHED_RNG_SEED");
    CHECK_EQ(constants::RNG_SEED(), constants::DEFAULT_RNG_SEED);

    setenv("ELASTISCHED_RNG_SEED", "not_a_number", 1);
    CHECK_EQ(constants::RNG_SEED(), constants::DEFAULT_RNG_SEED);

    setenv("ELASTISCHED_RNG_SEED", "12345", 1);
    CHECK_EQ(constants::RNG_SEED(), static_cast<uint32_t>(12345));
}

TEST_CASE("schedule_jobs empty input") {
    auto result = schedule_jobs({}, 1, 1.0, 0.1, 10);
    CHECK_EQ(result.first.scheduled_jobs.size(), static_cast<size_t>(0));
    CHECK_EQ(result.second.size(), static_cast<size_t>(0));
}
