// Unit tests for the Linux evdev backend's pure logic (key tables, classification, the frame filter).
// Linux only: built and run by build.sh on Linux. The device glue (hooks_evdev.cpp) needs real devices.
#include <X11/keysym.h>

#include <cstdio>
#include <string>
#include <vector>

#include "../src/decision.h"
#include "../src/evdev_logic.h"
#include "../src/linuxinput.h"
#include "../src/output.h"

using namespace lp;
using namespace lp::evdev;

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

constexpr DeviceId kKbd = 1;
constexpr DeviceId kMouse = 2;
constexpr DeviceId kMouse2 = 3;

Event ev(uint16_t type, uint16_t code, int32_t value) { return Event{type, code, value}; }
Event key(uint16_t code, int32_t value) { return ev(EV_KEY, code, value); }
Event rel(uint16_t code, int32_t value) { return ev(EV_REL, code, value); }
Event scan(int32_t value = 0x90001) { return ev(EV_MSC, MSC_SCAN, value); }

Frame frame(std::initializer_list<Event> events) {
  Frame f(events);
  f.push_back(ev(EV_SYN, SYN_REPORT, 0));
  return f;
}

bool same(const Frame& a, const Frame& b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (a[i].type != b[i].type || a[i].code != b[i].code || a[i].value != b[i].value) return false;
  }
  return true;
}

std::vector<std::string> lines(const Step& s) {
  std::vector<std::string> v;
  for (const auto& m : s.messages) v.push_back(m.text());
  return v;
}

bool only(const Step& s, const std::string& line) { return lines(s) == std::vector<std::string>{line}; }

const std::string kWant = R"({"type":"pointer","want":true})";
const std::string kUnwant = R"({"type":"pointer","want":false})";

// A keyboard (1) and two mice (2, 3) under the default config: Alt + left drag is the ping wheel.
struct Rig {
  Decision decision;
  EvdevCore core{decision};
  uint64_t t = 1000;

  explicit Rig(bool enabled = true) {
    decision.setMaskMenuKeys(false);
    Config c;
    c.enabled = enabled;
    decision.setConfig(c);
    core.addDevice(kKbd, DeviceKind::Keyboard);
    core.addDevice(kMouse, DeviceKind::Mouse);
    core.addDevice(kMouse2, DeviceKind::Mouse);
  }
  Step send(DeviceId dev, const Frame& f) {
    t += 10;
    return core.onFrame(dev, f, t);
  }
  // A frame that must go through exactly as it came.
  bool passes(DeviceId dev, const Frame& f) {
    const Step s = send(dev, f);
    return s.writes.size() == 1 && s.writes[0].device == dev && same(s.writes[0].frame, f) && s.messages.empty();
  }
};

DeviceCaps keyboardCaps() {
  DeviceCaps c;
  c.name = "Test Keyboard";
  c.ev.set(EV_KEY);
  for (int k = KEY_ESC; k <= KEY_KPDOT; ++k) c.key.set(static_cast<size_t>(k));
  return c;
}

DeviceCaps mouseCaps() {
  DeviceCaps c;
  c.name = "Test Mouse";
  c.ev.set(EV_KEY);
  c.ev.set(EV_REL);
  c.key.set(BTN_LEFT);
  c.key.set(BTN_RIGHT);
  c.key.set(BTN_MIDDLE);
  c.rel.set(REL_X);
  c.rel.set(REL_Y);
  c.rel.set(REL_WHEEL);
  return c;
}

void test_plain_mouse_click_passes_unchanged() {
  Rig r;
  CHECK(r.passes(kMouse, frame({scan(), key(BTN_LEFT, 1)})));
  CHECK(r.passes(kMouse, frame({scan(), key(BTN_LEFT, 0)})));
  CHECK(r.passes(kMouse, frame({rel(REL_X, 4), rel(REL_Y, -2)})));
  CHECK(r.passes(kMouse, frame({rel(REL_WHEEL, 1)})));
  CHECK(!r.core.pointerWanted());
}

void test_plain_typing_passes_unchanged_and_repeats_are_forwarded() {
  Rig r;
  CHECK(r.passes(kKbd, frame({scan(0x1e), key(KEY_A, 1)})));
  CHECK(r.passes(kKbd, frame({scan(0x1e), key(KEY_A, 2)})));
  CHECK(r.passes(kKbd, frame({scan(0x1e), key(KEY_A, 2)})));
  CHECK(r.passes(kKbd, frame({scan(0x1e), key(KEY_A, 0)})));
  CHECK(r.passes(kKbd, frame({key(KEY_LEFTSHIFT, 1)})));
  CHECK(r.passes(kKbd, frame({key(KEY_LEFTSHIFT, 0)})));
}

void test_keys_without_a_vk_pass_unchanged() {
  Rig r;
  CHECK(r.passes(kKbd, frame({key(KEY_VOLUMEUP, 1)})));
  CHECK(r.passes(kKbd, frame({key(KEY_VOLUMEUP, 0)})));
  CHECK(r.passes(kMouse, frame({key(BTN_TASK, 1)})));
}

void test_alt_drag_is_swallowed_and_reported_relative_to_the_press() {
  Rig r;
  CHECK(r.passes(kKbd, frame({key(KEY_LEFTALT, 1)})));
  CHECK(r.passes(kMouse, frame({rel(REL_X, 100), rel(REL_Y, 50)})));  // the pointer is somewhere: only the press counts

  Step s = r.send(kMouse, frame({scan(), key(BTN_LEFT, 1)}));
  CHECK(s.writes.empty());  // the press, and the scan code that announced it, never reach the clone
  CHECK(only(s, kWant));
  CHECK(r.core.pointerWanted());

  const Frame small = frame({rel(REL_X, 3), rel(REL_Y, 4)});  // 5 counts: under the drag threshold
  s = r.send(kMouse, small);
  CHECK(s.writes.size() == 1 && same(s.writes[0].frame, small) && s.messages.empty());

  const Frame far = frame({rel(REL_X, 10), rel(REL_Y, 0)});
  s = r.send(kMouse, far);
  CHECK(s.writes.size() == 1 && same(s.writes[0].frame, far));  // the motion still moves the real pointer
  CHECK(lines(s) == (std::vector<std::string>{R"({"type":"wheelOpen","x":0,"y":0,"wheel":"ping","rel":true})",
                                              R"({"type":"wheelMove","x":13,"y":4,"wheel":"ping","rel":true})"}));

  s = r.send(kMouse, frame({rel(REL_X, 2), rel(REL_Y, 1)}));
  CHECK(only(s, R"({"type":"wheelMove","x":15,"y":5,"wheel":"ping","rel":true})"));

  s = r.send(kMouse, frame({scan(), key(BTN_LEFT, 0)}));
  CHECK(s.writes.empty());
  CHECK(lines(s) == (std::vector<std::string>{R"({"type":"wheelRelease","x":15,"y":5,"wheel":"ping","rel":true})", kUnwant}));
  CHECK(!r.core.pointerWanted());

  s = r.send(kKbd, frame({key(KEY_LEFTALT, 0)}));  // the key itself always passes
  CHECK(s.writes.size() == 1 && s.writes[0].device == kKbd);
}

void test_a_second_gesture_is_measured_from_its_own_press() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  r.send(kMouse, frame({key(BTN_LEFT, 1)}));
  r.send(kMouse, frame({rel(REL_X, 20)}));
  r.send(kMouse, frame({key(BTN_LEFT, 0)}));
  r.send(kMouse, frame({rel(REL_X, 500), rel(REL_Y, 500)}));
  r.send(kMouse, frame({key(BTN_LEFT, 1)}));
  Step s = r.send(kMouse, frame({rel(REL_X, -9), rel(REL_Y, 0)}));
  CHECK(lines(s) == (std::vector<std::string>{R"({"type":"wheelOpen","x":0,"y":0,"wheel":"ping","rel":true})",
                                              R"({"type":"wheelMove","x":-9,"y":0,"wheel":"ping","rel":true})"}));
}

void test_a_short_trigger_click_is_replayed_on_the_clone_of_the_mouse_that_made_it() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  Step s = r.send(kMouse2, frame({scan(), key(BTN_LEFT, 1)}));
  CHECK(s.writes.empty() && only(s, kWant));
  s = r.send(kMouse2, frame({scan(), key(BTN_LEFT, 0)}));
  CHECK(s.writes.size() == 2);
  if (s.writes.size() == 2) {
    CHECK(s.writes[0].device == kMouse2 && same(s.writes[0].frame, frame({key(BTN_LEFT, 1)})));
    CHECK(s.writes[1].device == kMouse2 && same(s.writes[1].frame, frame({key(BTN_LEFT, 0)})));
  }
  CHECK(only(s, kUnwant));
}

void test_motion_in_the_frame_of_a_swallowed_button_is_kept() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  Step s = r.send(kMouse, frame({rel(REL_X, 5), rel(REL_Y, -1), scan(), key(BTN_LEFT, 1)}));
  CHECK(s.writes.size() == 1);
  if (!s.writes.empty()) CHECK(same(s.writes[0].frame, frame({rel(REL_X, 5), rel(REL_Y, -1)})));
  CHECK(only(s, kWant));
  // The release comes with motion after it: the replayed click goes out first, then the motion.
  s = r.send(kMouse, frame({key(BTN_LEFT, 0), rel(REL_X, 1)}));
  CHECK(s.writes.size() == 3);
  if (s.writes.size() == 3) {
    CHECK(same(s.writes[0].frame, frame({key(BTN_LEFT, 1)})));
    CHECK(same(s.writes[1].frame, frame({key(BTN_LEFT, 0)})));
    CHECK(same(s.writes[2].frame, frame({rel(REL_X, 1)})));
  }
}

void test_motion_before_a_swallowed_button_in_the_frame_counts_for_the_anchor() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  r.send(kMouse, frame({rel(REL_X, 7), key(BTN_LEFT, 1)}));
  Step s = r.send(kMouse, frame({rel(REL_X, 9)}));
  CHECK(lines(s)[0] == R"({"type":"wheelOpen","x":0,"y":0,"wheel":"ping","rel":true})");
}

void test_right_click_cancels_and_the_pointer_is_released_after_the_button_comes_up() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  r.send(kMouse, frame({key(BTN_LEFT, 1)}));
  r.send(kMouse, frame({rel(REL_X, 30)}));
  Step s = r.send(kMouse, frame({key(BTN_RIGHT, 1)}));
  CHECK(s.writes.empty());
  CHECK(only(s, R"({"type":"cancel"})"));
  CHECK(r.core.pointerWanted());
  s = r.send(kMouse, frame({key(BTN_RIGHT, 0)}));
  CHECK(s.writes.empty() && s.messages.empty());
  s = r.send(kMouse, frame({key(BTN_LEFT, 0)}));
  CHECK(s.writes.empty() && only(s, kUnwant));
}

void test_the_watchdog_cancel_goes_out_from_the_tick() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  r.send(kMouse, frame({key(BTN_LEFT, 1)}));
  CHECK(r.core.tick(r.t + 100).messages.empty());
  const Step s = r.core.tick(r.t + 10001);
  CHECK(only(s, R"({"type":"cancel"})"));
  const Step up = r.send(kMouse, frame({key(BTN_LEFT, 0)}));
  CHECK(up.writes.empty() && only(up, kUnwant));
}

void test_a_paused_decision_swallows_nothing() {
  Rig r(false);
  CHECK(r.passes(kKbd, frame({key(KEY_LEFTALT, 1)})));
  CHECK(r.passes(kMouse, frame({key(BTN_LEFT, 1)})));
  CHECK(r.passes(kMouse, frame({rel(REL_X, 40)})));
  CHECK(r.passes(kMouse, frame({key(BTN_LEFT, 0)})));
}

void test_a_removed_keyboard_lets_go_of_its_held_trigger() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  CHECK(!r.passes(kMouse, frame({key(BTN_LEFT, 1)})));  // Alt is held: the press is a gesture
  r.send(kMouse, frame({key(BTN_LEFT, 0)}));
  r.core.removeDevice(kKbd, r.t);
  CHECK(r.passes(kMouse, frame({key(BTN_LEFT, 1)})));
  CHECK(r.passes(kMouse, frame({key(BTN_LEFT, 0)})));
}

void test_resync_after_dropped_events_releases_keys_that_came_up() {
  Rig r;
  r.send(kKbd, frame({key(KEY_LEFTALT, 1)}));
  const Step s = r.core.resync(kKbd, {}, r.t);  // the kernel's buffer overflowed and the Alt release was lost
  CHECK(s.writes.size() == 1 && same(s.writes[0].frame, frame({key(KEY_LEFTALT, 0)})));
  CHECK(r.passes(kMouse, frame({key(BTN_LEFT, 1)})));
}

void test_pointer_want_follows_the_decision_state() {
  Rig r;
  std::vector<std::string> all;
  const auto take = [&](const Step& s) {
    for (const auto& l : lines(s)) all.push_back(l);
  };
  take(r.send(kKbd, frame({key(KEY_LEFTALT, 1)})));
  take(r.send(kMouse, frame({key(BTN_LEFT, 1)})));
  take(r.send(kMouse, frame({rel(REL_X, 1)})));
  take(r.send(kMouse, frame({key(BTN_LEFT, 0)})));
  take(r.send(kMouse, frame({key(BTN_LEFT, 1)})));
  take(r.send(kMouse, frame({key(BTN_LEFT, 0)})));
  std::vector<std::string> want;
  for (const auto& l : all) {
    if (l.find("pointer") != std::string::npos) want.push_back(l);
  }
  CHECK(want == (std::vector<std::string>{kWant, kUnwant, kWant, kUnwant}));
}

void test_classifies_devices() {
  CHECK(classify(keyboardCaps()) == DeviceKind::Keyboard);
  CHECK(classify(mouseCaps()) == DeviceKind::Mouse);

  DeviceCaps both = mouseCaps();
  both.key.set(KEY_ENTER);
  CHECK(classify(both) == DeviceKind::Both);

  DeviceCaps touchpad = mouseCaps();  // a touchpad also looks like a mouse: it has finger tools and multitouch axes
  touchpad.key.set(BTN_TOOL_FINGER);
  touchpad.key.set(BTN_TOUCH);
  touchpad.ev.set(EV_ABS);
  touchpad.abs.set(ABS_MT_POSITION_X);
  CHECK(classify(touchpad) == DeviceKind::Skip);

  DeviceCaps tablet = mouseCaps();
  tablet.key.set(BTN_TOOL_PEN);
  CHECK(classify(tablet) == DeviceKind::Skip);

  DeviceCaps gamepad;
  gamepad.ev.set(EV_KEY);
  gamepad.ev.set(EV_ABS);
  gamepad.key.set(BTN_SOUTH);
  gamepad.key.set(BTN_EAST);
  CHECK(classify(gamepad) == DeviceKind::Skip);

  DeviceCaps joystick = mouseCaps();
  joystick.key.set(BTN_TRIGGER);
  CHECK(classify(joystick) == DeviceKind::Skip);

  DeviceCaps power;
  power.ev.set(EV_KEY);
  power.key.set(KEY_POWER);
  CHECK(classify(power) == DeviceKind::Skip);

  DeviceCaps ours = keyboardCaps();
  ours.phys = kClonePhys;
  CHECK(classify(ours) == DeviceKind::Skip);
  CHECK(isOwnClone(kClonePhys) && !isOwnClone("usb-0000:00:14.0-1/input0"));
}

void test_keys_map_to_the_vks_linuxinput_gives_the_same_physical_keys() {
  struct Named {
    uint16_t code;
    const char* xkb;
  };
  const Named named[] = {
      {KEY_1, "AE01"}, {KEY_0, "AE10"}, {KEY_Q, "AD01"}, {KEY_P, "AD10"}, {KEY_A, "AC01"}, {KEY_L, "AC09"},
      {KEY_Z, "AB01"}, {KEY_M, "AB07"}, {KEY_GRAVE, "TLDE"}, {KEY_MINUS, "AE11"}, {KEY_EQUAL, "AE12"},
      {KEY_LEFTBRACE, "AD11"}, {KEY_RIGHTBRACE, "AD12"}, {KEY_BACKSLASH, "BKSL"}, {KEY_SEMICOLON, "AC10"},
      {KEY_APOSTROPHE, "AC11"}, {KEY_COMMA, "AB08"}, {KEY_DOT, "AB09"}, {KEY_SLASH, "AB10"},
  };
  for (const auto& n : named) CHECK(keyCodeToVk(n.code) == x11::keyNameToVk(n.xkb) && keyCodeToVk(n.code) != 0);
  // Every letter and digit, so the table has no typo.
  const char* rows[] = {"1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"};
  const uint16_t codes[][10] = {{KEY_1, KEY_2, KEY_3, KEY_4, KEY_5, KEY_6, KEY_7, KEY_8, KEY_9, KEY_0},
                                {KEY_Q, KEY_W, KEY_E, KEY_R, KEY_T, KEY_Y, KEY_U, KEY_I, KEY_O, KEY_P},
                                {KEY_A, KEY_S, KEY_D, KEY_F, KEY_G, KEY_H, KEY_J, KEY_K, KEY_L, 0},
                                {KEY_Z, KEY_X, KEY_C, KEY_V, KEY_B, KEY_N, KEY_M, 0, 0, 0}};
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; rows[row][col]; ++col) CHECK(keyCodeToVk(codes[row][col]) == static_cast<uint32_t>(rows[row][col]));
  }
  struct Sym {
    uint16_t code;
    unsigned long sym;
  };
  const Sym syms[] = {
      {KEY_LEFTSHIFT, XK_Shift_L}, {KEY_RIGHTSHIFT, XK_Shift_R}, {KEY_LEFTCTRL, XK_Control_L},
      {KEY_RIGHTCTRL, XK_Control_R}, {KEY_LEFTALT, XK_Alt_L}, {KEY_RIGHTALT, XK_Alt_R},
      {KEY_LEFTMETA, XK_Super_L}, {KEY_RIGHTMETA, XK_Super_R}, {KEY_ESC, XK_Escape}, {KEY_TAB, XK_Tab},
      {KEY_ENTER, XK_Return}, {KEY_KPENTER, XK_KP_Enter}, {KEY_SPACE, XK_space}, {KEY_BACKSPACE, XK_BackSpace},
      {KEY_DELETE, XK_Delete}, {KEY_INSERT, XK_Insert}, {KEY_HOME, XK_Home}, {KEY_END, XK_End},
      {KEY_PAGEUP, XK_Page_Up}, {KEY_PAGEDOWN, XK_Page_Down}, {KEY_LEFT, XK_Left}, {KEY_UP, XK_Up},
      {KEY_RIGHT, XK_Right}, {KEY_DOWN, XK_Down}, {KEY_CAPSLOCK, XK_Caps_Lock}, {KEY_SYSRQ, XK_Print},
      {KEY_SCROLLLOCK, XK_Scroll_Lock}, {KEY_PAUSE, XK_Pause}, {KEY_NUMLOCK, XK_Num_Lock}, {KEY_COMPOSE, XK_Menu},
      {KEY_KPASTERISK, XK_KP_Multiply}, {KEY_KPPLUS, XK_KP_Add}, {KEY_KPMINUS, XK_KP_Subtract},
      {KEY_KPDOT, XK_KP_Decimal}, {KEY_KPSLASH, XK_KP_Divide}, {KEY_F1, XK_F1}, {KEY_F10, XK_F10},
      {KEY_F12, XK_F12}, {KEY_F13, XK_F13}, {KEY_F24, XK_F24},
  };
  for (const auto& s : syms) CHECK(keyCodeToVk(s.code) == x11::keysymToVk(s.sym) && keyCodeToVk(s.code) != 0);
}

void test_vk_and_code_tables_agree() {
  for (int code = 0; code < KEY_CNT; ++code) {
    const uint32_t vk = keyCodeToVk(static_cast<uint16_t>(code));
    if (vk == 0) continue;
    const uint16_t back = vkToKeyCode(vk);
    CHECK(back != 0 && keyCodeToVk(back) == vk);
  }
  CHECK(vkToKeyCode(0x0D) == KEY_ENTER);  // a replayed Enter is the main key, not the keypad's
  CHECK(vkToKeyCode(0xFC) == 0);
  CHECK(buttonOfCode(BTN_LEFT) == Btn::Left && buttonOfCode(BTN_SIDE) == Btn::X1 && buttonOfCode(BTN_EXTRA) == Btn::X2);
  CHECK(buttonOfCode(KEY_A) == Btn::None);
  for (const Btn b : {Btn::Left, Btn::Right, Btn::Middle, Btn::X1, Btn::X2}) CHECK(buttonOfCode(codeOfButton(b)) == b);
}

void test_rel_is_written_only_when_set() {
  Emit e{Emit::Kind::WheelMove};
  e.x = 3;
  e.y = -4;
  CHECK(formatEmit(e) == R"({"type":"wheelMove","x":3,"y":-4,"wheel":"ping"})");
  e.rel = true;
  CHECK(formatEmit(e) == R"({"type":"wheelMove","x":3,"y":-4,"wheel":"ping","rel":true})");
  CHECK(pointerWantLine(true) == kWant && pointerWantLine(false) == kUnwant);
}

}  // namespace

int main() {
  test_plain_mouse_click_passes_unchanged();
  test_plain_typing_passes_unchanged_and_repeats_are_forwarded();
  test_keys_without_a_vk_pass_unchanged();
  test_alt_drag_is_swallowed_and_reported_relative_to_the_press();
  test_a_second_gesture_is_measured_from_its_own_press();
  test_a_short_trigger_click_is_replayed_on_the_clone_of_the_mouse_that_made_it();
  test_motion_in_the_frame_of_a_swallowed_button_is_kept();
  test_motion_before_a_swallowed_button_in_the_frame_counts_for_the_anchor();
  test_right_click_cancels_and_the_pointer_is_released_after_the_button_comes_up();
  test_the_watchdog_cancel_goes_out_from_the_tick();
  test_a_paused_decision_swallows_nothing();
  test_a_removed_keyboard_lets_go_of_its_held_trigger();
  test_resync_after_dropped_events_releases_keys_that_came_up();
  test_pointer_want_follows_the_decision_state();
  test_classifies_devices();
  test_keys_map_to_the_vks_linuxinput_gives_the_same_physical_keys();
  test_vk_and_code_tables_agree();
  test_rel_is_written_only_when_set();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
