// context-helper on Windows: reads capture/foreground/ping commands on stdin, one reply line each on stdout.
// A separate process from hook-helper, so a slow or crashing capture never touches the input hooks.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <objbase.h>

#include <cstdio>
#include <iostream>
#include <string>

#include "context.h"
#include "install_access_win.h"

namespace {

bool writeStdout(const std::string& s) {
  static const HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  const std::string buf = s + "\n";
  DWORD written = 0;
  return WriteFile(h, buf.data(), static_cast<DWORD>(buf.size()), &written, nullptr) != 0 && written == buf.size();
}

// Display rects and spots come in physical pixels, like the hook helper's coordinates. Same lookup as its
// main_win.cpp: Windows 10 before 1703 has no SetProcessDpiAwarenessContext (#66).
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

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring(argv[1]) == L"--ensure-install-access") return lp::ensureInstallAccess();
  becomeDpiAware();
  _setmode(_fileno(stdin), _O_BINARY);  // UTF-8 bytes as they are; a 0x1A byte is not end of input
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;
  const int code = lp::ctx::runContextLoop(std::cin, writeStdout, lp::ctx::nativePlatform());
  // A slow probe's thread may still be inside COM or UI Automation: end without cleanup running under it.
  if (code == lp::ctx::kExitNow) TerminateProcess(GetCurrentProcess(), 0);
  CoUninitialize();
  return code;
}
