#ifndef ELASTISCHED_POLICY_HPP
#define ELASTISCHED_POLICY_HPP

#include <cstdint>

#include "types.hpp"

/**
 * @brief Scheduling constraints and behavior flags for a job.
 *
 * The `scheduling_policies` bitfield uses:
 * - bit 0: splittable
 * - bit 1: overlappable
 * - bit 2: invisible
 * - bit 3: round-to-granularity
 */
class Policy {
private:
    uint8_t max_splits;
    sec_t min_split_duration;
    uint8_t scheduling_policies;  // Bitfield: bit 0 = is_splittable, bit 1 = is_overlappable, bit 2 = is_invisible, bit 3 = round_to_granularity

public:
    /**
     * @brief Construct policy flags and split constraints.
     */
    Policy(uint8_t max_splits = 0,
           sec_t min_split_duration = 0,
           bool is_splittable = false,
           bool is_overlappable = false,
           bool is_invisible = false,
           bool round_to_granularity = false);

    /** @brief Maximum number of pieces allowed when splitting. */
    uint8_t get_max_splits() const;
    /** @brief Minimum duration of each split segment. */
    sec_t get_min_split_duration() const;
    /** @brief Whether placement should snap to granularity boundaries. */
    bool get_round_to_granularity() const;
    /** @brief Raw policy bitmask representation. */
    uint8_t get_scheduling_policies() const;

    /** @brief Whether the job may be split into multiple segments. */
    bool is_splittable() const;
    /** @brief Whether the job may overlap with other jobs. */
    bool is_overlappable() const;
    /** @brief Whether the job is hidden from some UI/cost flows. */
    bool is_invisible() const;
};

#endif // ELASTISCHED_POLICY_HPP
