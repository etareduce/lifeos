# Engine

`engine/` contains the C++ scheduling engine and its Python bindings.

## Core Components
- [`engine/src/engine.cpp`](src/engine.cpp), [`engine/src/engine.hpp`](src/engine.hpp): scheduling runtime and cost computation.
- [`engine/src/optimizer.hpp`](src/optimizer.hpp): simulated annealing optimizer.
- [`engine/src/job.hpp`](src/job.hpp), [`engine/src/policy.hpp`](src/policy.hpp), [`engine/src/tag.hpp`](src/tag.hpp): scheduling primitives.
- [`engine/src/pybind_engine.cpp`](src/pybind_engine.cpp): `pybind11` module exported as `engine`.
- [`engine/tests/tests.cpp`](tests/tests.cpp): C++ unit tests.

## Scheduler Algorithm
The scheduler uses simulated annealing, a stochastic optimization method suited for discrete and non-differentiable cost functions. It is not guaranteed to find a global minimum in every run, but it converges to strong local minima and often reaches a global optimum on smaller calendars.

## Lookahead
Lookahead controls how many future occurrences are passed into each scheduling run. Larger windows can improve global quality, but increase runtime and search complexity.

- Current API default: `14 days` (`lookahead_seconds = 14 * 24 * 60 * 60`).
- User-configurable from scheduling settings/UI payload.
- Recurrence changes mark schedule state as dirty, prompting a re-run.

## Build
- Configure and build:
  1. `cmake -S engine -B engine/build`
  2. `cmake --build engine/build`

## Test
- `cmake -S engine -B engine/build_tests -DELASTISCHED_BUILD_TESTS=ON`
- `cmake --build engine/build_tests`
- `ctest --test-dir engine/build_tests --output-on-failure`
