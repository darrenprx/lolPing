// Unit tests for the hook helper's pure logic (no OS hooks).
// Build and run: npm run test:helper
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <map>
#include <mutex>
#include <string>

#include "../src/commands.h"
#include "../src/decision.h"
#include "../src/json.h"
#include "../src/macinput.h"
#include "../src/output.h"

using namespace lp;

static int g_pass = 0;
static int g_fail = 0;
#define CHECK(cond)                                               \
  do {                                                            \
    if (cond) {                                                   \
      ++g_pass;                                                   \
    } else {                                                      \
      ++g_fail;                                                   \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
    }                                                             \
  } while (0)

namespace {
constexpr uint32_t ALT = 0xA4, CTRL = 0xA2, KEY_P = 0x50, ESC = 0x1B, CAPS = 0x14, KEY_V = 0x56, KEY_T = 0x54, TAB = 0x09;
using S = Decision::State;

InputEvent key(EvKind k, uint32_t vk) {
  InputEvent e;
  e.kind = k;
  e.vk = vk;
  return e;
}
InputEvent kd(uint32_t vk) { return key(EvKind::KeyDown, vk); }
InputEvent ku(uint32_t vk) { return key(EvKind::KeyUp, vk); }
InputEvent mouse(EvKind k, Btn b, int x, int y, uint64_t t) {
  InputEvent e;
  e.kind = k;
  e.btn = b;
  e.x = x;
  e.y = y;
  e.timeMs = t;
  return e;
}
InputEvent md(Btn b, int x, int y, uint64_t t = 0) { return mouse(EvKind::MouseDown, b, x, y, t); }
InputEvent mu(Btn b, int x, int y, uint64_t t = 0) { return mouse(EvKind::MouseUp, b, x, y, t); }
InputEvent mv(int x, int y, uint64_t t = 0) { return mouse(EvKind::MouseMove, Btn::None, x, y, t); }

const Emit* findEmit(const Result& r, Emit::Kind k) {
  for (const auto& e : r.emits) {
    if (e.kind == k) return &e;
  }
  return nullptr;
}
bool injectIs(const Inject& i, InjectKind k, Btn b, uint32_t vk = 0) { return i.kind == k && i.btn == b && i.vk == vk; }
Decision withTrigger(Trigger t, uint32_t vk = 0, bool clickPing = false) {
  Config c;
  c.trigger = t;
  c.triggerVk = vk;
  c.clickPing = clickPing;
  Decision d;
  d.setConfig(c);
  return d;
}
// Pings on Alt (the default), emotes on `emote`.
Decision withEmote(Trigger emote = Trigger::Ctrl, uint32_t vk = 0, bool emoteClick = false) {
  Config c;
  c.emoteTrigger = emote;
  c.emoteTriggerVk = vk;
  c.emoteClick = emoteClick;
  Decision d;
  d.setConfig(c);
  return d;
}
// Alt held, left pressed at (100,100), dragged to (130,100): the wheel is open.
void openWheel(Decision& d) {
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100));
  d.onEvent(mv(130, 100));
}
// The same drag with Ctrl: the emote wheel is open (with withEmote()).
void openEmoteWheel(Decision& d) {
  d.onEvent(kd(CTRL));
  d.onEvent(md(Btn::Left, 100, 100));
  d.onEvent(mv(130, 100));
}
bool emitIs(const Emit* e, WheelKind w) { return e != nullptr && e->wheel == w; }
}  // namespace

static void test_alt_drag_opens_wheel_and_releases() {
  Decision d;
  CHECK(!d.onEvent(kd(ALT)).swallow);
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(d.state() == S::Pending);
  r = d.onEvent(mv(104, 104));  // 5.7 px, below the 8 px threshold
  CHECK(!r.swallow && r.emits.empty());
  r = d.onEvent(mv(120, 100));
  CHECK(!r.swallow);
  CHECK(d.state() == S::Wheel);
  CHECK(r.emits.size() == 2);
  CHECK(r.emits[0].kind == Emit::Kind::WheelOpen && r.emits[0].x == 100 && r.emits[0].y == 100);
  CHECK(r.emits[1].kind == Emit::Kind::WheelMove && r.emits[1].x == 120);
  r = d.onEvent(mv(125, 90));
  CHECK(findEmit(r, Emit::Kind::WheelMove) != nullptr);
  r = d.onEvent(mu(Btn::Left, 130, 90));
  CHECK(r.swallow);
  const Emit* rel = findEmit(r, Emit::Kind::WheelRelease);
  CHECK(rel != nullptr && rel->x == 130 && rel->y == 90);
  CHECK(d.state() == S::Idle);
}

static void test_plain_click_passes_through() {
  Decision d;
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);
  CHECK(!d.onEvent(mu(Btn::Left, 1, 1)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_alt_click_replays_when_click_ping_off() {
  Decision d;
  d.onEvent(kd(ALT));
  CHECK(d.onEvent(md(Btn::Left, 50, 60)).swallow);
  d.onEvent(mv(53, 62));  // tiny jitter, still a click
  Result r = d.onEvent(mu(Btn::Left, 53, 62));
  CHECK(r.swallow);
  CHECK(r.emits.empty());
  CHECK(r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::ButtonDown, Btn::Left));
  CHECK(injectIs(r.injects[1], InjectKind::ButtonUp, Btn::Left));
  CHECK(d.state() == S::Idle);
}

static void test_alt_click_pings_when_click_ping_on() {
  Decision d = withTrigger(Trigger::Alt, 0, true);
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 50, 60));
  Result r = d.onEvent(mu(Btn::Left, 51, 60));
  CHECK(r.swallow);
  CHECK(r.injects.empty());
  const Emit* c = findEmit(r, Emit::Kind::Click);
  CHECK(c != nullptr && c->x == 50 && c->y == 60);
}

static void test_self_injected_events_are_ignored() {
  Decision d;
  d.onEvent(kd(ALT));
  InputEvent e = md(Btn::Left, 5, 5);
  e.selfInjected = true;
  CHECK(!d.onEvent(e).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_right_click_cancels_wheel() {
  Decision d;
  openWheel(d);
  Result r = d.onEvent(md(Btn::Right, 130, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.onEvent(mu(Btn::Right, 130, 100)).swallow);
  r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::WheelRelease) == nullptr);
  CHECK(d.state() == S::Idle);
}

static void test_right_click_with_alt_but_no_gesture_passes() {
  Decision d;
  d.onEvent(kd(ALT));
  CHECK(!d.onEvent(md(Btn::Right, 1, 1)).swallow);
  CHECK(!d.onEvent(mu(Btn::Right, 1, 1)).swallow);
}

static void test_escape_cancels_wheel() {
  Decision d;
  openWheel(d);
  Result r = d.onEvent(kd(ESC));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.onEvent(ku(ESC)).swallow);
  r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(r.swallow && r.emits.empty());
}

// As in League, once the wheel is open only the mouse button decides: letting go of the trigger first
// keeps the wheel (and a trackpad's three-finger drag, whose button-up comes late, still pings).
static void test_trigger_released_during_wheel_keeps_wheel() {
  Decision d;
  openWheel(d);
  Result r = d.onEvent(ku(ALT));
  CHECK(r.emits.empty());
  CHECK(d.state() == S::Wheel);
  CHECK(r.swallow && r.injects.size() == 3);  // the Alt-up is still masked
  r = d.onEvent(mv(140, 90));
  CHECK(findEmit(r, Emit::Kind::WheelMove) != nullptr);
  r = d.onEvent(mu(Btn::Left, 140, 90));
  CHECK(r.swallow);
  const Emit* rel = findEmit(r, Emit::Kind::WheelRelease);
  CHECK(rel != nullptr && rel->x == 140 && rel->y == 90);
  CHECK(d.state() == S::Idle);
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);  // no trigger held: clicks pass again

  Decision e;
  openWheel(e);
  e.onEvent(ku(ALT));
  r = e.onEvent(kd(ESC));  // Esc still cancels
  CHECK(r.swallow && findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(e.onEvent(mu(Btn::Left, 130, 100)).swallow);
  CHECK(e.state() == S::Idle);
}

static void test_trigger_released_during_pending_replays_click_after_mask() {
  Decision d;
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100));
  Result r = d.onEvent(ku(ALT));
  CHECK(r.swallow);  // the Alt-up is swallowed and re-injected after the mask key
  CHECK(r.injects.size() == 4);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[1], InjectKind::KeyUp, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[2], InjectKind::KeyUp, Btn::None, ALT));
  CHECK(injectIs(r.injects[3], InjectKind::ButtonDown, Btn::Left));
  CHECK(d.state() == S::Idle);
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);  // the real up completes the replayed click
}

static void test_trigger_released_during_pending_pings_when_click_ping_on() {
  Decision d = withTrigger(Trigger::Alt, 0, true);
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100));
  Result r = d.onEvent(ku(ALT));
  const Emit* c = findEmit(r, Emit::Kind::Click);
  CHECK(c != nullptr && c->x == 100);
  CHECK(d.onEvent(mu(Btn::Left, 100, 100)).swallow);
}

// Alt+Tab belongs to the task switcher: clicks pass through untouched while the chord lasts,
// and after Alt is released Alt+click gestures again.
static void test_alt_tab_clicks_pass_through() {
  Decision d;
  CHECK(!d.onEvent(kd(ALT)).swallow);
  CHECK(!d.onEvent(kd(TAB)).swallow);  // the switcher's key marks the chord as foreign
  CHECK(!d.onEvent(ku(TAB)).swallow);
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow);  // the click belongs to the switcher, not to a wheel
  CHECK(!findEmit(r, Emit::Kind::Click));
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
  r = d.onEvent(ku(ALT));  // nothing was swallowed, so the Alt-up needs no mask
  CHECK(!r.swallow);
  CHECK(r.injects.empty());
  d.onEvent(kd(ALT));  // the chord is over: Alt+click gestures again
  r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(r.injects.size() == 2);  // clickPing off: the click is replayed
}

// Same rule with clickPing on: Alt+Tab + click must NOT place a ping.
static void test_alt_tab_click_places_no_ping_even_with_click_ping_on() {
  Decision d = withTrigger(Trigger::Alt, 0, true);
  d.onEvent(kd(ALT));
  d.onEvent(kd(TAB));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow);
  CHECK(!findEmit(r, Emit::Kind::Click));
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
  r = d.onEvent(ku(ALT));
  CHECK(!r.swallow);
  CHECK(r.injects.empty());
}

// Win+Tab (task view) under the Win trigger; a stale foreign flag is cleared by key re-sync.
static void test_win_tab_clicks_pass_through_and_sync_clears_flag() {
  Decision d = withTrigger(Trigger::Win);
  d.onEvent(kd(0x5B));  // LWin
  d.onEvent(kd(TAB));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow);
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
  d.syncKeyStates([](uint32_t) { return false; });  // the OS reports every key up (Win+L, UAC...)
  d.onEvent(kd(0x5B));                              // LWin again
  r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);  // gestures again
}

// A fullscreen game owns the screen: trigger+click passes through while the probe says fullscreen,
// and gestures come back on the desktop. (clickPing on: the in-game drop-click case.)
static void test_fullscreen_game_keeps_the_click() {
  Config c;
  c.trigger = Trigger::Alt;
  c.clickPing = true;
  c.gameCheck = true;
  Decision d;
  d.setConfig(c);
  bool fullscreen = true;
  d.setFullscreenProbe([&fullscreen](int, int) { return fullscreen; });
  d.onEvent(kd(ALT));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow);  // the game keeps the click
  CHECK(!findEmit(r, Emit::Kind::Click));
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
  fullscreen = false;  // back on the desktop: gestures again
  r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Click) != nullptr);
  CHECK(d.state() == S::Idle);
}

// gameCheck off: the probe is never consulted, fullscreen or not.
static void test_fullscreen_probe_ignored_when_disabled() {
  Config c;
  c.trigger = Trigger::Alt;
  c.clickPing = true;
  c.gameCheck = false;
  Decision d;
  d.setConfig(c);
  bool consulted = false;
  d.setFullscreenProbe([&consulted](int, int) { consulted = true; return true; });
  d.onEvent(kd(ALT));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);  // the gesture starts despite "fullscreen"
  CHECK(!consulted);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Click) != nullptr);
}

// An app on the skip list stands down entirely: its clicks and its chords (the text hotkey, the panel key)
// reach it untouched, while the enable/disable toggle still works there as the way back out.
static void test_skipped_app_stands_down() {
  Config c;
  c.trigger = Trigger::Alt;
  c.clickPing = true;
  c.skipApps = "Photoshop.exe,idea64";
  c.toggleMods = ModCtrl | ModAlt;
  c.toggleVk = KEY_P;
  c.textMods = ModAlt;
  c.textVk = KEY_T;
  c.panelVk = TAB;
  Decision d;
  d.setConfig(c);
  std::string front = "Photoshop.exe";
  d.setForegroundApp([&front] { return front; });

  d.onEvent(kd(ALT));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow);  // Photoshop keeps the click
  CHECK(!findEmit(r, Emit::Kind::Click));
  CHECK(d.state() == S::Idle);
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
  d.onEvent(ku(ALT));

  // Its chords are its own again: the text hotkey passes untouched.
  d.onEvent(kd(ALT));
  r = d.onEvent(kd(KEY_T));
  CHECK(!r.swallow);
  CHECK(!findEmit(r, Emit::Kind::TextRequested));
  d.onEvent(ku(KEY_T));
  d.onEvent(ku(ALT));
  // The panel key too.
  r = d.onEvent(kd(TAB));
  CHECK(!r.swallow);
  CHECK(!findEmit(r, Emit::Kind::Panel));
  d.onEvent(ku(TAB));

  // Matching ignores case and the .exe suffix; another app gets gestures back.
  front = "Explorer.EXE";
  d.onEvent(kd(ALT));
  r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Click) != nullptr);
  d.onEvent(ku(ALT));

  // The toggle still answers in the skipped app: it is the way back out.
  front = "idea64";
  d.onEvent(kd(ALT));
  d.onEvent(kd(CTRL));
  r = d.onEvent(kd(KEY_P));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Toggled) != nullptr);
  d.onEvent(ku(KEY_P));
  d.onEvent(ku(CTRL));
  d.onEvent(ku(ALT));
}

// With no apps on the skip list, the foreground app is never queried.
static void test_skip_apps_empty_never_queries() {
  Config c;
  c.trigger = Trigger::Alt;
  c.clickPing = true;
  Decision d;
  d.setConfig(c);
  int consulted = 0;
  d.setForegroundApp([&consulted] { ++consulted; return "photoshop"; });
  d.onEvent(kd(ALT));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(consulted == 0);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Click) != nullptr);
}

// Adding and removing an app by config takes effect at once, without touching the supplier.
static void test_skip_apps_live_update() {
  Config c;
  c.trigger = Trigger::Alt;
  Decision d;
  d.setConfig(c);
  d.setForegroundApp([] { return "photoshop"; });
  d.onEvent(kd(ALT));
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);  // not on the list yet
  d.onEvent(mu(Btn::Left, 100, 100));
  d.onEvent(ku(ALT));

  Config withApp = c;
  withApp.skipApps = "photoshop";
  d.setConfig(withApp);
  d.onEvent(kd(ALT));
  CHECK(!d.onEvent(md(Btn::Left, 100, 100)).swallow);
  d.onEvent(mu(Btn::Left, 100, 100));
  d.onEvent(ku(ALT));

  d.setConfig(c);  // the list is empty again
  d.onEvent(kd(ALT));
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);
  d.onEvent(mu(Btn::Left, 100, 100));
  d.onEvent(ku(ALT));
}

static void test_alt_up_after_gesture_is_masked() {
  Decision d;
  openWheel(d);
  d.onEvent(mu(Btn::Left, 130, 100));
  Result r = d.onEvent(ku(ALT));
  CHECK(r.swallow);
  CHECK(r.injects.size() == 3);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[1], InjectKind::KeyUp, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[2], InjectKind::KeyUp, Btn::None, ALT));
}

static void test_plain_alt_tap_is_not_masked() {
  Decision d;
  d.onEvent(kd(ALT));
  Result r = d.onEvent(ku(ALT));
  CHECK(!r.swallow && r.injects.empty());
}

static void test_toggle_hotkey_disables_and_enables() {
  Decision d;
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_P));
  CHECK(r.swallow);
  const Emit* t = findEmit(r, Emit::Kind::Toggled);
  CHECK(t != nullptr && !t->enabled);
  CHECK(!d.enabled());
  CHECK(d.onEvent(ku(KEY_P)).swallow);
  d.onEvent(ku(CTRL));
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);  // disabled: Alt+press passes
  d.onEvent(mu(Btn::Left, 1, 1));
  d.onEvent(kd(CTRL));
  r = d.onEvent(kd(KEY_P));
  t = findEmit(r, Emit::Kind::Toggled);
  CHECK(t != nullptr && t->enabled);
  CHECK(d.enabled());
}

static void test_hotkey_autorepeat_toggles_once() {
  Decision d;
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  CHECK(findEmit(d.onEvent(kd(KEY_P)), Emit::Kind::Toggled) != nullptr);
  Result repeat = d.onEvent(kd(KEY_P));
  CHECK(repeat.swallow);
  CHECK(findEmit(repeat, Emit::Kind::Toggled) == nullptr);
  CHECK(!d.enabled());
}

static void test_hotkey_ignored_while_suspended() {
  Decision d;
  d.setSuspended(true);
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_P));
  CHECK(!r.swallow && r.emits.empty());
  CHECK(d.enabled());
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);  // suspended: no gestures either
}

static void test_text_hotkey_requests_once() {
  Config c;
  c.trigger = Trigger::CustomVk;
  c.triggerVk = KEY_T;  // the complete shortcut must win over this swallowed custom trigger
  c.textVk = KEY_T;
  Decision d;
  d.setConfig(c);
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::TextRequested) != nullptr);
  Result repeat = d.onEvent(kd(KEY_T));
  CHECK(repeat.swallow);
  CHECK(findEmit(repeat, Emit::Kind::TextRequested) == nullptr);
  CHECK(d.onEvent(ku(KEY_T)).swallow);
}

static void test_text_hotkey_ignored_while_suspended() {
  Config c;
  c.textVk = KEY_T;
  Decision d;
  d.setConfig(c);
  d.setSuspended(true);
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
}

static Decision withAltText(uint32_t textVk = KEY_T) {
  Config c;
  c.trigger = Trigger::Alt;
  c.textMods = ModAlt;
  c.textVk = textVk;
  Decision d;
  d.setConfig(c);
  return d;
}

static void test_text_hotkey_fires_with_alt_trigger() {
  Decision d = withAltText();
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::TextRequested) != nullptr);
  CHECK(d.onEvent(ku(KEY_T)).swallow);
  r = d.onEvent(ku(ALT));
  CHECK(findEmit(r, Emit::Kind::Click) == nullptr && findEmit(r, Emit::Kind::WheelOpen) == nullptr);
  CHECK(d.state() == S::Idle);
}

static void test_text_hotkey_masks_alt_menu() {
  Decision d = withAltText();
  d.onEvent(kd(ALT));
  d.onEvent(kd(KEY_T));
  d.onEvent(ku(KEY_T));
  Result r = d.onEvent(ku(ALT));
  CHECK(r.swallow);
  CHECK(r.injects.size() == 3);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[1], InjectKind::KeyUp, Btn::None, kMaskVk));
  CHECK(injectIs(r.injects[2], InjectKind::KeyUp, Btn::None, ALT));
}

static void test_alt_drag_still_opens_wheel_with_text_hotkey() {
  Decision d = withAltText();
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100));
  d.onEvent(mv(130, 100));
  CHECK(d.state() == S::Wheel);
  Result r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(findEmit(r, Emit::Kind::WheelRelease) != nullptr);
  CHECK(findEmit(r, Emit::Kind::TextRequested) == nullptr);
}

static void test_text_hotkey_off_when_vk_zero() {
  Decision d = withAltText(0);
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
  CHECK(!d.onEvent(ku(KEY_T)).swallow);
  // vk 0 is "off", not "any key": key code 0 with Alt held must not match the shortcut either.
  r = d.onEvent(kd(0));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
}

static void test_text_hotkey_needs_its_modifier() {
  Decision d = withAltText();
  Result r = d.onEvent(kd(KEY_T));  // plain T is ordinary typing
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
  CHECK(!d.onEvent(ku(KEY_T)).swallow);
}

// #100: T as the emote key and Alt+T as the text shortcut share a key. Alt+T opens the text box; T alone is the emote key.
static void test_text_hotkey_shares_its_key_with_a_custom_emote_key() {
  Config c;
  c.emoteTrigger = Trigger::CustomVk;
  c.emoteTriggerVk = KEY_T;
  c.textMods = ModAlt;
  c.textVk = KEY_T;
  Decision d;
  d.setConfig(c);
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(r.swallow && findEmit(r, Emit::Kind::TextRequested) != nullptr);
  r = d.onEvent(ku(KEY_T));
  CHECK(r.swallow && r.injects.empty());  // not typed afterwards as a held-back trigger tap
  r = d.onEvent(ku(ALT));
  CHECK(findEmit(r, Emit::Kind::WheelOpen) == nullptr && findEmit(r, Emit::Kind::Click) == nullptr);

  r = d.onEvent(kd(KEY_T));  // a plain tap still types T
  CHECK(r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
  r = d.onEvent(ku(KEY_T));
  CHECK(r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, KEY_T));
  CHECK(injectIs(r.injects[1], InjectKind::KeyUp, Btn::None, KEY_T));

  d.onEvent(kd(KEY_T));  // and T + drag opens the emote wheel
  CHECK(d.onEvent(md(Btn::Left, 0, 0)).swallow);
  CHECK(emitIs(findEmit(d.onEvent(mv(0, 40)), Emit::Kind::WheelOpen), WheelKind::Emote));
  CHECK(emitIs(findEmit(d.onEvent(mu(Btn::Left, 0, 40)), Emit::Kind::WheelRelease), WheelKind::Emote));
  CHECK(d.onEvent(ku(KEY_T)).swallow);
}

static void test_nothing_is_live_before_the_first_config() {
  Decision d;
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
  d.onEvent(ku(ALT));
  d.onEvent(ku(CTRL));
  r = d.onEvent(kd(TAB));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
}

static Decision withPanel(uint32_t panelVk = TAB) {
  Config c;
  c.panelVk = panelVk;
  Decision d;
  d.setConfig(c);
  return d;
}

static bool panelShows(const Result& r, bool show) {
  const Emit* e = findEmit(r, Emit::Kind::Panel);
  return e != nullptr && e->show == show;
}

static void test_panel_key_shows_on_press_and_hides_on_release() {
  Decision d = withPanel();
  Result r = d.onEvent(kd(TAB));
  CHECK(r.swallow && panelShows(r, true) && r.injects.empty());
  r = d.onEvent(kd(TAB));  // auto-repeat
  CHECK(r.swallow && r.emits.empty() && r.injects.empty());
  r = d.onEvent(kd(TAB));
  CHECK(r.swallow && r.emits.empty());
  r = d.onEvent(ku(TAB));
  CHECK(r.swallow && panelShows(r, false) && r.injects.empty());
  r = d.onEvent(kd(TAB));  // the next press shows it again
  CHECK(r.swallow && panelShows(r, true));
}

static void test_panel_key_with_modifier_passes() {
  for (const uint32_t mod : {ALT, CTRL, uint32_t{0xA0}, uint32_t{0x5B}}) {
    Decision d = withPanel();
    d.onEvent(kd(mod));
    Result r = d.onEvent(kd(TAB));
    CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
    r = d.onEvent(ku(TAB));
    CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  }
}

static void test_panel_key_passes_over_fullscreen_game() {
  Config c;
  c.panelVk = TAB;
  c.gameCheck = true;
  Decision d;
  d.setConfig(c);
  int probedX = -1, probedY = -1;
  bool fullscreen = true;
  d.setFullscreenProbe([&](int x, int y) {
    probedX = x;
    probedY = y;
    return fullscreen;
  });
  d.onEvent(mv(321, 654));
  Result r = d.onEvent(kd(TAB));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  CHECK(probedX == 321 && probedY == 654);  // asked about the screen under the last mouse position
  CHECK(!d.onEvent(ku(TAB)).swallow);
  fullscreen = false;
  r = d.onEvent(kd(TAB));
  CHECK(r.swallow && panelShows(r, true));
  d.onEvent(ku(TAB));
  c.gameCheck = false;  // gameCheck off: the probe is not asked
  d.setConfig(c);
  fullscreen = true;
  r = d.onEvent(kd(TAB));
  CHECK(r.swallow && panelShows(r, true));
}

static void test_panel_key_passes_when_off_or_paused() {
  Decision off = withPanel(0);
  Result r = off.onEvent(kd(TAB));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  CHECK(!off.onEvent(ku(TAB)).swallow);

  Decision paused = withPanel();
  paused.setSuspended(true);
  r = paused.onEvent(kd(TAB));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  CHECK(!paused.onEvent(ku(TAB)).swallow);

  Decision disabled = withPanel();
  disabled.setEnabled(false);
  r = disabled.onEvent(kd(TAB));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  CHECK(!disabled.onEvent(ku(TAB)).swallow);
}

static void test_panel_key_passes_when_it_is_a_wheel_trigger() {
  Config c;
  c.panelVk = TAB;
  c.trigger = Trigger::CustomVk;
  c.triggerVk = TAB;
  Decision d;
  d.setConfig(c);
  Result r = d.onEvent(kd(TAB));
  CHECK(findEmit(r, Emit::Kind::Panel) == nullptr);  // the wheel trigger keeps its key
  CHECK(r.swallow);
}

static void test_panel_key_up_after_config_change_is_swallowed() {
  Decision d = withPanel();
  CHECK(d.onEvent(kd(TAB)).swallow);
  Config off = d.config();
  off.panelVk = 0;  // left the room, or the feature went off, with Tab still held
  d.setConfig(off);
  Result r = d.onEvent(kd(TAB));  // repeats were never seen by the OS either
  CHECK(r.swallow && r.emits.empty());
  r = d.onEvent(ku(TAB));
  CHECK(r.swallow && panelShows(r, false));
  r = d.onEvent(kd(TAB));  // and the next Tab is ordinary again
  CHECK(!r.swallow && findEmit(r, Emit::Kind::Panel) == nullptr);
  CHECK(!d.onEvent(ku(TAB)).swallow);
}

static void test_panel_key_up_while_paused_is_swallowed() {
  Decision d = withPanel();
  d.onEvent(kd(TAB));
  d.setSuspended(true);
  Result r = d.onEvent(ku(TAB));
  CHECK(r.swallow && panelShows(r, false));
}

static void test_panel_hides_when_repeats_stop() {
  Decision d = withPanel();
  InputEvent down = kd(TAB);
  down.timeMs = 0;
  d.onEvent(down);
  CHECK(d.tick(1400).emits.empty());
  Result r = d.tick(1600);
  CHECK(panelShows(r, false));
  CHECK(d.tick(3000).emits.empty());  // hidden once
  r = d.onEvent(ku(TAB));  // the real up still never reaches the OS
  CHECK(r.swallow && r.emits.empty());
  r = d.onEvent(kd(TAB));
  CHECK(r.swallow && panelShows(r, true));
}

static void test_panel_stays_shown_while_another_key_is_pressed() {
  Decision d = withPanel();
  InputEvent down = kd(TAB);
  down.timeMs = 0;
  d.onEvent(down);
  // Windows stops Tab's repeats once Shift or W goes down: those presses keep the panel up.
  InputEvent other = kd(0x57);
  other.timeMs = 1000;
  CHECK(!d.onEvent(other).swallow);
  CHECK(d.tick(2000).emits.empty());
  CHECK(panelShows(d.tick(2600), false));
}

static void test_panel_repeats_keep_it_shown() {
  Decision d = withPanel();
  InputEvent down = kd(TAB);
  down.timeMs = 0;
  d.onEvent(down);
  down.timeMs = 1000;
  d.onEvent(down);
  down.timeMs = 2000;
  d.onEvent(down);
  CHECK(d.tick(3000).emits.empty());
  CHECK(panelShows(d.tick(3600), false));
}

static void test_panel_with_no_repeat_watchdog_stays_shown_through_a_long_hold() {
  Decision d = withPanel();
  d.setPanelRepeatGap(0);  // macOS and Linux: repeats are not a reliable sign the key is still down
  InputEvent down = kd(TAB);
  down.timeMs = 0;
  d.onEvent(down);
  CHECK(d.tick(60000).emits.empty());
  CHECK(d.tick(600000).emits.empty());
  Result r = d.onEvent(ku(TAB));
  CHECK(r.swallow && panelShows(r, false));
}

static void test_panel_repeat_gap_is_a_setting() {
  Decision d = withPanel();
  d.setPanelRepeatGap(3000);
  InputEvent down = kd(TAB);
  down.timeMs = 0;
  d.onEvent(down);
  CHECK(d.tick(2500).emits.empty());
  CHECK(panelShows(d.tick(3100), false));
}

static void test_release_panel_hides_it_and_keeps_the_up_swallowed() {
  Decision d = withPanel();
  CHECK(d.releasePanel().emits.empty());  // nothing shown: nothing to do
  d.onEvent(kd(TAB));
  Result r = d.releasePanel();  // the macOS event tap was disabled and enabled again
  CHECK(panelShows(r, false));
  CHECK(d.releasePanel().emits.empty());
  r = d.onEvent(ku(TAB));
  CHECK(r.swallow && r.emits.empty());
  r = d.onEvent(kd(TAB));
  CHECK(r.swallow && panelShows(r, true));
}

static void test_text_hotkey_ignored_while_paused() {
  Decision d = withAltText();
  d.setEnabled(false);
  d.onEvent(kd(ALT));
  Result r = d.onEvent(kd(KEY_T));
  CHECK(!r.swallow && findEmit(r, Emit::Kind::TextRequested) == nullptr);
  CHECK(!d.onEvent(ku(KEY_T)).swallow);
}

static void test_disabling_mid_drag_cancels_and_swallows_up() {
  Decision d;
  openWheel(d);
  Result r = d.setEnabled(false);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.state() == S::SwallowUp);
  CHECK(d.onEvent(mu(Btn::Left, 130, 100)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_config_change_mid_drag_cancels() {
  Decision d;
  openWheel(d);
  Result r = d.setConfig(Config{});
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.state() == S::SwallowUp);
}

static void test_lost_up_recovers_on_next_press() {
  Decision d;
  openWheel(d);
  d.setEnabled(false);  // -> SwallowUp, waiting for an up that never comes
  d.setEnabled(true);
  Result r = d.onEvent(md(Btn::Left, 5, 5));  // Alt still held
  CHECK(r.swallow);
  CHECK(d.state() == S::Pending);
}

static void test_lost_right_up_does_not_swallow_next_click() {
  Decision d;
  openWheel(d);
  CHECK(d.onEvent(md(Btn::Right, 130, 100)).swallow);  // cancels the wheel, arms the right-up swallow
  // The right-up never arrives (secure desktop, Win+L, UAC).
  d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(d.state() == S::Idle);
  CHECK(!d.onEvent(md(Btn::Right, 5, 5)).swallow);  // a new right-down means the old up is gone
  CHECK(!d.onEvent(mu(Btn::Right, 5, 5)).swallow);
}

static void test_lost_key_up_does_not_swallow_next_press() {
  Decision d;
  openWheel(d);
  CHECK(d.onEvent(kd(ESC)).swallow);  // cancels the wheel, arms the Esc-up swallow
  // The Esc-up never arrives.
  d.onEvent(mu(Btn::Left, 130, 100));
  d.onEvent(ku(ALT));
  CHECK(d.state() == S::Idle);
  CHECK(!d.onEvent(kd(ESC)).swallow);  // a later press that passes clears the stale entry
  CHECK(!d.onEvent(ku(ESC)).swallow);
}

static void test_button_held_before_trigger_passes_up() {
  Decision d;
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);
  d.onEvent(kd(ALT));
  CHECK(!d.onEvent(mv(50, 50)).swallow);
  CHECK(!d.onEvent(mu(Btn::Left, 50, 50)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_watchdog_cancels_stale_gesture() {
  Decision d;
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100, 1000));
  d.onEvent(mv(130, 100, 1100));
  CHECK(d.tick(5000).emits.empty());
  Result r = d.tick(1100 + kWatchdogMs + 1);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.state() == S::SwallowUp);  // the paired up must still be swallowed
  CHECK(d.onEvent(mu(Btn::Left, 130, 100)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_watchdog_from_pending_swallows_later_up() {
  Decision d;
  d.onEvent(kd(ALT));
  d.onEvent(md(Btn::Left, 100, 100, 1000));  // never moves past the threshold
  CHECK(d.state() == S::Pending);
  CHECK(d.tick(1000 + kWatchdogMs).emits.empty());  // exactly at the limit: not yet stale
  Result r = d.tick(1000 + kWatchdogMs + 1);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.state() == S::SwallowUp);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow && r.emits.empty() && r.injects.empty());
  CHECK(d.state() == S::Idle);
}

static void test_sync_clears_stale_trigger() {
  Decision d;
  d.onEvent(kd(ALT));  // the matching Alt-up is never seen (Win+L, UAC, hook reinstall...)
  d.syncKeyStates([](uint32_t) { return false; });
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_sync_keeps_keys_that_are_still_down() {
  Decision d;
  d.onEvent(kd(ALT));
  d.syncKeyStates([](uint32_t vk) { return vk == ALT; });
  CHECK(d.onEvent(md(Btn::Left, 1, 1)).swallow);
  CHECK(d.state() == S::Pending);
}

static void test_sync_never_sets_keys() {
  Decision d;
  d.syncKeyStates([](uint32_t) { return true; });  // OS says everything is down; we never saw a key-down
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_sync_keeps_swallowed_trigger_key() {
  Decision d = withTrigger(Trigger::CapsLock);
  CHECK(d.onEvent(kd(CAPS)).swallow);
  d.syncKeyStates([](uint32_t) { return false; });  // OS never saw Caps go down
  CHECK(d.onEvent(md(Btn::Left, 0, 0)).swallow);
  CHECK(d.state() == S::Pending);
}

static void test_ctrl_trigger_ignores_alt() {
  Decision d = withTrigger(Trigger::Ctrl);
  d.onEvent(kd(ALT));
  CHECK(!d.onEvent(md(Btn::Left, 1, 1)).swallow);
  d.onEvent(mu(Btn::Left, 1, 1));
  d.onEvent(ku(ALT));
  d.onEvent(kd(CTRL));
  CHECK(d.onEvent(md(Btn::Left, 1, 1)).swallow);
}

static void test_capslock_trigger_swallows_key() {
  Decision d = withTrigger(Trigger::CapsLock);
  CHECK(d.onEvent(kd(CAPS)).swallow);
  CHECK(d.onEvent(md(Btn::Left, 0, 0)).swallow);
  CHECK(findEmit(d.onEvent(mv(0, 40)), Emit::Kind::WheelOpen) != nullptr);
  CHECK(findEmit(d.onEvent(mu(Btn::Left, 0, 40)), Emit::Kind::WheelRelease) != nullptr);
  Result r = d.onEvent(ku(CAPS));
  CHECK(r.swallow && r.injects.empty());
}

static void test_custom_key_trigger() {
  Decision d = withTrigger(Trigger::CustomVk, KEY_V);
  CHECK(d.onEvent(kd(KEY_V)).swallow);
  CHECK(d.onEvent(md(Btn::Left, 0, 0)).swallow);
  CHECK(d.onEvent(ku(KEY_V)).swallow);
  d.setEnabled(false);
  CHECK(!d.onEvent(kd(KEY_V)).swallow);  // disabled: typing V works again
}

// Tap-through: a lone tap of a custom trigger key types it, replayed on release.
static void test_custom_key_tap_types_the_key() {
  constexpr uint32_t KEY_G = 0x47;
  Decision d = withTrigger(Trigger::CustomVk, KEY_G);
  Result r = d.onEvent(kd(KEY_G));
  CHECK(r.swallow && r.injects.empty());  // held back until we know what it is for
  CHECK(d.onEvent(kd(KEY_G)).swallow);    // auto-repeat while held back: still waiting
  r = d.onEvent(ku(KEY_G));
  CHECK(r.swallow && r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, KEY_G));
  CHECK(injectIs(r.injects[1], InjectKind::KeyUp, Btn::None, KEY_G));
  CHECK(d.state() == S::Idle);
}

// Tap-through: typing "gh" fast (H down before G up) keeps the order: G is flushed, then H is replayed behind it.
static void test_custom_key_rollover_keeps_typed_order() {
  constexpr uint32_t KEY_G = 0x47, KEY_H = 0x48;
  Decision d = withTrigger(Trigger::CustomVk, KEY_G);
  CHECK(d.onEvent(kd(KEY_G)).swallow);
  Result r = d.onEvent(kd(KEY_H));
  CHECK(r.swallow && r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, KEY_G));
  CHECK(injectIs(r.injects[1], InjectKind::KeyDown, Btn::None, KEY_H));
  CHECK(!d.onEvent(kd(KEY_G)).swallow);  // flushed: G's auto-repeat types
  r = d.onEvent(ku(KEY_G));
  CHECK(!r.swallow && r.injects.empty());  // the OS saw G down, so it must see the real up
  CHECK(!d.onEvent(ku(KEY_H)).swallow);
  // While G was typing, a click is not a gesture: it belongs to the text the user is in.
  CHECK(d.onEvent(kd(KEY_G)).swallow);  // a fresh press is held back again
  d.onEvent(kd(KEY_H));
  CHECK(!d.onEvent(md(Btn::Left, 0, 0)).swallow);
  d.onEvent(mu(Btn::Left, 0, 0));
  d.onEvent(ku(KEY_H));
  CHECK(!d.onEvent(ku(KEY_G)).swallow);
}

// Tap-through: Shift pressed while G is held sends g first, so the earlier letter isn't capitalised.
static void test_custom_key_flushes_before_modifier() {
  constexpr uint32_t KEY_G = 0x47, LSHIFT = 0xA0;
  Decision d = withTrigger(Trigger::CustomVk, KEY_G);
  d.onEvent(kd(KEY_G));
  Result r = d.onEvent(kd(LSHIFT));
  CHECK(r.swallow && r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::KeyDown, Btn::None, KEY_G));
  CHECK(injectIs(r.injects[1], InjectKind::KeyDown, Btn::None, LSHIFT));
  CHECK(!d.onEvent(ku(KEY_G)).swallow);
}

// Tap-through: a drag consumes the held-back key, so nothing is typed on release.
static void test_custom_key_drag_types_nothing() {
  constexpr uint32_t KEY_G = 0x47;
  Decision d = withTrigger(Trigger::CustomVk, KEY_G);
  d.onEvent(kd(KEY_G));
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(findEmit(d.onEvent(mv(140, 100)), Emit::Kind::WheelOpen) != nullptr);
  CHECK(findEmit(d.onEvent(mu(Btn::Left, 140, 100)), Emit::Kind::WheelRelease) != nullptr);
  Result r = d.onEvent(ku(KEY_G));
  CHECK(r.swallow && r.injects.empty());
}

// Caps Lock is not held back: a replayed tap would toggle it.
static void test_caps_lock_is_not_tapped_through() {
  Decision d = withTrigger(Trigger::CapsLock);
  CHECK(d.onEvent(kd(CAPS)).swallow);
  Result r = d.onEvent(ku(CAPS));
  CHECK(r.swallow && r.injects.empty());
}

static void test_mouse4_trigger_drags_with_side_button() {
  Decision d = withTrigger(Trigger::Mouse4);
  CHECK(!d.onEvent(md(Btn::Left, 0, 0)).swallow);
  d.onEvent(mu(Btn::Left, 0, 0));
  CHECK(d.onEvent(md(Btn::X1, 10, 10)).swallow);
  Result r = d.onEvent(mu(Btn::X1, 10, 10));  // click without drag: replay so browser Back still works
  CHECK(r.swallow && r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::ButtonDown, Btn::X1));
  CHECK(injectIs(r.injects[1], InjectKind::ButtonUp, Btn::X1));
  d.onEvent(md(Btn::X1, 10, 10));
  CHECK(findEmit(d.onEvent(mv(40, 10)), Emit::Kind::WheelOpen) != nullptr);
  CHECK(findEmit(d.onEvent(mu(Btn::X1, 40, 10)), Emit::Kind::WheelRelease) != nullptr);
}

static void test_ctrl_drag_opens_emote_wheel() {
  Decision d = withEmote();
  CHECK(!d.onEvent(kd(CTRL)).swallow);
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(d.state() == S::Pending);
  Result r = d.onEvent(mv(130, 100));
  const Emit* open = findEmit(r, Emit::Kind::WheelOpen);
  CHECK(emitIs(open, WheelKind::Emote) && open->x == 100 && open->y == 100);
  CHECK(emitIs(findEmit(r, Emit::Kind::WheelMove), WheelKind::Emote));
  CHECK(emitIs(findEmit(d.onEvent(mv(135, 90)), Emit::Kind::WheelMove), WheelKind::Emote));
  r = d.onEvent(mu(Btn::Left, 140, 90));
  CHECK(r.swallow);
  const Emit* rel = findEmit(r, Emit::Kind::WheelRelease);
  CHECK(emitIs(rel, WheelKind::Emote) && rel->x == 140 && rel->y == 90);
  CHECK(d.state() == S::Idle);
}

static void test_alt_drag_is_still_the_ping_wheel() {
  Decision d = withEmote();
  CHECK(!d.onEvent(kd(ALT)).swallow);
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);
  Result r = d.onEvent(mv(130, 100));
  CHECK(emitIs(findEmit(r, Emit::Kind::WheelOpen), WheelKind::Ping));
  CHECK(emitIs(findEmit(r, Emit::Kind::WheelMove), WheelKind::Ping));
  r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(r.swallow);
  CHECK(emitIs(findEmit(r, Emit::Kind::WheelRelease), WheelKind::Ping));
  CHECK(d.state() == S::Idle);
}

static void test_both_triggers_held_pass_through() {
  Decision d = withEmote();
  d.onEvent(kd(ALT));
  d.onEvent(kd(CTRL));
  Result r = d.onEvent(md(Btn::Left, 100, 100));
  CHECK(!r.swallow && r.emits.empty() && r.injects.empty());
  CHECK(d.state() == S::Idle);
  r = d.onEvent(mv(150, 100));
  CHECK(!r.swallow && r.emits.empty());
  r = d.onEvent(mu(Btn::Left, 150, 100));
  CHECK(!r.swallow && r.emits.empty() && r.injects.empty());
  r = d.onEvent(ku(ALT));  // nothing was swallowed, so the Alt-up needs no mask
  CHECK(!r.swallow && r.injects.empty());
}

static void test_emote_click_on_and_off() {
  {
    Decision d = withEmote(Trigger::Ctrl, 0, true);
    d.onEvent(kd(CTRL));
    CHECK(d.onEvent(md(Btn::Left, 50, 60)).swallow);
    Result r = d.onEvent(mu(Btn::Left, 51, 60));
    CHECK(r.swallow && r.injects.empty());
    const Emit* c = findEmit(r, Emit::Kind::Click);
    CHECK(emitIs(c, WheelKind::Emote) && c->x == 50 && c->y == 60);
  }
  {
    Decision d = withEmote();
    d.onEvent(kd(CTRL));
    CHECK(d.onEvent(md(Btn::Left, 50, 60)).swallow);
    Result r = d.onEvent(mu(Btn::Left, 50, 60));
    CHECK(r.swallow && r.emits.empty());
    CHECK(r.injects.size() == 2);
    CHECK(injectIs(r.injects[0], InjectKind::ButtonDown, Btn::Left));
    CHECK(injectIs(r.injects[1], InjectKind::ButtonUp, Btn::Left));
  }
  {
    // Each wheel follows its own click setting: click pings on, emote click off.
    Config c;
    c.clickPing = true;
    c.emoteTrigger = Trigger::Ctrl;
    Decision d;
    d.setConfig(c);
    d.onEvent(kd(CTRL));
    d.onEvent(md(Btn::Left, 50, 60));
    Result r = d.onEvent(mu(Btn::Left, 50, 60));
    CHECK(r.emits.empty() && r.injects.size() == 2);
    d.onEvent(ku(CTRL));
    d.onEvent(kd(ALT));
    d.onEvent(md(Btn::Left, 50, 60));
    r = d.onEvent(mu(Btn::Left, 50, 60));
    CHECK(emitIs(findEmit(r, Emit::Kind::Click), WheelKind::Ping) && r.injects.empty());
  }
  {
    // Ctrl released before the button: the emote click is placed, or the click replayed.
    Decision on = withEmote(Trigger::Ctrl, 0, true);
    on.onEvent(kd(CTRL));
    on.onEvent(md(Btn::Left, 100, 100));
    const Result up = on.onEvent(ku(CTRL));  // keep the Result alive: c points into it
    const Emit* c = findEmit(up, Emit::Kind::Click);
    CHECK(emitIs(c, WheelKind::Emote) && c->x == 100);
    CHECK(on.onEvent(mu(Btn::Left, 100, 100)).swallow);
    Decision off = withEmote();
    off.onEvent(kd(CTRL));
    off.onEvent(md(Btn::Left, 100, 100));
    Result r = off.onEvent(ku(CTRL));
    CHECK(r.injects.size() == 1 && injectIs(r.injects[0], InjectKind::ButtonDown, Btn::Left));
    CHECK(off.state() == S::Idle);
    CHECK(!off.onEvent(mu(Btn::Left, 100, 100)).swallow);
  }
}

static void test_escape_and_right_click_cancel_emote_gesture() {
  Decision d = withEmote();
  openEmoteWheel(d);
  Result r = d.onEvent(kd(ESC));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.onEvent(ku(ESC)).swallow);
  r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(r.swallow && r.emits.empty());
  CHECK(d.state() == S::Idle);

  d.onEvent(md(Btn::Left, 100, 100));  // Ctrl still held
  CHECK(d.state() == S::Pending);
  r = d.onEvent(md(Btn::Right, 100, 100));
  CHECK(r.swallow);
  CHECK(findEmit(r, Emit::Kind::Cancel) != nullptr);
  CHECK(d.onEvent(mu(Btn::Right, 100, 100)).swallow);
  r = d.onEvent(mu(Btn::Left, 100, 100));
  CHECK(r.swallow && r.emits.empty() && r.injects.empty());
  CHECK(d.state() == S::Idle);
}

static void test_emote_trigger_none_ignores_ctrl_drag() {
  Decision d = withEmote(Trigger::None);
  d.onEvent(kd(CTRL));
  CHECK(!d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(d.onEvent(mv(150, 100)).emits.empty());
  CHECK(!d.onEvent(mu(Btn::Left, 150, 100)).swallow);
  CHECK(d.state() == S::Idle);
}

static void test_custom_emote_key_is_swallowed() {
  Decision d = withEmote(Trigger::CustomVk, KEY_T);
  CHECK(d.onEvent(kd(KEY_T)).swallow);
  CHECK(d.onEvent(md(Btn::Left, 0, 0)).swallow);
  CHECK(emitIs(findEmit(d.onEvent(mv(0, 40)), Emit::Kind::WheelOpen), WheelKind::Emote));
  CHECK(emitIs(findEmit(d.onEvent(mu(Btn::Left, 0, 40)), Emit::Kind::WheelRelease), WheelKind::Emote));
  CHECK(d.onEvent(ku(KEY_T)).swallow);
  CHECK(!d.onEvent(kd(KEY_V)).swallow);  // other keys still type
  d.onEvent(ku(KEY_V));
  d.setEnabled(false);
  CHECK(!d.onEvent(kd(KEY_T)).swallow);  // disabled: typing T works again
  CHECK(!d.onEvent(ku(KEY_T)).swallow);
}

static void test_mouse5_emote_beside_alt_ping() {
  Decision d = withEmote(Trigger::Mouse5);
  CHECK(!d.onEvent(md(Btn::Left, 0, 0)).swallow);  // no key held: a plain click
  d.onEvent(mu(Btn::Left, 0, 0));
  CHECK(d.onEvent(md(Btn::X2, 10, 10)).swallow);
  CHECK(emitIs(findEmit(d.onEvent(mv(40, 10)), Emit::Kind::WheelOpen), WheelKind::Emote));
  Result r = d.onEvent(mu(Btn::X2, 40, 10));
  CHECK(r.swallow && emitIs(findEmit(r, Emit::Kind::WheelRelease), WheelKind::Emote));

  d.onEvent(kd(ALT));
  CHECK(d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(emitIs(findEmit(d.onEvent(mv(130, 100)), Emit::Kind::WheelOpen), WheelKind::Ping));
  CHECK(emitIs(findEmit(d.onEvent(mu(Btn::Left, 130, 100)), Emit::Kind::WheelRelease), WheelKind::Ping));

  // With Alt still held, the side button is only the emote trigger.
  CHECK(d.onEvent(md(Btn::X2, 10, 10)).swallow);
  CHECK(emitIs(findEmit(d.onEvent(mv(40, 10)), Emit::Kind::WheelOpen), WheelKind::Emote));
  d.onEvent(mu(Btn::X2, 40, 10));
  CHECK(d.state() == S::Idle);

  // A side-button click without a drag is replayed (emote click off), so browser Forward still works.
  d.onEvent(md(Btn::X2, 10, 10));
  r = d.onEvent(mu(Btn::X2, 10, 10));
  CHECK(r.swallow && r.injects.size() == 2);
  CHECK(injectIs(r.injects[0], InjectKind::ButtonDown, Btn::X2));
  CHECK(injectIs(r.injects[1], InjectKind::ButtonUp, Btn::X2));
}

static void test_pause_stops_both_wheels() {
  Decision d = withEmote();
  d.onEvent(kd(CTRL));
  d.onEvent(kd(ALT));
  CHECK(findEmit(d.onEvent(kd(KEY_P)), Emit::Kind::Toggled) != nullptr);
  CHECK(!d.enabled());
  d.onEvent(ku(KEY_P));
  d.onEvent(ku(ALT));  // Ctrl alone is still held
  CHECK(!d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(d.onEvent(mv(150, 100)).emits.empty());
  CHECK(!d.onEvent(mu(Btn::Left, 150, 100)).swallow);
  d.onEvent(ku(CTRL));
  d.onEvent(kd(ALT));
  CHECK(!d.onEvent(md(Btn::Left, 100, 100)).swallow);
  CHECK(!d.onEvent(mu(Btn::Left, 100, 100)).swallow);
}

static void test_releasing_emote_trigger_mid_wheel_keeps_wheel() {
  Decision d = withEmote();
  openEmoteWheel(d);
  d.onEvent(kd(ALT));  // the other wheel's trigger doesn't touch this gesture
  CHECK(d.onEvent(ku(ALT)).emits.empty());
  CHECK(d.state() == S::Wheel);
  CHECK(d.onEvent(ku(CTRL)).emits.empty());
  CHECK(d.state() == S::Wheel);
  Result r = d.onEvent(mu(Btn::Left, 130, 100));
  CHECK(r.swallow && emitIs(findEmit(r, Emit::Kind::WheelRelease), WheelKind::Emote));
  CHECK(d.state() == S::Idle);
}

static void test_parse_config_emote_fields() {
  const Config cur;
  Command c = parseCommand(R"({"type":"config","emoteTrigger":"off"})", cur);
  CHECK(c.kind == Command::Kind::Config && c.config.emoteTrigger == Trigger::None);
  c = parseCommand(R"({"type":"config","emoteTrigger":"mouse5","emoteClick":true})", cur);
  CHECK(c.kind == Command::Kind::Config && c.config.emoteTrigger == Trigger::Mouse5 && c.config.emoteClick);
  c = parseCommand(R"({"type":"config","emoteTrigger":"vk","emoteTriggerVk":84,"emoteClick":false})", cur);
  CHECK(c.config.emoteTrigger == Trigger::CustomVk && c.config.emoteTriggerVk == 84 && !c.config.emoteClick);
  c = parseCommand(R"({"type":"config","trigger":"alt","emoteTrigger":"ctrl"})", cur);
  CHECK(c.config.trigger == Trigger::Alt && c.config.emoteTrigger == Trigger::Ctrl);
  Config set;
  set.emoteTrigger = Trigger::Shift;
  set.emoteTriggerVk = 7;
  set.emoteClick = true;
  c = parseCommand(R"({"type":"config"})", set);  // missing fields keep their current values
  CHECK(c.config.emoteTrigger == Trigger::Shift && c.config.emoteTriggerVk == 7 && c.config.emoteClick);
  CHECK(parseCommand(R"({"type":"config","emoteTrigger":"bogus"})", cur).kind == Command::Kind::Invalid);
  CHECK(parseCommand(R"({"type":"config","trigger":"off"})", cur).kind == Command::Kind::Invalid);  // pings always have a trigger
}

static void test_parse_config_text_hotkey() {
  const Config cur;
  const Command c = parseCommand(R"({"type":"config","textMods":9,"textVk":89})", cur);
  CHECK(c.kind == Command::Kind::Config && c.config.textMods == 9 && c.config.textVk == 89);
}

static void test_parse_config_panel_key() {
  const Config cur;
  CHECK(cur.panelVk == 0 && cur.textVk == 0);
  const Command c = parseCommand(R"({"type":"config","panelVk":9})", cur);
  CHECK(c.kind == Command::Kind::Config && c.config.panelVk == 9);
  const Command keep = parseCommand(R"({"type":"config"})", c.config);
  CHECK(keep.config.panelVk == 9);
  const Command front = parseCommand(R"({"type":"getForegroundApp"})", c.config);
  CHECK(front.kind == Command::Kind::ForegroundApp);
  const Command list = parseCommand(R"({"type":"getAppList"})", c.config);
  CHECK(list.kind == Command::Kind::AppList);
}

static void test_json_parses_flat_objects() {
  std::map<std::string, std::string> m;
  CHECK(parseFlatJson(R"({"type":"config","enabled":true,"dragThresholdPx":8,"trigger":"alt"})", m));
  CHECK(m["type"] == "config" && m["enabled"] == "true" && m["dragThresholdPx"] == "8" && m["trigger"] == "alt");
  CHECK(parseFlatJson(R"( { "msg" : "a\"b\\c" } )", m) && m["msg"] == "a\"b\\c");
  CHECK(parseFlatJson("{}", m) && m.empty());
}

static void test_json_rejects_bad_input() {
  std::map<std::string, std::string> m;
  CHECK(!parseFlatJson("", m));
  CHECK(!parseFlatJson("not json", m));
  CHECK(!parseFlatJson(R"({"a":{"b":1}})", m));
  CHECK(!parseFlatJson(R"({"a":[1]})", m));
  CHECK(!parseFlatJson(R"({"a":1)", m));
  CHECK(!parseFlatJson(R"({"a":1} trailing)", m));
}

static void test_json_escape() { CHECK(jsonEscape("a\"b\\c\n") == "a\\\"b\\\\c\\n"); }

static void test_format_emit() {
  Emit open{Emit::Kind::WheelOpen};
  open.x = 1;
  open.y = -2;
  CHECK(formatEmit(open) == R"({"type":"wheelOpen","x":1,"y":-2,"wheel":"ping"})");
  Emit toggled{Emit::Kind::Toggled};
  toggled.enabled = true;
  CHECK(formatEmit(toggled) == R"({"type":"toggled","enabled":true})");
  CHECK(formatEmit(Emit{Emit::Kind::Cancel}) == R"({"type":"cancel"})");
  CHECK(formatEmit(Emit{Emit::Kind::TextRequested}) == R"({"type":"textRequested"})");
  Emit panel{Emit::Kind::Panel};
  panel.show = true;
  CHECK(formatEmit(panel) == R"({"type":"panel","show":true})");
  panel.show = false;
  CHECK(formatEmit(panel) == R"({"type":"panel","show":false})");
}

static void test_format_emit_includes_wheel() {
  Emit open{Emit::Kind::WheelOpen};
  open.x = 1;
  open.y = 2;
  open.wheel = WheelKind::Emote;
  CHECK(formatEmit(open) == R"({"type":"wheelOpen","x":1,"y":2,"wheel":"emote"})");
  Emit click{Emit::Kind::Click};
  click.x = 3;
  click.y = 4;
  CHECK(formatEmit(click) == R"({"type":"click","x":3,"y":4,"wheel":"ping"})");
  click.wheel = WheelKind::Emote;
  CHECK(formatEmit(click) == R"({"type":"click","x":3,"y":4,"wheel":"emote"})");
  for (const auto k : {Emit::Kind::WheelMove, Emit::Kind::WheelRelease}) {
    Emit e{k};
    e.wheel = WheelKind::Emote;
    CHECK(formatEmit(e).find(R"(,"wheel":"emote"})") != std::string::npos);
  }
}

// Review focus: a frozen Electron must never stall the hook thread.
static void test_output_never_blocks_producer() {
  std::mutex m;
  std::condition_variable cv;
  bool release = false;
  size_t written = 0;
  Output out(
      [&](const std::string&) {
        std::unique_lock<std::mutex> lk(m);
        cv.wait(lk, [&] { return release; });
        ++written;
        return true;
      },
      100);
  const auto start = std::chrono::steady_clock::now();
  for (int i = 0; i < 10000; ++i) out.line("x");
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
  CHECK(ms < 500);
  CHECK(out.dropped() >= 10000 - 101);
  {
    std::lock_guard<std::mutex> lk(m);
    release = true;
  }
  cv.notify_all();
  out.stop();
  CHECK(written + out.dropped() == 10000);
}

static void test_mask_menu_keys_off_leaves_alt_up_alone() {
  Decision d;
  d.setMaskMenuKeys(false);
  openWheel(d);
  d.onEvent(mu(Btn::Left, 130, 100));
  Result r = d.onEvent(ku(ALT));
  CHECK(!r.swallow && r.injects.empty());
}

static void test_mac_keycodes_map_to_vks() {
  CHECK(mac::keyCodeToVk(0x23) == KEY_P);
  CHECK(mac::keyCodeToVk(0x00) == 'A');
  CHECK(mac::keyCodeToVk(0x1D) == '0');
  CHECK(mac::keyCodeToVk(0x35) == ESC);
  CHECK(mac::keyCodeToVk(0x7A) == 0x70);  // F1
  CHECK(mac::keyCodeToVk(0x5A) == 0x83);  // F20
  CHECK(mac::keyCodeToVk(0x7B) == 0x25);  // left arrow
  CHECK(mac::keyCodeToVk(0x3F) == 0);     // fn has no VK
  CHECK(mac::vkToKeyCode(KEY_P) == 0x23);
  CHECK(mac::vkToKeyCode(0x0D) == 0x24);  // Return, not keypad Enter
  CHECK(mac::vkToKeyCode(ALT) == 0x3A);
  CHECK(mac::vkToKeyCode(0x87) == -1);    // F24 doesn't exist on a Mac
  for (uint16_t code = 0; code < 0x80; ++code) {
    const uint32_t vk = mac::keyCodeToVk(code);
    if (vk != 0 && code != 0x4C) CHECK(mac::vkToKeyCode(vk) == code);  // round trip (keypad Enter shares Return's VK)
  }
}

static void test_mac_modifier_held() {
  using namespace mac;
  CHECK(modifierHeld(kFlagOption | kDevLAlt, 0xA4));
  CHECK(!modifierHeld(kFlagOption | kDevLAlt, 0xA5));
  CHECK(modifierHeld(kFlagOption | kDevRAlt, 0xA5));
  CHECK(modifierHeld(kFlagOption, 0xA4));            // synthetic event without side bits: left
  CHECK(!modifierHeld(kFlagOption, 0xA5));
  CHECK(!modifierHeld(kDevLAlt, 0xA4));              // stale side bit with the group up
  CHECK(modifierHeld(kFlagCommand | kDevRCmd, 0x5C));
  CHECK(modifierHeld(kFlagControl | kDevRCtrl, 0xA3));
  CHECK(!modifierHeld(kFlagShift | kDevLShift, 'A'));
}

static void test_mac_modifier_transitions() {
  using namespace mac;
  auto t = modifierTransitions(0, kFlagOption | kDevLAlt);
  CHECK(t.size() == 1 && t[0].vk == 0xA4 && t[0].down);
  t = modifierTransitions(kFlagOption | kDevLAlt, 0);
  CHECK(t.size() == 1 && t[0].vk == 0xA4 && !t[0].down);
  // Option released and Control pressed in one step: ups come first.
  t = modifierTransitions(kFlagOption | kDevLAlt, kFlagControl | kDevLCtrl);
  CHECK(t.size() == 2 && t[0].vk == 0xA4 && !t[0].down && t[1].vk == 0xA2 && t[1].down);
  // Right Command added to left Command.
  t = modifierTransitions(kFlagCommand | kDevLCmd, kFlagCommand | kDevLCmd | kDevRCmd);
  CHECK(t.size() == 1 && t[0].vk == 0x5C && t[0].down);
  CHECK(modifierTransitions(kFlagShift | kDevLShift, kFlagShift | kDevLShift).empty());
}

static void test_mac_option_drag_through_transitions() {
  // The Mac hook feeds flag transitions to Decision as key events: Option + drag must open the wheel.
  Decision d;
  d.setMaskMenuKeys(false);
  for (const auto& k : mac::modifierTransitions(0, mac::kFlagOption | mac::kDevLAlt)) {
    d.onEvent(k.down ? kd(k.vk) : ku(k.vk));
  }
  CHECK(d.onEvent(md(Btn::Left, 10, 10)).swallow);
  Result r = d.onEvent(mv(40, 10));
  CHECK(findEmit(r, Emit::Kind::WheelOpen) != nullptr);
}

int main() {
  test_json_parses_flat_objects();
  test_json_rejects_bad_input();
  test_json_escape();
  test_format_emit();
  test_format_emit_includes_wheel();
  test_parse_config_emote_fields();
  test_parse_config_text_hotkey();
  test_parse_config_panel_key();
  test_output_never_blocks_producer();
  test_alt_drag_opens_wheel_and_releases();
  test_plain_click_passes_through();
  test_alt_click_replays_when_click_ping_off();
  test_alt_click_pings_when_click_ping_on();
  test_self_injected_events_are_ignored();
  test_right_click_cancels_wheel();
  test_right_click_with_alt_but_no_gesture_passes();
  test_escape_cancels_wheel();
  test_trigger_released_during_wheel_keeps_wheel();
  test_trigger_released_during_pending_replays_click_after_mask();
  test_trigger_released_during_pending_pings_when_click_ping_on();
  test_alt_up_after_gesture_is_masked();
  test_plain_alt_tap_is_not_masked();
  test_alt_tab_clicks_pass_through();
  test_alt_tab_click_places_no_ping_even_with_click_ping_on();
  test_win_tab_clicks_pass_through_and_sync_clears_flag();
  test_fullscreen_game_keeps_the_click();
  test_fullscreen_probe_ignored_when_disabled();
  test_skipped_app_stands_down();
  test_skip_apps_empty_never_queries();
  test_skip_apps_live_update();
  test_toggle_hotkey_disables_and_enables();
  test_hotkey_autorepeat_toggles_once();
  test_hotkey_ignored_while_suspended();
  test_text_hotkey_requests_once();
  test_text_hotkey_ignored_while_suspended();
  test_text_hotkey_fires_with_alt_trigger();
  test_text_hotkey_masks_alt_menu();
  test_alt_drag_still_opens_wheel_with_text_hotkey();
  test_text_hotkey_off_when_vk_zero();
  test_text_hotkey_needs_its_modifier();
  test_text_hotkey_shares_its_key_with_a_custom_emote_key();
  test_nothing_is_live_before_the_first_config();
  test_panel_key_shows_on_press_and_hides_on_release();
  test_panel_key_with_modifier_passes();
  test_panel_key_passes_over_fullscreen_game();
  test_panel_key_passes_when_off_or_paused();
  test_panel_key_passes_when_it_is_a_wheel_trigger();
  test_panel_key_up_after_config_change_is_swallowed();
  test_panel_key_up_while_paused_is_swallowed();
  test_panel_hides_when_repeats_stop();
  test_panel_stays_shown_while_another_key_is_pressed();
  test_panel_repeats_keep_it_shown();
  test_panel_with_no_repeat_watchdog_stays_shown_through_a_long_hold();
  test_panel_repeat_gap_is_a_setting();
  test_release_panel_hides_it_and_keeps_the_up_swallowed();
  test_text_hotkey_ignored_while_paused();
  test_disabling_mid_drag_cancels_and_swallows_up();
  test_config_change_mid_drag_cancels();
  test_lost_up_recovers_on_next_press();
  test_lost_right_up_does_not_swallow_next_click();
  test_lost_key_up_does_not_swallow_next_press();
  test_button_held_before_trigger_passes_up();
  test_watchdog_cancels_stale_gesture();
  test_watchdog_from_pending_swallows_later_up();
  test_sync_clears_stale_trigger();
  test_sync_keeps_keys_that_are_still_down();
  test_sync_never_sets_keys();
  test_sync_keeps_swallowed_trigger_key();
  test_ctrl_trigger_ignores_alt();
  test_capslock_trigger_swallows_key();
  test_custom_key_trigger();
  test_custom_key_tap_types_the_key();
  test_custom_key_rollover_keeps_typed_order();
  test_custom_key_flushes_before_modifier();
  test_custom_key_drag_types_nothing();
  test_caps_lock_is_not_tapped_through();
  test_mouse4_trigger_drags_with_side_button();
  test_ctrl_drag_opens_emote_wheel();
  test_alt_drag_is_still_the_ping_wheel();
  test_both_triggers_held_pass_through();
  test_emote_click_on_and_off();
  test_escape_and_right_click_cancel_emote_gesture();
  test_emote_trigger_none_ignores_ctrl_drag();
  test_custom_emote_key_is_swallowed();
  test_mouse5_emote_beside_alt_ping();
  test_pause_stops_both_wheels();
  test_releasing_emote_trigger_mid_wheel_keeps_wheel();
  test_mask_menu_keys_off_leaves_alt_up_alone();
  test_mac_keycodes_map_to_vks();
  test_mac_modifier_held();
  test_mac_modifier_transitions();
  test_mac_option_drag_through_transitions();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
