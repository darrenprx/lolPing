// macOS input layer: a CGEventTap feeding the shared Decision logic. Needs Accessibility permission.
#import <Cocoa/Cocoa.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <iostream>
#include <string>
#include <thread>

#include "app.h"
#include "commands.h"
#include "macinput.h"

namespace lp {
namespace {

constexpr int64_t kSelfMarker = 0x4C50494E;  // "LPIN" in kCGEventSourceUserData marks our own posted events
constexpr int kExitNoAccess = 3;             // Electron treats this exit code as "needs Accessibility"

constexpr CGEventFlags kModifierFlags = mac::kFlagShift | mac::kFlagControl | mac::kFlagOption | mac::kFlagCommand |
                                        mac::kDevLCtrl | mac::kDevLShift | mac::kDevRShift | mac::kDevLCmd |
                                        mac::kDevRCmd | mac::kDevLAlt | mac::kDevRAlt | mac::kDevRCtrl;

Decision* g_decision = nullptr;
Output* g_out = nullptr;
CFMachPortRef g_tap = nullptr;
CGEventFlags g_flags = 0;  // the modifier state Decision last saw
// Keep the press's click count until its replay, including replays caused by a trigger key-up.
std::array<int64_t, 6> g_clickStates{1, 1, 1, 1, 1, 1};

uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count());
}

bool isModifierVk(uint32_t vk) {
  return (vk >= 0xA0 && vk <= 0xA5) || vk == 0x5B || vk == 0x5C;
}

bool isKeyDown(uint32_t vk) {
  if (isModifierVk(vk)) return mac::modifierHeld(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState), vk);
  const int code = mac::vkToKeyCode(vk);
  return code >= 0 && CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, static_cast<CGKeyCode>(code));
}

// The frontmost app's process name ("Photoshop"), or '' when there is none. The run loop serving the tap is this
// process's main thread, which is where NSWorkspace answers from, so the query is safe in the tap callback.
std::string foregroundAppName() {
  @autoreleasepool {
    NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    NSString* name = app.processName;
    return name != nil ? std::string(name.UTF8String) : std::string();
  }
}

// The regular apps the user can switch to, by process name and bundle path, at most 64. Asked only by the settings page.
std::vector<AppEntry> runningApps() {
  @autoreleasepool {
    std::vector<AppEntry> apps;
    for (NSRunningApplication* app in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if (apps.size() >= 64) break;
      if (app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
      NSString* name = app.processName;
      if (name == nil) continue;
      AppEntry entry;
      entry.name = name.UTF8String;
      NSString* local = app.localizedName;
      if (local != nil) entry.desc = local.UTF8String;
      NSString* path = app.bundleURL.path;
      if (path != nil) entry.path = path.UTF8String;
      if (std::none_of(apps.begin(), apps.end(), [&](const AppEntry& a) { return a.name == entry.name; }))
        apps.push_back(entry);
    }
    std::sort(apps.begin(), apps.end(), [](const AppEntry& a, const AppEntry& b) { return a.name < b.name; });
    return apps;
  }
}

CGPoint cursorLocation() {
  CGEventRef e = CGEventCreate(nullptr);
  const CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

void postButton(Btn btn, bool down) {
  CGEventType type;
  CGMouseButton button;
  switch (btn) {
    case Btn::Left:
      type = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
      button = kCGMouseButtonLeft;
      break;
    case Btn::Right:
      type = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
      button = kCGMouseButtonRight;
      break;
    case Btn::Middle:
    case Btn::X1:
    case Btn::X2:
      type = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
      button = static_cast<CGMouseButton>(btn == Btn::Middle ? 2 : btn == Btn::X1 ? 3 : 4);
      break;
    default:
      return;
  }
  CGEventRef e = CGEventCreateMouseEvent(nullptr, type, cursorLocation(), button);
  if (e == nullptr) return;
  CGEventSetIntegerValueField(e, kCGMouseEventButtonNumber, static_cast<int64_t>(button));
  CGEventSetIntegerValueField(e, kCGMouseEventClickState, g_clickStates[static_cast<size_t>(btn)]);
  CGEventSetFlags(e, g_flags);  // a replayed Option-click keeps its Option
  CGEventSetIntegerValueField(e, kCGEventSourceUserData, kSelfMarker);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

// Modifiers are left out: their real flag change always passes, and a posted key carries g_flags.
void postKey(uint32_t vk, bool down) {
  const int code = mac::vkToKeyCode(vk);
  if (code < 0 || isModifierVk(vk)) return;
  CGEventRef e = CGEventCreateKeyboardEvent(nullptr, static_cast<CGKeyCode>(code), down);
  if (e == nullptr) return;
  CGEventSetFlags(e, g_flags);  // a replayed Shift+G stays a capital G
  CGEventSetIntegerValueField(e, kCGEventSourceUserData, kSelfMarker);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

// Reports emits, replays buttons and keys, and returns whether to swallow the event.
bool apply(const Result& r) {
  for (const auto& e : r.emits) g_out->emit(e);
  for (const auto& i : r.injects) {
    if (i.kind == InjectKind::ButtonDown) postButton(i.btn, true);
    if (i.kind == InjectKind::ButtonUp) postButton(i.btn, false);
    if (i.kind == InjectKind::KeyDown) postKey(i.vk, true);
    if (i.kind == InjectKind::KeyUp) postKey(i.vk, false);
  }
  return r.swallow;
}

// Turns a modifier-flag change into the key events Decision expects. Mouse events carry the flags too, which keeps
// the state right while Secure Event Input (a focused password field) hides keyboard events from the tap.
void feedFlags(CGEventFlags flags, uint64_t t) {
  flags &= kModifierFlags;
  if (flags == g_flags) return;
  for (const auto& k : mac::modifierTransitions(g_flags, flags)) {
    InputEvent e;
    e.kind = k.down ? EvKind::KeyDown : EvKind::KeyUp;
    e.vk = k.vk;
    e.timeMs = t;
    apply(g_decision->onEvent(e));  // modifier events always pass through
  }
  g_flags = flags;
}

void resync() {
  feedFlags(CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState), nowMs());
  g_decision->syncKeyStates(isKeyDown);
}

bool mouseButton(CGEventRef event, Btn& btn) {
  switch (CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber)) {
    case 2: btn = Btn::Middle; return true;
    case 3: btn = Btn::X1; return true;
    case 4: btn = Btn::X2; return true;
    default: return false;
  }
}

CGEventRef tapCallback(CGEventTapProxy, CGEventType type, CGEventRef event, void*) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (g_tap != nullptr) CGEventTapEnable(g_tap, true);
    resync();
    // Key events were missed while the tap was off, so a held panel key may already be up: hide the panel.
    apply(g_decision->releasePanel());
    return event;
  }
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) == kSelfMarker) return event;
  const uint64_t t = nowMs();
  feedFlags(CGEventGetFlags(event), t);

  if (type == kCGEventFlagsChanged) return event;
  if (type == kCGEventKeyDown || type == kCGEventKeyUp) {
    const auto code = static_cast<uint16_t>(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode));
    const uint32_t vk = mac::keyCodeToVk(code);
    if (vk == 0) return event;
    InputEvent e;
    e.kind = type == kCGEventKeyDown ? EvKind::KeyDown : EvKind::KeyUp;
    e.vk = vk;
    e.timeMs = t;
    return apply(g_decision->onEvent(e)) ? nullptr : event;
  }

  InputEvent e;
  const CGPoint p = CGEventGetLocation(event);  // global points = Electron DIPs
  e.x = static_cast<int>(std::lround(p.x));
  e.y = static_cast<int>(std::lround(p.y));
  e.timeMs = t;
  switch (type) {
    // Dragged events always pass through, even after the press was swallowed: dropping them at the session tap
    // freezes the cursor. Apps that never saw the press ignore a drag without one.
    case kCGEventMouseMoved:
    case kCGEventLeftMouseDragged:
    case kCGEventRightMouseDragged:
    case kCGEventOtherMouseDragged:
      e.kind = EvKind::MouseMove;
      break;
    case kCGEventLeftMouseDown: e.kind = EvKind::MouseDown; e.btn = Btn::Left; break;
    case kCGEventLeftMouseUp: e.kind = EvKind::MouseUp; e.btn = Btn::Left; break;
    case kCGEventRightMouseDown: e.kind = EvKind::MouseDown; e.btn = Btn::Right; break;
    case kCGEventRightMouseUp: e.kind = EvKind::MouseUp; e.btn = Btn::Right; break;
    case kCGEventOtherMouseDown:
    case kCGEventOtherMouseUp:
      if (!mouseButton(event, e.btn)) return event;
      e.kind = type == kCGEventOtherMouseDown ? EvKind::MouseDown : EvKind::MouseUp;
      break;
    default:
      return event;
  }
  if (e.kind == EvKind::MouseDown) {
    g_clickStates[static_cast<size_t>(e.btn)] = CGEventGetIntegerValueField(event, kCGMouseEventClickState);
    g_decision->syncKeyStates(isKeyDown);
  }
  return apply(g_decision->onEvent(e)) ? nullptr : event;
}

void handleCommand(const std::string& text) {
  const Command c = parseCommand(text, g_decision->config());
  switch (c.kind) {
    case Command::Kind::Config: apply(g_decision->setConfig(c.config)); break;
    case Command::Kind::SetEnabled: apply(g_decision->setEnabled(c.flag)); break;
    case Command::Kind::Suspend: apply(g_decision->setSuspended(c.flag)); break;
    case Command::Kind::ForegroundApp: g_out->foregroundApp(foregroundAppName()); break;
    case Command::Kind::AppList: g_out->appList(runningApps()); break;
    case Command::Kind::Shutdown: CFRunLoopStop(CFRunLoopGetCurrent()); break;
    default: g_out->error("invalid command: " + text); break;
  }
}

}  // namespace

int runHooks(Output& out) {
  Decision decision;
  decision.setMaskMenuKeys(false);
  // The repeat watchdog only guards lost key-ups; macOS repeat delay and the repeat setting make repeats unreliable.
  decision.setPanelRepeatGap(0);
  decision.setForegroundApp(foregroundAppName);
  g_decision = &decision;
  g_out = &out;

  const CGEventMask mask =
      CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged) |
      CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
      CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
      CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
      CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) |
      CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged);
  g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, tapCallback, nullptr);
  if (g_tap == nullptr) {
    out.error("noAccess", "Can't read input: lolPing needs Accessibility permission");
    return kExitNoAccess;
  }
  CFRunLoopRef loop = CFRunLoopGetCurrent();
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
  CFRunLoopAddSource(loop, source, kCFRunLoopCommonModes);
  CGEventTapEnable(g_tap, true);

  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 1.0, 1.0, 0, 0, ^(CFRunLoopTimerRef) {
        resync();
        apply(g_decision->tick(nowMs()));
      });
  CFRunLoopAddTimer(loop, timer, kCFRunLoopCommonModes);

  std::thread reader([loop] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      auto* text = new std::string(std::move(line));
      CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{
        handleCommand(*text);
        delete text;
      });
      CFRunLoopWakeUp(loop);
    }
    // stdin closed: Electron is gone
    CFRunLoopPerformBlock(loop, kCFRunLoopCommonModes, ^{
      CFRunLoopStop(loop);
    });
    CFRunLoopWakeUp(loop);
  });
  reader.detach();

  resync();  // a modifier may already be held
  out.ready();
  CFRunLoopRun();

  CGEventTapEnable(g_tap, false);
  CFRunLoopTimerInvalidate(timer);
  CFRelease(timer);
  CFRunLoopRemoveSource(loop, source, kCFRunLoopCommonModes);
  CFRelease(source);
  CFMachPortInvalidate(g_tap);
  CFRelease(g_tap);
  g_tap = nullptr;
  return 0;
}

}  // namespace lp
