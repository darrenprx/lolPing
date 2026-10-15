#!/bin/sh
# Builds the Linux (X11) hook helper and its tests with g++.
# UOS 20 ships g++ 8.3: -std=c++2a is its C++20 flag spelling.
# Headers: with libxtst-dev/libxi-dev installed, nothing else is needed. Without them, point
# X11DEV_INC at a directory containing X11/extensions/{XTest,XInput}.h.
set -eu
cd "$(dirname "$0")"
mkdir -p build
FLAGS="-std=c++2a -Wall -Wextra"
INC="${X11DEV_INC:-}"
SRCS="src/main_posix.cpp src/hooks_linux.cpp src/simulate.cpp src/commands.cpp src/output.cpp src/json.cpp src/decision.cpp"

# libXtst ships as .so.6; the -lXtst symlink only exists with the dev package installed.
if ! g++ $FLAGS $INC -O2 $SRCS -lX11 -lXtst -lpthread -o build/hook-helper 2>/dev/null; then
  XTST=$(ls /usr/lib/*/libXtst.so.6 /lib/*/libXtst.so.6 2>/dev/null | head -1)
  if [ -z "$XTST" ]; then
    echo "error: libXtst.so.6 not found (apt install libxtst6)" >&2
    exit 1
  fi
  g++ $FLAGS $INC -O2 $SRCS -lX11 "$XTST" -lpthread -o build/hook-helper
fi
g++ $FLAGS $INC -O0 tests/helper_tests.cpp src/decision.cpp src/commands.cpp src/macinput.cpp src/json.cpp src/output.cpp \
  -lpthread -o build/helper_tests
echo "Built build/hook-helper and build/helper_tests"
