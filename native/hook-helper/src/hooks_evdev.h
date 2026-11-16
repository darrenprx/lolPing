#pragma once
#include "output.h"

namespace lp {

// Linux backend for Wayland sessions (and LOLPING_INPUT=evdev): reads /dev/input, grabs keyboards and mice, and
// passes everything on through uinput clones. Returns 3 (after a needsSetup error) when the devices can't be opened.
int runEvdevHooks(Output& out);

}  // namespace lp
