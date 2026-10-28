#pragma once

namespace lp {
// Runs before Electron creates restricted children; only operates on this helper's own packaged installation.
int ensureInstallAccess();
}
