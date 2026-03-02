#ifndef ELASTISCHED_POLICY_HPP
#define ELASTISCHED_POLICY_HPP

#include <cstdint>

#include "types.hpp"

/**
 * Policy
 * 
 * Policy defines how jobs can be scheduled.
 * 
 * scheduling_policies is an overloaded integer
 * where the least significant bits represent:
 *      -> is_splittable (bit 0)
 *      -> is_overlappable (bit 1)
 *      -> is_invisible (bit 2)
 *      -> round_to_granularity (bit 3)
 */
class Policy {
private:
    uint8_t max_splits;
    sec_t min_split_duration;
    uint8_t scheduling_policies;  // Bitfield: bit 0 = is_splittable, bit 1 = is_overlappable, bit 2 = is_invisible, bit 3 = round_to_granularity

public:
    Policy(uint8_t max_splits = 0,
           sec_t min_split_duration = 0,
           bool is_splittable = false,
           bool is_overlappable = false,
           bool is_invisible = false,
           bool round_to_granularity = false);

    uint8_t get_max_splits() const;
    sec_t get_min_split_duration() const;
    bool get_round_to_granularity() const;
    uint8_t get_scheduling_policies() const;

    bool is_splittable() const;
    bool is_overlappable() const;
    bool is_invisible() const;
};

#endif // ELASTISCHED_POLICY_HPP
