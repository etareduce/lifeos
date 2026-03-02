#ifndef ELASTISCHED_TYPES_HPP
#define ELASTISCHED_TYPES_HPP

#include "interval.hpp"
#include <cstdint>

#ifndef ELASTISCHED_SEC_T_BITS
#define ELASTISCHED_SEC_T_BITS 64
#endif

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

using TimeRange = Interval<sec_t>;
using ID = std::string;

#endif
