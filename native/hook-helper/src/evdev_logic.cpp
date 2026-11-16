#include "evdev_logic.h"

#include <algorithm>
#include <cstdlib>
#include <initializer_list>
#include <utility>

#include "output.h"

namespace lp::evdev {
namespace {

struct KeyMap {
  uint16_t code;
  uint32_t vk;
};

// The VKs are the ones linuxinput.cpp gives the same physical keys (letters, digits and punctuation by position,
// the rest by what the key is). The numpad digits differ: XKB's first level makes them Home, End and so on, here
// they are the numpad VKs. The first entry for a VK is the key a replay types.
const KeyMap kKeys[] = {
    {KEY_A, 'A'}, {KEY_B, 'B'}, {KEY_C, 'C'}, {KEY_D, 'D'}, {KEY_E, 'E'}, {KEY_F, 'F'}, {KEY_G, 'G'},
    {KEY_H, 'H'}, {KEY_I, 'I'}, {KEY_J, 'J'}, {KEY_K, 'K'}, {KEY_L, 'L'}, {KEY_M, 'M'}, {KEY_N, 'N'},
    {KEY_O, 'O'}, {KEY_P, 'P'}, {KEY_Q, 'Q'}, {KEY_R, 'R'}, {KEY_S, 'S'}, {KEY_T, 'T'}, {KEY_U, 'U'},
    {KEY_V, 'V'}, {KEY_W, 'W'}, {KEY_X, 'X'}, {KEY_Y, 'Y'}, {KEY_Z, 'Z'},
    {KEY_1, '1'}, {KEY_2, '2'}, {KEY_3, '3'}, {KEY_4, '4'}, {KEY_5, '5'}, {KEY_6, '6'}, {KEY_7, '7'},
    {KEY_8, '8'}, {KEY_9, '9'}, {KEY_0, '0'},
    {KEY_F1, 0x70}, {KEY_F2, 0x71}, {KEY_F3, 0x72}, {KEY_F4, 0x73}, {KEY_F5, 0x74}, {KEY_F6, 0x75},
    {KEY_F7, 0x76}, {KEY_F8, 0x77}, {KEY_F9, 0x78}, {KEY_F10, 0x79}, {KEY_F11, 0x7A}, {KEY_F12, 0x7B},
    {KEY_F13, 0x7C}, {KEY_F14, 0x7D}, {KEY_F15, 0x7E}, {KEY_F16, 0x7F}, {KEY_F17, 0x80}, {KEY_F18, 0x81},
    {KEY_F19, 0x82}, {KEY_F20, 0x83}, {KEY_F21, 0x84}, {KEY_F22, 0x85}, {KEY_F23, 0x86}, {KEY_F24, 0x87},
    {KEY_KP0, 0x60}, {KEY_KP1, 0x61}, {KEY_KP2, 0x62}, {KEY_KP3, 0x63}, {KEY_KP4, 0x64}, {KEY_KP5, 0x65},
    {KEY_KP6, 0x66}, {KEY_KP7, 0x67}, {KEY_KP8, 0x68}, {KEY_KP9, 0x69},
    {KEY_KPASTERISK, 0x6A}, {KEY_KPPLUS, 0x6B}, {KEY_KPMINUS, 0x6D}, {KEY_KPDOT, 0x6E}, {KEY_KPSLASH, 0x6F},
    {KEY_LEFTSHIFT, 0xA0}, {KEY_RIGHTSHIFT, 0xA1}, {KEY_LEFTCTRL, 0xA2}, {KEY_RIGHTCTRL, 0xA3},
    {KEY_LEFTALT, 0xA4}, {KEY_RIGHTALT, 0xA5}, {KEY_LEFTMETA, 0x5B}, {KEY_RIGHTMETA, 0x5C},
    {KEY_ESC, 0x1B}, {KEY_TAB, 0x09}, {KEY_ENTER, 0x0D}, {KEY_KPENTER, 0x0D}, {KEY_SPACE, 0x20},
    {KEY_BACKSPACE, 0x08}, {KEY_DELETE, 0x2E}, {KEY_INSERT, 0x2D}, {KEY_HOME, 0x24}, {KEY_END, 0x23},
    {KEY_PAGEUP, 0x21}, {KEY_PAGEDOWN, 0x22}, {KEY_LEFT, 0x25}, {KEY_UP, 0x26}, {KEY_RIGHT, 0x27},
    {KEY_DOWN, 0x28}, {KEY_CAPSLOCK, 0x14}, {KEY_SYSRQ, 0x2C}, {KEY_SCROLLLOCK, 0x91}, {KEY_PAUSE, 0x13},
    {KEY_NUMLOCK, 0x90}, {KEY_COMPOSE, 0x5D},
    {KEY_GRAVE, 0xC0}, {KEY_MINUS, 0xBD}, {KEY_EQUAL, 0xBB}, {KEY_LEFTBRACE, 0xDB}, {KEY_RIGHTBRACE, 0xDD},
    {KEY_BACKSLASH, 0xDC}, {KEY_SEMICOLON, 0xBA}, {KEY_APOSTROPHE, 0xDE}, {KEY_COMMA, 0xBC}, {KEY_DOT, 0xBE},
    {KEY_SLASH, 0xBF},
};

// The virtual pointer goes back to 0 (while no gesture is on) long before it could overflow.
constexpr int64_t kResetAt = 100000000;

bool hasAll(const std::bitset<KEY_CNT>& key, std::initializer_list<int> codes) {
  return std::all_of(codes.begin(), codes.end(), [&](int c) { return key[static_cast<size_t>(c)]; });
}

void flushKept(Step& step, DeviceId dev, Frame& kept) {
  if (kept.empty()) return;  // a frame with nothing but its SYN_REPORT is not worth a write
  kept.push_back(Event{EV_SYN, SYN_REPORT, 0});
  step.writes.push_back(WriteFrame{dev, std::move(kept)});
  kept = Frame{};
}

bool isPoint(Emit::Kind k) {
  return k == Emit::Kind::WheelOpen || k == Emit::Kind::WheelMove || k == Emit::Kind::WheelRelease ||
         k == Emit::Kind::Click;
}

}  // namespace

bool isOwnClone(const std::string& phys) { return phys.rfind(kClonePhys, 0) == 0; }

DeviceKind classify(const DeviceCaps& c) {
  if (isOwnClone(c.phys)) return DeviceKind::Skip;
  if (c.ev[EV_ABS] && (c.abs[ABS_MT_SLOT] || c.abs[ABS_MT_POSITION_X])) return DeviceKind::Skip;  // touch
  // Joysticks and gamepads (0x120..0x13f), then pens, touch and the finger-count tools of touchpads (0x140..0x14f).
  for (size_t code = BTN_JOYSTICK; code <= BTN_TOOL_QUADTAP; ++code) {
    if (c.key[code]) return DeviceKind::Skip;
  }
  const bool mouse = c.ev[EV_REL] && c.rel[REL_X] && c.rel[REL_Y] && c.key[BTN_LEFT];
  const bool keyboard = c.ev[EV_KEY] &&
      (c.key[KEY_ENTER] ||
       hasAll(c.key, {KEY_A, KEY_B, KEY_C, KEY_D, KEY_E, KEY_F, KEY_G, KEY_H, KEY_I, KEY_J, KEY_K, KEY_L, KEY_M,
                      KEY_N, KEY_O, KEY_P, KEY_Q, KEY_R, KEY_S, KEY_T, KEY_U, KEY_V, KEY_W, KEY_X, KEY_Y, KEY_Z}));
  if (mouse && keyboard) return DeviceKind::Both;
  if (mouse) return DeviceKind::Mouse;
  if (keyboard) return DeviceKind::Keyboard;
  return DeviceKind::Skip;
}

uint32_t keyCodeToVk(uint16_t code) {
  for (const auto& k : kKeys) {
    if (k.code == code) return k.vk;
  }
  return 0;
}

uint16_t vkToKeyCode(uint32_t vk) {
  for (const auto& k : kKeys) {
    if (k.vk == vk) return k.code;
  }
  return 0;
}

Btn buttonOfCode(uint16_t code) {
  switch (code) {
    case BTN_LEFT: return Btn::Left;
    case BTN_RIGHT: return Btn::Right;
    case BTN_MIDDLE: return Btn::Middle;
    case BTN_SIDE: return Btn::X1;
    case BTN_EXTRA: return Btn::X2;
    default: return Btn::None;
  }
}

uint16_t codeOfButton(Btn b) {
  switch (b) {
    case Btn::Left: return BTN_LEFT;
    case Btn::Right: return BTN_RIGHT;
    case Btn::Middle: return BTN_MIDDLE;
    case Btn::X1: return BTN_SIDE;
    case Btn::X2: return BTN_EXTRA;
    default: return 0;
  }
}

std::string pointerWantLine(bool want) {
  return std::string("{\"type\":\"pointer\",\"want\":") + (want ? "true" : "false") + "}";
}

std::string Message::text() const { return isPointer ? pointerWantLine(want) : formatEmit(emit); }

EvdevCore::EvdevCore(Decision& decision) : dec_(decision), keyDevice_(256, -1), keyCode_(256, 0), buttonDevice_(6, -1) {}

void EvdevCore::addDevice(DeviceId id, DeviceKind kind) { devices_[id] = kind; }

Step EvdevCore::removeDevice(DeviceId id, uint64_t nowMs) {
  Step step;
  const auto held = down_.find(id);
  if (held != down_.end() && !held->second.empty()) {
    Frame release;
    for (const uint16_t code : held->second) release.push_back(Event{EV_KEY, code, 0});
    release.push_back(Event{EV_SYN, SYN_REPORT, 0});
    step = onFrame(id, release, nowMs);
  }
  devices_.erase(id);
  down_.erase(id);
  for (auto& d : keyDevice_) {
    if (d == id) d = -1;
  }
  for (auto& d : buttonDevice_) {
    if (d == id) d = -1;
  }
  return step;
}

Step EvdevCore::resync(DeviceId id, const std::vector<uint16_t>& downCodes, uint64_t nowMs) {
  const std::set<uint16_t> now(downCodes.begin(), downCodes.end());
  Frame diff;
  for (const uint16_t code : down_[id]) {
    if (now.count(code) == 0) diff.push_back(Event{EV_KEY, code, 0});
  }
  for (const uint16_t code : now) {
    if (down_[id].count(code) == 0) diff.push_back(Event{EV_KEY, code, 1});
  }
  if (diff.empty()) return Step{};
  diff.push_back(Event{EV_SYN, SYN_REPORT, 0});
  return onFrame(id, diff, nowMs);
}

DeviceId EvdevCore::firstOf(bool keyboard) const {
  for (const auto& [id, kind] : devices_) {
    if (keyboard ? (kind == DeviceKind::Keyboard || kind == DeviceKind::Both)
                 : (kind == DeviceKind::Mouse || kind == DeviceKind::Both))
      return id;
  }
  return -1;
}

DeviceId EvdevCore::deviceForKey(uint32_t vk) const {
  const DeviceId last = keyDevice_[vk & 0xFF];
  return last >= 0 ? last : firstOf(true);
}

DeviceId EvdevCore::deviceForButton(Btn b) const {
  const DeviceId last = buttonDevice_[static_cast<size_t>(b)];
  return last >= 0 ? last : firstOf(false);
}

void EvdevCore::syncPointer(Step& step) {
  const bool want = dec_.state() != Decision::State::Idle;
  if (want == wanted_) return;
  wanted_ = want;
  Message m;
  m.isPointer = true;
  m.want = want;
  step.messages.push_back(m);
}

// Turns a decision result into messages and writes; point emits become relative to the gesture's press.
void EvdevCore::finish(const Result& r, Step& step) {
  for (Emit e : r.emits) {
    if (isPoint(e.kind)) {
      e.x = static_cast<int>(e.x - anchorX_);
      e.y = static_cast<int>(e.y - anchorY_);
      e.rel = true;
    }
    Message m;
    m.emit = e;
    step.messages.push_back(m);
  }
  for (const auto& i : r.injects) {
    const bool button = i.kind == InjectKind::ButtonDown || i.kind == InjectKind::ButtonUp;
    const bool down = i.kind == InjectKind::ButtonDown || i.kind == InjectKind::KeyDown;
    uint16_t code = 0;
    DeviceId target = -1;
    if (button) {
      code = codeOfButton(i.btn);
      target = deviceForButton(i.btn);
    } else {
      const uint32_t vk = i.vk & 0xFF;
      code = keyCode_[vk] ? keyCode_[vk] : vkToKeyCode(vk);
      target = deviceForKey(vk);
    }
    if (code == 0 || target < 0) continue;
    step.writes.push_back(WriteFrame{target, Frame{Event{EV_KEY, code, down ? 1 : 0}, Event{EV_SYN, SYN_REPORT, 0}}});
  }
  syncPointer(step);
}

Result EvdevCore::feed(const InputEvent& e, DeviceId dev, Step& step, Frame& kept) {
  const bool wasIdle = dec_.state() == Decision::State::Idle;
  const Result r = dec_.onEvent(e);
  if (wasIdle && dec_.state() != Decision::State::Idle) {
    anchorX_ = e.x;
    anchorY_ = e.y;
  }
  if (r.swallow && !kept.empty() && kept.back().type == EV_MSC && kept.back().code == MSC_SCAN) {
    kept.pop_back();  // the scan code announced the event that was swallowed
  }
  // What passed so far goes out before an inject, so the clone sees the events in the order they happened.
  if (!r.injects.empty()) flushKept(step, dev, kept);
  finish(r, step);
  return r;
}

Step EvdevCore::apply(const Result& r, uint64_t) {
  Step step;
  finish(r, step);
  return step;
}

Step EvdevCore::tick(uint64_t nowMs) {
  Step step;
  finish(dec_.tick(nowMs), step);
  return step;
}

Step EvdevCore::onFrame(DeviceId dev, const Frame& in, uint64_t nowMs) {
  Step step;
  Frame kept;
  if (dec_.state() == Decision::State::Idle && (std::llabs(x_) > kResetAt || std::llabs(y_) > kResetAt)) x_ = y_ = 0;
  int dx = 0;
  int dy = 0;
  const auto pointAt = [&](EvKind kind, Btn btn, uint32_t vk) {
    InputEvent e;
    e.kind = kind;
    e.btn = btn;
    e.vk = vk;
    e.x = static_cast<int>(x_);
    e.y = static_cast<int>(y_);
    e.timeMs = nowMs;
    return e;
  };
  // The decision sees the motion before the button that follows it in the frame, as it happened.
  const auto flushMotion = [&] {
    if (dx == 0 && dy == 0) return;
    x_ += dx;
    y_ += dy;
    dx = dy = 0;
    feed(pointAt(EvKind::MouseMove, Btn::None, 0), dev, step, kept);
  };
  for (const Event& ev : in) {
    if (ev.type == EV_SYN) continue;  // each write gets its own SYN_REPORT
    if (ev.type == EV_REL) {
      if (ev.code == REL_X) dx += ev.value;
      if (ev.code == REL_Y) dy += ev.value;
      kept.push_back(ev);
      if (ev.code == REL_WHEEL || ev.code == REL_HWHEEL) {
        flushMotion();
        feed(pointAt(EvKind::Scroll, Btn::None, 0), dev, step, kept);
      }
      continue;
    }
    if (ev.type != EV_KEY) {
      kept.push_back(ev);
      continue;
    }
    if (ev.value == 1) down_[dev].insert(ev.code);
    if (ev.value == 0) down_[dev].erase(ev.code);
    const Btn btn = buttonOfCode(ev.code);
    const uint32_t vk = keyCodeToVk(ev.code);
    if ((btn == Btn::None && vk == 0) || ev.value < 0 || ev.value > 2 || (btn != Btn::None && ev.value == 2)) {
      kept.push_back(ev);
      continue;
    }
    flushMotion();
    Result r;
    if (btn != Btn::None) {
      buttonDevice_[static_cast<size_t>(btn)] = dev;
      r = feed(pointAt(ev.value == 1 ? EvKind::MouseDown : EvKind::MouseUp, btn, 0), dev, step, kept);
    } else {
      keyDevice_[vk & 0xFF] = dev;
      keyCode_[vk & 0xFF] = ev.code;
      r = feed(pointAt(ev.value == 0 ? EvKind::KeyUp : EvKind::KeyDown, Btn::None, vk), dev, step, kept);
    }
    if (!r.swallow) kept.push_back(ev);
  }
  flushMotion();
  flushKept(step, dev, kept);
  return step;
}

}  // namespace lp::evdev
