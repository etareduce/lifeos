#include <pybind11/pybind11.h>
#include <pybind11/stl.h>
#include <pybind11/operators.h>

namespace py = pybind11;

#include "tag.hpp"
#include "policy.hpp"
#include "job.hpp"
#include "engine.hpp"

PYBIND11_MODULE(engine, m) {
    // Tag
    py::class_<Tag>(m, "Tag")
        .def(py::init<const std::string&, const std::string&>(),
             py::arg("name"),
             py::arg("description") = "")
        .def_property("name", &Tag::get_name, &Tag::set_name)
        .def_property("description", &Tag::get_description, &Tag::set_description)
        .def(py::self == py::self)
        .def(py::self != py::self)
        .def(py::self < py::self)
        .def("get_name", &Tag::get_name)
        .def("set_name", &Tag::set_name)
        .def("get_description", &Tag::get_description)
        .def("set_description", &Tag::set_description)
        .def("__hash__", [](const Tag& tag) { 
            return std::hash<std::string>()(tag.get_name()); });

    // Policy
    py::class_<Policy>(m, "Policy")
        .def(py::init<>())
        .def(py::init<uint8_t, sec_t, bool, bool, bool, bool>(),
             py::arg("max_splits"),
             py::arg("min_split_duration"),
             py::arg("is_splittable") = false,
             py::arg("is_overlappable") = false,
             py::arg("is_invisible") = false,
             py::arg("round_to_granularity") = false)
        .def("get_max_splits", &Policy::get_max_splits)
        .def("get_min_split_duration", &Policy::get_min_split_duration)
        .def("get_round_to_granularity", &Policy::get_round_to_granularity)
        .def("get_scheduling_policies", &Policy::get_scheduling_policies)
        .def("is_splittable", &Policy::is_splittable)
        .def("is_overlappable", &Policy::is_overlappable)
        .def("is_invisible", &Policy::is_invisible);

    // TimeRange (Interval<sec_t>)
    py::class_<Interval<sec_t>>(m, "TimeRange")
        .def(py::init<sec_t>())
        .def(py::init<sec_t, sec_t>())
        .def("get_low", &Interval<sec_t>::get_low)
        .def("get_high", &Interval<sec_t>::get_high)
        .def("overlaps", &Interval<sec_t>::overlaps)
        .def("contains", &Interval<sec_t>::contains)
        .def("length", &Interval<sec_t>::length)
        .def(py::self == py::self)
        .def(py::self != py::self);

    // Job
    py::class_<Job>(m, "Job")
        .def(py::init<sec_t, Interval<sec_t>, Interval<sec_t>, std::string, Policy, std::set<std::string>, std::set<Tag>, std::string>(),
             py::arg("duration"),
             py::arg("schedulable_time_range"),
             py::arg("scheduled_time_range"),
             py::arg("id"),
             py::arg("policy"),
             py::arg("dependencies"),
             py::arg("tags"),
             py::arg("recurrence_id") = "")
        .def_readwrite("duration", &Job::duration)
        .def_readwrite("schedulable_time_range", &Job::schedulable_time_range)
        .def_readwrite("scheduled_time_range", &Job::scheduled_time_range)
        .def_readwrite("scheduled_time_ranges", &Job::scheduled_time_ranges)
        .def_readwrite("id", &Job::id)
        .def_readwrite("policy", &Job::policy)
        .def_readwrite("dependencies", &Job::dependencies)
        .def_readwrite("tags", &Job::tags)
        .def_readwrite("recurrence_id", &Job::recurrence_id)
        .def("is_rigid", &Job::is_rigid)
        .def("__str__", &Job::to_string);

    // Schedule
    py::class_<Schedule>(m, "Schedule")
        .def(py::init<std::vector<Job>>(),
             py::arg("scheduled_jobs") = std::vector<Job>{})
        .def_readwrite("scheduled_jobs", &Schedule::scheduled_jobs)
        .def("add_job", &Schedule::add_job)
        .def("clear", &Schedule::clear)
        .def("__len__", [](const Schedule& schedule) { return schedule.scheduled_jobs.size(); })
        .def("__iter__", [](const Schedule& schedule) {
            return py::make_iterator(schedule.scheduled_jobs.begin(), schedule.scheduled_jobs.end());
        }, py::keep_alive<0, 1>());

    // Cost Function
    py::class_<ScheduleCostFunction>(m, "ScheduleCostFunction")
        .def(py::init<const Schedule&, sec_t>())
        .def(py::init<const Schedule&, sec_t, double, double, double, double, double>(),
             py::arg("schedule"),
             py::arg("granularity"),
             py::arg("illegal_schedule_weight"),
             py::arg("overlap_cost_weight"),
             py::arg("split_cost_weight"),
             py::arg("consistency_cost_weight"),
             py::arg("granularity_cost_weight"))
        .def("consistency_cost", &ScheduleCostFunction::consistency_cost)
        .def("granularity_cost", &ScheduleCostFunction::granularity_cost)
        .def("schedule_cost", &ScheduleCostFunction::schedule_cost);

    py::class_<EngineConfig>(m, "EngineConfig")
        .def(py::init<>())
        .def_readwrite("granularity", &EngineConfig::granularity)
        .def_readwrite("initial_temp", &EngineConfig::initial_temp)
        .def_readwrite("final_temp", &EngineConfig::final_temp)
        .def_readwrite("num_iters", &EngineConfig::num_iters)
        .def_readwrite("num_workers", &EngineConfig::num_workers)
        .def_readwrite("illegal_schedule_weight", &EngineConfig::illegal_schedule_weight)
        .def_readwrite("overlap_cost_weight", &EngineConfig::overlap_cost_weight)
        .def_readwrite("split_cost_weight", &EngineConfig::split_cost_weight)
        .def_readwrite("consistency_cost_weight", &EngineConfig::consistency_cost_weight)
        .def_readwrite("granularity_cost_weight", &EngineConfig::granularity_cost_weight)
        .def_readwrite("log_engine_run", &EngineConfig::log_engine_run)
        .def_readwrite("output_file", &EngineConfig::output_file);

    m.def(
        "schedule",
        static_cast<Schedule (*)(std::vector<Job>, const uint64_t)>(&schedule),
        "Run the scheduler with default configurations",
        py::arg("jobs"),
        py::arg("granularity")
    );
    m.def(
        "schedule_with_config",
        [](std::vector<Job> jobs, const EngineConfig& config) {
            return schedule(std::move(jobs), config);
        },
        "Run the scheduler with EngineConfig",
        py::arg("jobs"),
        py::arg("config")
    );

    m.def(
        "schedule_jobs",
        static_cast<std::pair<Schedule, std::vector<double>> (*)(
            std::vector<Job>,
            const uint64_t,
            const double,
            const double,
            const uint64_t
        )>(&schedule_jobs),
        "Run the scheduler",
        py::arg("jobs"),
        py::arg("granularity"),
        py::arg("initial_temp"),
        py::arg("final_temp"),
        py::arg("num_iters")
    );
    m.def(
        "schedule_jobs_with_config",
        [](std::vector<Job> jobs, const EngineConfig& config) {
            return schedule_jobs(std::move(jobs), config);
        },
        "Run the scheduler with EngineConfig and return cost history",
        py::arg("jobs"),
        py::arg("config")
    );
} 
