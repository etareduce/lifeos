#ifndef ELASTISCHED_INTERVAL_HPP
#define ELASTISCHED_INTERVAL_HPP

#include <algorithm>
#include <iostream>
#include <stdexcept>

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
    Interval(T e) : low(e), high(e) {}

    Interval(T low, T high) : low(low), high(high) {
        if (high < low) {
            throw std::invalid_argument("Interval: high must be >= low");
        }
    }

    T get_low() const { return low; }
    T get_high() const { return high; }

    bool operator==(const Interval& other) const {
        return low == other.get_low() && high == other.get_high();
    }

    bool operator!=(const Interval& other) const {
        return !(*this == other);
    }

    bool overlaps(const Interval& other) const {
        if (low == high) {
            return other.get_low() <= low && low < other.get_high();
        }
        if (other.get_low() == other.get_high()) {
            return low <= other.get_low() && other.get_low() < high;
        }
        return !(high <= other.get_low() || other.get_high() <= low);
    }

    bool contains(const Interval& other) const {
        return low <= other.get_low() && other.get_high() <= high;
    }

    T overlap_length(const Interval& other) const {
        if (!this->overlaps(other)) return 0;
        const T start = std::max(low, other.get_low());
        const T end = std::min(high, other.get_high());
        return end > start ? end - start : 0;
    }

    T length() const {
        return high - low;
    }
};

#endif // ELASTISCHED_INTERVAL_HPP
