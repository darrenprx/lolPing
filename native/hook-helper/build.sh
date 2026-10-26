#!/bin/sh
# Builds the macOS or Linux hook helper and its tests (Apple clang / a C++20 compiler).
# The context helper (the teammate's screen capture) is built on macOS only: the teammate is off on Linux.
set -eu
cd "$(dirname "$0")"
mkdir -p build
case "$(uname -s)" in
  Darwin)
    CXX=${CXX:-clang++}
    FLAGS="-std=c++20 -arch arm64 -mmacosx-version-min=13.0 -Wall -Wextra"
    # hooks_mac.cpp uses AppKit's NSWorkspace, so it compiles as Objective-C++.
    "$CXX" $FLAGS -O2 -x objective-c++ src/hooks_mac.cpp -x c++ src/main_posix.cpp src/macinput.cpp src/simulate.cpp src/commands.cpp \
      src/output.cpp src/json.cpp src/decision.cpp \
      -framework ApplicationServices -framework CoreFoundation -framework Cocoa -o build/hook-helper
    "$CXX" $FLAGS -fobjc-arc -O2 src/context_main_posix.cpp src/context_capture_mac.mm src/context_text_mac.mm \
      src/context_write_mac.mm src/context.cpp src/json.cpp -framework ScreenCaptureKit -framework CoreGraphics \
      -framework ImageIO -framework AppKit -framework Carbon \
      -framework ApplicationServices -framework CoreFoundation -o build/context-helper
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
"$CXX" $FLAGS ${CPPFLAGS:-} -O0 tests/context_tests.cpp src/context.cpp src/json.cpp -o build/context_tests
if [ "$(uname -s)" = Darwin ]; then
  # hooks_mac_tests.cpp includes hooks_mac.cpp textually, so it needs the same Objective-C++ flag.
  "$CXX" $FLAGS -O0 -x objective-c++ tests/hooks_mac_tests.cpp -x c++ src/decision.cpp src/commands.cpp src/macinput.cpp src/json.cpp src/output.cpp \
    -framework ApplicationServices -framework CoreFoundation -framework Cocoa -o build/hooks_mac_tests
  echo "Built build/hook-helper, build/context-helper, build/helper_tests, build/context_tests and build/hooks_mac_tests"
else
  echo "Built build/hook-helper, build/helper_tests and build/context_tests"
fi
