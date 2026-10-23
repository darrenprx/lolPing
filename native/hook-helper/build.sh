#!/bin/sh
# Builds the macOS or Linux hook helper and its tests (Apple clang / a C++20 compiler).
set -eu
cd "$(dirname "$0")"
mkdir -p build
case "$(uname -s)" in
  Darwin)
    CXX=${CXX:-clang++}
    FLAGS="-std=c++20 -arch arm64 -mmacosx-version-min=13.0 -Wall -Wextra"
    "$CXX" $FLAGS -O2 src/main_posix.cpp src/hooks_mac.cpp src/macinput.cpp src/simulate.cpp src/commands.cpp \
      src/output.cpp src/json.cpp src/decision.cpp \
      -framework ApplicationServices -framework CoreFoundation -o build/hook-helper
    ;;
  Linux)
    CXX=${CXX:-c++}
    FLAGS="-std=c++20 -Wall -Wextra -pthread"
    "$CXX" $FLAGS ${CPPFLAGS:-} -O2 src/main_posix.cpp src/hooks_linux.cpp src/linuxinput.cpp src/simulate.cpp \
      src/commands.cpp src/output.cpp src/json.cpp src/decision.cpp ${LDFLAGS:-} -lX11 -lXi -lXtst -o build/hook-helper
    ;;
  *) echo "Unsupported operating system" >&2; exit 1 ;;
esac
"$CXX" $FLAGS ${CPPFLAGS:-} -O0 tests/helper_tests.cpp src/decision.cpp src/commands.cpp src/macinput.cpp src/json.cpp src/output.cpp \
  -o build/helper_tests
if [ "$(uname -s)" = Darwin ]; then
  "$CXX" $FLAGS -O0 tests/hooks_mac_tests.cpp src/decision.cpp src/commands.cpp src/macinput.cpp src/json.cpp src/output.cpp \
    -framework ApplicationServices -framework CoreFoundation -o build/hooks_mac_tests
  echo "Built build/hook-helper, build/helper_tests and build/hooks_mac_tests"
else
  echo "Built build/hook-helper and build/helper_tests"
fi
"$CXX" $FLAGS ${CPPFLAGS:-} -O2 ../../tools/performance/output-scenario.cpp src/json.cpp src/output.cpp -o build/output-scenario
"$CXX" $FLAGS ${CPPFLAGS:-} -O2 ../../tools/performance/decision-scenario.cpp src/decision.cpp -o build/decision-scenario
echo "Built build/output-scenario and build/decision-scenario"
