#ifndef SIMULATED_ANNEALING_OPTIMIZER_HPP
#define SIMULATED_ANNEALING_OPTIMIZER_HPP
#include "constants.hpp"
#include <functional>
#include <random>
#include <cmath>
#include <limits>

template<typename State>
class SimulatedAnnealingOptimizer {
public:
    using CostFunction = std::function<double(const State&)>;
    using NeighborFunction = std::function<State(const State&)>;
    using TemperatureSchedule = std::function<double(double, int)>;

    SimulatedAnnealingOptimizer(
        CostFunction cost_fn,
        NeighborFunction neighbor_fn,
        double initial_temp,
        double final_temp,
        int max_iters,
        TemperatureSchedule temp_schedule = default_schedule
    )
    : cost_fn(cost_fn),
      neighbor_fn(neighbor_fn),
      initial_temp(initial_temp),
      final_temp(final_temp),
      max_iters(max_iters),
      temp_schedule(temp_schedule)
    {}

    State optimize(const State& initial_state) {
        State curr_state = initial_state;
        State best_state = curr_state;

        double curr_cost = cost_fn(curr_state);
        double best_cost = curr_cost;

        cost_history.push_back(curr_cost);

        std::mt19937 gen(constants::RNG_SEED());
        std::uniform_real_distribution<> dis(0.0, 1.0);

        for (int iter = 0; iter < max_iters; ++iter) {
            double temp = temp_schedule(initial_temp, iter);

            if (temp < final_temp)
                break;

            State next_state = neighbor_fn(curr_state);
            double next_cost = cost_fn(next_state);
            double delta = next_cost - curr_cost;

            cost_history.push_back(next_cost);

            if (delta < 0 || dis(gen) < std::exp(-delta / temp)) {
                curr_state = next_state;
                curr_cost = next_cost;

                if ((curr_cost < best_cost) && abs(best_cost - curr_cost) > constants::EPSILON) {
                    best_cost = curr_cost;
                    best_state = curr_state;
                }
            }
        }

        return best_state;
    }

    std::vector<double> get_cost_history() const {
        return cost_history;
    }

private:
    CostFunction cost_fn;
    NeighborFunction neighbor_fn;
    double initial_temp;
    double final_temp;
    int max_iters;
    TemperatureSchedule temp_schedule;
    std::vector<double> cost_history;

    static double default_schedule(double t0, int iter) {
        return t0 * std::pow(0.95, iter); // geometric cooling
    }
};

#endif
