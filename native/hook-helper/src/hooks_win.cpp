#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <winver.h>

#include <algorithm>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "app.h"
#include "commands.h"

namespace lp {
namespace {

constexpr ULONG_PTR kSelfMarker = 0x4C50494E;  // "LPIN" in dwExtraInfo marks our own SendInput events
constexpr UINT kWmCommand = WM_APP + 1;
constexpr UINT kWmInject = WM_APP + 2;

Decision* g_decision = nullptr;
Output* g_out = nullptr;
DWORD g_hookThreadId = 0;
// Injects waiting to run on the hook thread's message loop. Hook callbacks and that loop share one
// thread, so no lock is needed; only that thread touches this.
std::vector<Inject> g_pendingInjects;

bool isExtendedVk(uint32_t vk) {
  switch (vk) {
    case VK_RMENU: case VK_RCONTROL: case VK_LWIN: case VK_RWIN: case VK_INSERT: case VK_DELETE:
    case VK_HOME: case VK_END: case VK_PRIOR: case VK_NEXT: case VK_LEFT: case VK_RIGHT: case VK_UP: case VK_DOWN:
      return true;
    default:
      return false;
  }
}

bool isKeyDown(uint32_t vk) { return (GetAsyncKeyState(static_cast<int>(vk)) & 0x8000) != 0; }

// One window's process image: its file name and full path as the file system names them, UTF-8. Empty when it
// can't be read. OpenProcess and QueryFullProcessImageName cross process boundaries but send no messages.
AppEntry processOf(HWND window) {
  DWORD pid = 0;
  if (GetWindowThreadProcessId(window, &pid) == 0 || pid == 0) return {};
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == nullptr) return {};
  wchar_t wide[MAX_PATH];
  DWORD size = MAX_PATH;
  AppEntry out;
  if (QueryFullProcessImageNameW(process, 0, wide, &size) && size > 0) {
    const std::wstring path(wide, size);
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, path.data(), static_cast<int>(path.size()), nullptr, 0, nullptr, nullptr);
    if (bytes > 0) {
      std::string utf8(static_cast<size_t>(bytes), '\0');
      WideCharToMultiByte(CP_UTF8, 0, path.data(), static_cast<int>(path.size()), utf8.data(), bytes, nullptr, nullptr);
      const size_t slash = utf8.find_last_of("\\/");
      out.path = utf8;
      out.name = slash == std::string::npos ? utf8 : utf8.substr(slash + 1);
    }
  }
  CloseHandle(process);
  return out;
}

// The foreground window's process image name ("Photoshop.exe"), or '' when it can't be read. The query only
// runs when the foreground window changed since the last call, so the per-event cost is one GetForegroundWindow.
std::string foregroundAppName() {
  static HWND last = nullptr;
  static std::string name;
  const HWND fg = GetForegroundWindow();
  if (fg == nullptr) {
    last = nullptr;
    name.clear();
    return name;
  }
  if (fg == last) return name;
  last = fg;
  name = processOf(fg).name;
  return name;
}

// The file's FileDescription ("网易UU远程" for GameViewer.exe): the words the system and IMEs show for an app, which
// is what a user types. Only for the settings page's app list, never in the hooks.
std::string fileDescription(const std::string& pathUtf8) {
  if (pathUtf8.empty()) return {};
  const int wideLen = MultiByteToWideChar(CP_UTF8, 0, pathUtf8.data(), static_cast<int>(pathUtf8.size()), nullptr, 0);
  if (wideLen <= 0) return {};
  std::wstring path(static_cast<size_t>(wideLen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, pathUtf8.data(), static_cast<int>(pathUtf8.size()), path.data(), wideLen);
  DWORD handle = 0;
  const DWORD size = GetFileVersionInfoSizeW(path.c_str(), &handle);
  if (size == 0) return {};
  std::vector<BYTE> block(size);
  if (!GetFileVersionInfoW(path.c_str(), 0, size, block.data())) return {};
  struct Lang { WORD language, codepage; }* langs = nullptr;
  UINT langCount = 0;
  if (!VerQueryValueW(block.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&langs), &langCount) ||
      langCount < sizeof(Lang) || langs == nullptr)
    return {};
  wchar_t key[64];
  swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\FileDescription", langs[0].language, langs[0].codepage);
  wchar_t* value = nullptr;
  UINT valueLen = 0;
  if (!VerQueryValueW(block.data(), key, reinterpret_cast<void**>(&value), &valueLen) || value == nullptr) return {};
  const std::wstring wide(value, valueLen > 0 ? valueLen - 1 : 0);  // the length counts the NUL
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string utf8(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), utf8.data(), bytes, nullptr, nullptr);
  return utf8;
}

// Windows' own window hosts and brokers have visible, titled windows but are not apps: nobody works inside them,
// and an exception entry for one would silently do nothing. Same idea as the shell surfaces the fullscreen probe skips.
bool isSystemHost(const std::string& name) {
  static const char* const hosts[] = {
      "ApplicationFrameHost.exe", "TextInputHost.exe", "ShellExperienceHost.exe", "SearchHost.exe",
      "StartMenuExperienceHost.exe", "RuntimeBroker.exe", "dllhost.exe", "taskhostw.exe",
  };
  for (const char* host : hosts) {
    if (_stricmp(name.c_str(), host) == 0) return true;
  }
  return false;
}

// The app behind the windows the user can switch to: visible, titled, not a tool window or a shell surface,
// deduplicated by name, at most 64. Run only when the settings page asks, never in the hooks.
BOOL CALLBACK collectAppWindow(HWND window, LPARAM lp) {
  auto& apps = *reinterpret_cast<std::vector<AppEntry>*>(lp);
  if (apps.size() >= 64) return FALSE;
  if (!IsWindowVisible(window)) return TRUE;
  if (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) return TRUE;
  if (GetWindowTextLengthW(window) <= 0) return TRUE;
  wchar_t cls[64];
  if (GetClassNameW(window, cls, 64) != 0 &&
      (lstrcmpiW(cls, L"Progman") == 0 || lstrcmpiW(cls, L"WorkerW") == 0 || lstrcmpiW(cls, L"Shell_TrayWnd") == 0))
    return TRUE;
  const AppEntry app = processOf(window);
  if (app.name.empty() || isSystemHost(app.name)) return TRUE;
  if (std::none_of(apps.begin(), apps.end(), [&](const AppEntry& a) { return a.name == app.name; }))
    apps.push_back(app);
  return TRUE;
}

std::vector<AppEntry> runningApps() {
  std::vector<AppEntry> apps;
  EnumWindows(collectAppWindow, reinterpret_cast<LPARAM>(&apps));
  for (auto& app : apps) app.desc = fileDescription(app.path);
  return apps;
}

// True when the click at (x, y) lands on a monitor that the foreground window covers whole: a game, or any
// fullscreen app, owns that screen, so trigger+click belongs to it, not to a wheel. A click on another
// monitor still gestures. "Covers" means the window rect contains the monitor rect: borderless fullscreen
// equals it, and CS2's fullscreen window is a maximized SDL window that keeps WS_CAPTION and overflows it.
// A maximized normal window stops at the work area, unless the monitor reserves none (auto-hide taskbar,
// or no taskbar on that display): there only caption-less windows count, so CS2-style windows are missed.
// Shell surfaces (desktop, taskbar) are excluded. No cross-process calls: safe inside the hook callback.
bool clickIsOnFullscreenApp(int x, int y) {
  const HWND fg = GetForegroundWindow();
  if (fg == nullptr) return false;
  wchar_t cls[64];
  if (GetClassNameW(fg, cls, 64) != 0 &&
      (lstrcmpiW(cls, L"Progman") == 0 || lstrcmpiW(cls, L"WorkerW") == 0 || lstrcmpiW(cls, L"Shell_TrayWnd") == 0))
    return false;
  const HMONITOR mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
  if (mon == nullptr || mon != MonitorFromPoint(POINT{x, y}, MONITOR_DEFAULTTONEAREST)) return false;
  RECT wr;
  MONITORINFO mi{};
  mi.cbSize = sizeof(mi);
  if (!GetWindowRect(fg, &wr) || !GetMonitorInfoW(mon, &mi)) return false;
  const RECT& m = mi.rcMonitor;
  if (wr.left > m.left || wr.top > m.top || wr.right < m.right || wr.bottom < m.bottom) return false;
  if (EqualRect(&mi.rcWork, &m)) return (GetWindowLongPtrW(fg, GWL_STYLE) & WS_CAPTION) != WS_CAPTION;
  return true;
}

void sendInjects(const std::vector<Inject>& injects) {
  std::vector<INPUT> inputs;
  for (const auto& i : injects) {
    INPUT in{};
    if (i.kind == InjectKind::ButtonDown || i.kind == InjectKind::ButtonUp) {
      const bool down = i.kind == InjectKind::ButtonDown;
      in.type = INPUT_MOUSE;
      in.mi.dwExtraInfo = kSelfMarker;
      switch (i.btn) {
        case Btn::Left: in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
        case Btn::Right: in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
        case Btn::Middle: in.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
        case Btn::X1:
          in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
          in.mi.mouseData = XBUTTON1;
          break;
        case Btn::X2:
          in.mi.dwFlags = down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP;
          in.mi.mouseData = XBUTTON2;
          break;
        default:
          continue;
      }
    } else {
      in.type = INPUT_KEYBOARD;
      in.ki.wVk = static_cast<WORD>(i.vk);
      in.ki.wScan = static_cast<WORD>(MapVirtualKeyW(i.vk, MAPVK_VK_TO_VSC));  // games read scan codes
      in.ki.dwFlags = (i.kind == InjectKind::KeyUp ? KEYEVENTF_KEYUP : 0u) | (isExtendedVk(i.vk) ? KEYEVENTF_EXTENDEDKEY : 0u);
      in.ki.dwExtraInfo = kSelfMarker;
    }
    inputs.push_back(in);
  }
  if (!inputs.empty()) SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
}

// SendInput from inside a low-level hook callback deadlocks against this very hook: the injected
// events must pass the hook chain again, and the thread that serves it is the one blocked inside
// SendInput. Every input event system-wide then waits out the hook timeout, freezing the cursor.
// So injects are queued here and run by the message loop (kWmInject) once the callback has returned.
void queueInjects(const std::vector<Inject>& injects) {
  if (injects.empty()) return;
  g_pendingInjects.insert(g_pendingInjects.end(), injects.begin(), injects.end());
  PostThreadMessageW(g_hookThreadId, kWmInject, 0, 0);
}

void drainInjects() {
  if (g_pendingInjects.empty()) return;
  std::vector<Inject> batch;
  batch.swap(g_pendingInjects);
  sendInjects(batch);
}

// Reports emits, queues injections for the message loop, and returns whether to swallow the event.
bool apply(const Result& r) {
  for (const auto& e : r.emits) g_out->emit(e);
  queueInjects(r.injects);
  return r.swallow;
}

// Like apply(), for a real button or key event. Injects still in the queue were decided for earlier events,
// so passing this one through now would let it overtake them: a replayed press landing after its real
// release leaves the button stuck down. Such an event is swallowed and replayed behind the queue instead.
bool applyInOrder(const InputEvent& e, const Inject& replay) {
  const bool behind = !e.selfInjected && !g_pendingInjects.empty();
  if (apply(g_decision->onEvent(e))) return true;
  if (!behind) return false;
  queueInjects({replay});
  return true;
}

LRESULT CALLBACK mouseProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const auto* m = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
    InputEvent e;
    e.x = m->pt.x;
    e.y = m->pt.y;
    e.timeMs = GetTickCount64();
    e.selfInjected = (m->flags & LLMHF_INJECTED) != 0 && m->dwExtraInfo == kSelfMarker;
    bool known = true;
    switch (wParam) {
      case WM_MOUSEMOVE: e.kind = EvKind::MouseMove; break;
      case WM_LBUTTONDOWN: e.kind = EvKind::MouseDown; e.btn = Btn::Left; break;
      case WM_LBUTTONUP: e.kind = EvKind::MouseUp; e.btn = Btn::Left; break;
      case WM_RBUTTONDOWN: e.kind = EvKind::MouseDown; e.btn = Btn::Right; break;
      case WM_RBUTTONUP: e.kind = EvKind::MouseUp; e.btn = Btn::Right; break;
      case WM_MBUTTONDOWN: e.kind = EvKind::MouseDown; e.btn = Btn::Middle; break;
      case WM_MBUTTONUP: e.kind = EvKind::MouseUp; e.btn = Btn::Middle; break;
      case WM_XBUTTONDOWN:
      case WM_XBUTTONUP:
        e.kind = wParam == WM_XBUTTONDOWN ? EvKind::MouseDown : EvKind::MouseUp;
        e.btn = HIWORD(m->mouseData) == XBUTTON1 ? Btn::X1 : Btn::X2;
        break;
      default:
        known = false;
    }
    if (known && e.kind == EvKind::MouseDown) g_decision->syncKeyStates(isKeyDown);
    if (known) {
      // Moves may overtake queued injects: a replayed press just lands at the newer cursor position.
      const bool swallow = e.kind == EvKind::MouseMove
          ? apply(g_decision->onEvent(e))
          : applyInOrder(e, {e.kind == EvKind::MouseDown ? InjectKind::ButtonDown : InjectKind::ButtonUp, e.btn});
      if (swallow) return 1;
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

LRESULT CALLBACK keyProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const auto* k = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
    InputEvent e;
    e.kind = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN) ? EvKind::KeyDown : EvKind::KeyUp;
    e.vk = k->vkCode;
    e.timeMs = GetTickCount64();
    e.selfInjected = (k->flags & LLKHF_INJECTED) != 0 && k->dwExtraInfo == kSelfMarker;
    if (applyInOrder(e, {e.kind == EvKind::KeyDown ? InjectKind::KeyDown : InjectKind::KeyUp, Btn::None, e.vk})) return 1;
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

// The process that started us, opened for waiting; null if it is already gone. Its creation time must precede
// ours: a PID can be reused once its process exits.
HANDLE openParent() {
  const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return nullptr;
  DWORD parentPid = 0;
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof(pe);
  for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
    if (pe.th32ProcessID == GetCurrentProcessId()) {
      parentPid = pe.th32ParentProcessID;
      break;
    }
  }
  CloseHandle(snap);
  const HANDLE parent = parentPid != 0 ? OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid) : nullptr;
  if (parent == nullptr) return nullptr;
  FILETIME parentStart, ownStart, unused1, unused2, unused3;
  if (!GetProcessTimes(parent, &parentStart, &unused1, &unused2, &unused3) ||
      !GetProcessTimes(GetCurrentProcess(), &ownStart, &unused1, &unused2, &unused3) ||
      CompareFileTime(&parentStart, &ownStart) > 0) {
    CloseHandle(parent);
    return nullptr;
  }
  return parent;
}

// Electron is gone: ask the hook thread to quit, and if it hasn't within 2 s (wedged in a hook callback),
// end the process. A helper left behind keeps its global hooks and slows every input event.
void quitWhenOrphaned(DWORD hookThreadId) {
  PostThreadMessageW(hookThreadId, WM_QUIT, 0, 0);
  Sleep(2000);
  TerminateProcess(GetCurrentProcess(), 0);
}

}  // namespace

int runHooks(Output& out) {
  Decision decision;
  g_decision = &decision;
  g_out = &out;
  decision.setFullscreenProbe(clickIsOnFullscreenApp);
  decision.setForegroundApp(foregroundAppName);
  const DWORD threadId = GetCurrentThreadId();
  g_hookThreadId = threadId;
  MSG msg;
  PeekMessageW(&msg, nullptr, WM_USER, WM_USER, PM_NOREMOVE);  // make sure this thread has a queue

  HHOOK mouseHook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, GetModuleHandleW(nullptr), 0);
  HHOOK keyHook = SetWindowsHookExW(WH_KEYBOARD_LL, keyProc, GetModuleHandleW(nullptr), 0);
  if (mouseHook == nullptr || keyHook == nullptr) {
    out.error("SetWindowsHookEx failed with error " + std::to_string(GetLastError()));
    return 2;
  }
  SetTimer(nullptr, 0, 1000, nullptr);  // watchdog tick

  std::thread reader([threadId] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      auto* text = new std::string(std::move(line));
      if (!PostThreadMessageW(threadId, kWmCommand, 0, reinterpret_cast<LPARAM>(text))) delete text;
    }
    quitWhenOrphaned(threadId);  // stdin closed: Electron is gone
  });
  reader.detach();
  // stdin alone can miss Electron's death: another process may hold the pipe open.
  if (const HANDLE parent = openParent()) {
    std::thread([threadId, parent] {
      WaitForSingleObject(parent, INFINITE);
      quitWhenOrphaned(threadId);
    }).detach();
  }
  out.ready();

  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == WM_TIMER) {
      decision.syncKeyStates(isKeyDown);
      apply(decision.tick(GetTickCount64()));
    } else if (msg.message == kWmInject) {
      drainInjects();
    } else if (msg.message == kWmCommand) {
      std::unique_ptr<std::string> text(reinterpret_cast<std::string*>(msg.lParam));
      const Command c = parseCommand(*text, decision.config());
      switch (c.kind) {
        case Command::Kind::Config: apply(decision.setConfig(c.config)); break;
        case Command::Kind::SetEnabled: apply(decision.setEnabled(c.flag)); break;
        case Command::Kind::Suspend: apply(decision.setSuspended(c.flag)); break;
        case Command::Kind::ForegroundApp: g_out->foregroundApp(foregroundAppName()); break;
        case Command::Kind::AppList: g_out->appList(runningApps()); break;
        case Command::Kind::Shutdown: PostQuitMessage(0); break;
        default: out.error("invalid command: " + *text); break;
      }
    }
  }
  UnhookWindowsHookEx(mouseHook);
  UnhookWindowsHookEx(keyHook);
  return 0;
}

}  // namespace lp
