#ifndef ELASTISCHED_INTERVAL_HPP
#define ELASTISCHED_INTERVAL_HPP

#include <algorithm>
#include <iostream>
#include <stdexcept>

/**
 * @brief Half-open interval abstraction `[low, high)`.
 *
 * @tparam T Comparable scalar value type.
 */
template<typename T>
class Interval {
private:
    T low;
    T high;

    friend std::ostream& operator<<(std::ostream& os, const Interval<T>& interval) {
        os << "Low: " << interval.get_low() << " High: " << interval.get_high();
        return os;
    }

public:
    /**
     * @brief Construct a zero-length interval at a single point.
     * @param e Point value used for both bounds.
     */
    Interval(T e) : low(e), high(e) {}

    /**
     * @brief Construct an interval from lower and upper bounds.
     * @param low Lower bound (inclusive).
     * @param high Upper bound (exclusive).
     * @throws std::invalid_argument if `high < low`.
     */
    Interval(T low, T high) : low(low), high(high) {
        if (high < low) {
            throw std::invalid_argument("Interval: high must be >= low");
        }
    }

    /** @brief Get the lower bound. */
    T get_low() const { return low; }
    /** @brief Get the upper bound. */
    T get_high() const { return high; }

    /** @brief Equality by bounds. */
    bool operator==(const Interval& other) const {
        return low == other.get_low() && high == other.get_high();
    }

    /** @brief Inequality by bounds. */
    bool operator!=(const Interval& other) const {
        return !(*this == other);
    }

    /**
     * @brief Check whether two intervals overlap.
     *
     * Zero-length intervals are treated as point probes.
     */
    bool overlaps(const Interval& other) const {
        if (low == high) {
            return other.get_low() <= low && low < other.get_high();
        }
        if (other.get_low() == other.get_high()) {
            return low <= other.get_low() && other.get_low() < high;
        }
        return !(high <= other.get_low() || other.get_high() <= low);
    }

    /** @brief Check whether this interval fully contains `other`. */
    bool contains(const Interval& other) const {
        return low <= other.get_low() && other.get_high() <= high;
    }

    /** @brief Compute overlap length between two intervals. */
    T overlap_length(const Interval& other) const {
        if (!this->overlaps(other)) return 0;
        const T start = std::max(low, other.get_low());
        const T end = std::min(high, other.get_high());
        return end > start ? end - start : 0;
    }

    /** @brief Interval length (`high - low`). */
    T length() const {
        return high - low;
    }
};

#endif // ELASTISCHED_INTERVAL_HPP
