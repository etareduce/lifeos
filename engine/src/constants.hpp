#ifndef ELASTISCHED_CONSTANTS_HPP
#define ELASTISCHED_CONSTANTS_HPP

#include <cstdint>
#include <cstdlib>

#include "types.hpp"

/**
 * @brief Engine-wide constants and seed helpers.
 */
namespace constants {
    /** @brief Number of seconds in one day. */
    constexpr sec_t DAY = (uint64_t)24 * (uint64_t)60 * (uint64_t)60;
    /** @brief Penalty multiplier used by split-related cost terms. */
    constexpr double SPLIT_COST_FACTOR = 10.0f;
    /** @brief Hard penalty for invalid schedule placements. */
    constexpr double ILLEGAL_SCHEDULE_COST = 1e12f;
    /** @brief Floating-point tolerance for cost comparisons. */
    constexpr double EPSILON = 1e-5f;
    /** @brief Default random seed for deterministic simulated annealing runs. */
    constexpr uint32_t DEFAULT_RNG_SEED = 1337;

    /**
     * @brief Resolve RNG seed from environment.
     *
     * Reads `ELASTISCHED_RNG_SEED`, returning @ref DEFAULT_RNG_SEED when
     * unset or invalid.
     */
    inline uint32_t RNG_SEED() {
        const char* value = std::getenv("ELASTISCHED_RNG_SEED");
        if (!value || !*value) {
            return DEFAULT_RNG_SEED;
        }
        char* end = nullptr;
        unsigned long parsed = std::strtoul(value, &end, 10);
        if (end == value || *end != '\0') {
            return DEFAULT_RNG_SEED;
        }
        return static_cast<uint32_t>(parsed);
    }
}

#endif // ELASTISCHED_CONSTANTS_HPP
