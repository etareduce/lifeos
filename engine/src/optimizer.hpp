#ifndef SIMULATED_ANNEALING_OPTIMIZER_HPP
#define SIMULATED_ANNEALING_OPTIMIZER_HPP
#include "constants.hpp"
#include <functional>
#include <random>
#include <cmath>
#include <limits>

/**
 * @brief Generic simulated annealing optimizer.
 *
 * @tparam State Optimization state type.
 */
template<typename State>
class SimulatedAnnealingOptimizer {
public:
    /** @brief Returns cost value for a given state. */
    using CostFunction = std::function<double(const State&)>;
    /** @brief Produces a neighboring candidate state. */
    using NeighborFunction = std::function<State(const State&)>;
    /** @brief Computes temperature from initial temperature and iteration index. */
    using TemperatureSchedule = std::function<double(double, int)>;

    /**
     * @brief Construct optimizer with objective and annealing parameters.
     */
    SimulatedAnnealingOptimizer(
        CostFunction cost_fn,
        NeighborFunction neighbor_fn,
        double initial_temp,
        double final_temp,
        int max_iters,
        uint32_t rng_seed = constants::RNG_SEED(),
        TemperatureSchedule temp_schedule = default_schedule
    )
    : cost_fn(cost_fn),
      neighbor_fn(neighbor_fn),
      initial_temp(initial_temp),
      final_temp(final_temp),
      max_iters(max_iters),
      rng_seed(rng_seed),
      temp_schedule(temp_schedule)
    {}

    /**
     * @brief Run simulated annealing from an initial state.
     * @param initial_state Starting point for optimization.
     * @return Best state discovered during the run.
     */
    State optimize(const State& initial_state) {
        cost_history.clear();

        State curr_state = initial_state;
        State best_state = curr_state;

        double curr_cost = cost_fn(curr_state);
        double best_cost = curr_cost;

        cost_history.push_back(curr_cost);

        std::mt19937 gen(rng_seed);
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

    /** @brief Return sampled cost history captured during optimization. */
    std::vector<double> get_cost_history() const {
        return cost_history;
    }

private:
    CostFunction cost_fn;
    NeighborFunction neighbor_fn;
    double initial_temp;
    double final_temp;
    int max_iters;
    uint32_t rng_seed;
    TemperatureSchedule temp_schedule;
    std::vector<double> cost_history;

    /** @brief Default geometric cooling schedule with slower decay for deeper search. */
    static double default_schedule(double t0, int iter) {
        return t0 * std::pow(0.9992, iter);
    }
};

#endif
