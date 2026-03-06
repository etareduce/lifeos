#ifndef ELASTISCHED_TYPES_HPP
#define ELASTISCHED_TYPES_HPP

#include "interval.hpp"
#include <cstdint>

#ifndef ELASTISCHED_SEC_T_BITS
#define ELASTISCHED_SEC_T_BITS 64
#endif

/**
 * @brief Integral type used for second-based timestamps and durations.
 *
 * The width can be configured at compile time through `ELASTISCHED_SEC_T_BITS`.
 */
#if ELASTISCHED_SEC_T_BITS == 8
using sec_t = uint8_t;
#elif ELASTISCHED_SEC_T_BITS == 16
using sec_t = uint16_t;
#elif ELASTISCHED_SEC_T_BITS == 32
using sec_t = uint32_t;
#elif ELASTISCHED_SEC_T_BITS == 64
using sec_t = uint64_t;
#else
#error "ELASTISCHED_SEC_T_BITS must be 8, 16, 32, or 64"
#endif

/** @brief Inclusive-start, exclusive-end time interval represented in seconds. */
using TimeRange = Interval<sec_t>;
/** @brief Identifier type for jobs, recurrences, and dependencies. */
using ID = std::string;

#endif
