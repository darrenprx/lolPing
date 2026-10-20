#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cwchar>
#include <string>

#include "app.h"

namespace {

bool writeStdout(const std::string& s) {
  static const HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  const std::string buf = s + "\n";
  DWORD written = 0;
  return WriteFile(h, buf.data(), static_cast<DWORD>(buf.size()), &written, nullptr) != 0 && written == buf.size();
}

// Window and monitor rects in physical pixels, like the hook coordinates. Looked up at run time: Windows 10
// before 1703 has no SetProcessDpiAwarenessContext, and a direct import of it keeps the helper from starting (#66).
void becomeDpiAware() {
  using SetContextFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  using SetAwarenessFn = HRESULT(WINAPI*)(int);
  if (const HMODULE user32 = GetModuleHandleW(L"user32.dll")) {
    if (const auto set = reinterpret_cast<SetContextFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"))) {
      if (set(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return;
    }
  }
  if (const HMODULE shcore = LoadLibraryW(L"shcore.dll")) {
    if (const auto set = reinterpret_cast<SetAwarenessFn>(GetProcAddress(shcore, "SetProcessDpiAwareness"))) {
      set(2);  // PROCESS_PER_MONITOR_DPI_AWARE
    }
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  becomeDpiAware();
  lp::Output out(writeStdout);
  const bool simulate = argc > 1 && std::wcscmp(argv[1], L"--simulate") == 0;
  const int code = simulate ? lp::runSimulate(out) : lp::runHooks(out);
  out.stop();
  return code;
}
