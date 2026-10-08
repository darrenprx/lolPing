#include "decision.h"

#include <cmath>

namespace lp {
namespace {

constexpr uint32_t kVkShift = 0x10, kVkCtrl = 0x11, kVkAlt = 0x12;
constexpr uint32_t kVkLShift = 0xA0, kVkRShift = 0xA1, kVkLCtrl = 0xA2, kVkRCtrl = 0xA3;
constexpr uint32_t kVkLAlt = 0xA4, kVkRAlt = 0xA5, kVkLWin = 0x5B, kVkRWin = 0x5C, kVkEsc = 0x1B;

uint32_t modBit(uint32_t vk) {
  switch (vk) {
    case kVkCtrl:
    case kVkLCtrl:
    case kVkRCtrl:
      return ModCtrl;
    case kVkAlt:
    case kVkLAlt:
    case kVkRAlt:
      return ModAlt;
    case kVkShift:
    case kVkLShift:
    case kVkRShift:
      return ModShift;
    case kVkLWin:
    case kVkRWin:
      return ModWin;
    default:
      return 0;
  }
}

Emit point(Emit::Kind k, int x, int y, WheelKind w) {
  Emit e{k};
  e.x = x;
  e.y = y;
  e.wheel = w;
  return e;
}

}  // namespace

uint32_t Decision::mods() const {
  uint32_t m = 0;
  for (uint32_t vk = 0; vk < 256; ++vk) {
    if (keyDown_[vk]) m |= modBit(vk);
  }
  return m;
}

Decision::Spec Decision::spec(WheelKind k) const {
  if (k == WheelKind::Emote) return {cfg_.emoteTrigger, cfg_.emoteTriggerVk, cfg_.emoteClick};
  return {cfg_.trigger, cfg_.triggerVk, cfg_.clickPing};
}

// Keyboard triggers only: a mouse trigger, or None, is never "held".
bool Decision::held(WheelKind k) const {
  switch (spec(k).trigger) {
    case Trigger::Alt:
      return (mods() & ModAlt) != 0;
    case Trigger::Ctrl:
      return (mods() & ModCtrl) != 0;
    case Trigger::Shift:
      return (mods() & ModShift) != 0;
    case Trigger::Win:
      return (mods() & ModWin) != 0;
    case Trigger::CapsLock:
    case Trigger::CustomVk:
      return keyDown_[keyTriggerVk(k) & 0xFF];
    default:
      return false;
  }
}

bool Decision::isTriggerVk(WheelKind k, uint32_t vk) const {
  switch (spec(k).trigger) {
    case Trigger::Alt:
      return modBit(vk) == ModAlt;
    case Trigger::Ctrl:
      return modBit(vk) == ModCtrl;
    case Trigger::Shift:
      return modBit(vk) == ModShift;
    case Trigger::Win:
      return modBit(vk) == ModWin;
    case Trigger::CapsLock:
    case Trigger::CustomVk:
      return vk == keyTriggerVk(k);
    default:
      return false;
  }
}

bool Decision::isMouseTrigger(WheelKind k) const {
  const Trigger t = spec(k).trigger;
  return t == Trigger::Mouse4 || t == Trigger::Mouse5;
}

bool Decision::isKeyTrigger(WheelKind k) const {
  const Trigger t = spec(k).trigger;
  return t == Trigger::CapsLock || t == Trigger::CustomVk;
}

uint32_t Decision::keyTriggerVk(WheelKind k) const {
  const Spec s = spec(k);
  return s.trigger == Trigger::CapsLock ? 0x14u : s.vk;
}

Btn Decision::dragButton(WheelKind k) const {
  const Trigger t = spec(k).trigger;
  if (t == Trigger::Mouse4) return Btn::X1;
  if (t == Trigger::Mouse5) return Btn::X2;
  return Btn::Left;
}

// A press starts a gesture for this wheel: its side button, or the left button while its key is held.
bool Decision::startsGesture(WheelKind k, Btn btn) const {
  return btn == dragButton(k) && (isMouseTrigger(k) || held(k));
}

// Something was swallowed while Alt or Win is held: their key-up must be masked,
// otherwise Windows opens the menu bar / Start menu.
void Decision::markSwallow() {
  if (maskMenuKeys_ && (mods() & (ModAlt | ModWin)) != 0) needMask_ = true;
}

void Decision::cancelGesture(Result& r) {
  if (state_ == State::Pending || state_ == State::Wheel) {
    r.emits.push_back(Emit{Emit::Kind::Cancel});
    state_ = State::SwallowUp;
  }
}

Result Decision::setConfig(const Config& c) {
  Result r;
  cancelGesture(r);
  cfg_ = c;
  enabled_ = c.enabled;
  return r;
}

Result Decision::setEnabled(bool on) {
  Result r;
  if (!on) cancelGesture(r);
  enabled_ = on;
  return r;
}

Result Decision::setSuspended(bool on) {
  Result r;
  if (on) cancelGesture(r);
  suspended_ = on;
  return r;
}

Result Decision::tick(uint64_t nowMs) {
  Result r;
  const bool busy = state_ == State::Pending || state_ == State::Wheel;
  if (busy && nowMs > lastMouseMs_ && nowMs - lastMouseMs_ > kWatchdogMs) {
    r.emits.push_back(Emit{Emit::Kind::Cancel});
    // The press was swallowed, so its up must be swallowed too. If the up was really lost,
    // the next drag-button down resets SwallowUp to Idle.
    state_ = State::SwallowUp;
  }
  return r;
}

void Decision::syncKeyStates(const std::function<bool(uint32_t vk)>& isDown) {
  for (uint32_t vk = 0; vk < 256; ++vk) {
    // A key whose down we swallowed never reached the OS, so the OS reports it up: keep those.
    if (keyDown_[vk] && swallowKeyUps_.count(vk) == 0 && !isDown(vk)) keyDown_[vk] = false;
  }
}

Result Decision::onEvent(const InputEvent& e) {
  Result r;
  if (e.selfInjected) return r;
  switch (e.kind) {
    case EvKind::KeyDown:
      onKeyDown(e, r);
      break;
    case EvKind::KeyUp:
      onKeyUp(e, r);
      break;
    case EvKind::MouseDown:
      lastMouseMs_ = e.timeMs;
      onMouseDown(e, r);
      break;
    case EvKind::MouseUp:
      lastMouseMs_ = e.timeMs;
      onMouseUp(e, r);
      break;
    case EvKind::MouseMove:
      lastMouseMs_ = e.timeMs;
      onMouseMove(e, r);
      break;
  }
  return r;
}

void Decision::onKeyDown(const InputEvent& e, Result& r) {
  const uint32_t vk = e.vk & 0xFF;
  const bool repeat = keyDown_[vk];
  keyDown_[vk] = true;

  if (!suspended_ && vk == cfg_.toggleVk && mods() == cfg_.toggleMods) {
    r.swallow = true;
    swallowKeyUps_.insert(vk);
    markSwallow();
    if (!repeat) {
      if (enabled_) cancelGesture(r);
      enabled_ = !enabled_;
      Emit t{Emit::Kind::Toggled};
      t.enabled = enabled_;
      r.emits.push_back(t);
    }
    return;
  }
  if (active()) {
    if (vk == kVkEsc && (state_ == State::Pending || state_ == State::Wheel)) {
      r.swallow = true;
      swallowKeyUps_.insert(vk);
      markSwallow();
      cancelGesture(r);
      return;
    }
    // Caps Lock and custom-key triggers of either wheel would toggle or type: keep them from the OS.
    const auto ownKey = [&](WheelKind k) { return isKeyTrigger(k) && vk == keyTriggerVk(k); };
    if (ownKey(WheelKind::Ping) || ownKey(WheelKind::Emote)) {
      r.swallow = true;
      swallowKeyUps_.insert(vk);
      return;
    }
  }
  // This down passes through, so any pending up-swallow for the key is stale (its up was lost): drop it.
  swallowKeyUps_.erase(vk);
}

void Decision::onKeyUp(const InputEvent& e, Result& r) {
  const uint32_t vk = e.vk & 0xFF;
  // Only the gesture's own trigger ends it: the other wheel's key comes and goes freely.
  const bool heldBefore = held(owner_);
  keyDown_[vk] = false;
  const bool triggerReleased = heldBefore && !held(owner_) && isTriggerVk(owner_, vk);

  if (swallowKeyUps_.erase(vk) > 0) r.swallow = true;
  if (needMask_ && (modBit(vk) == ModAlt || modBit(vk) == ModWin)) {
    // Swallow the real key-up and replay it after a no-op key, in that order.
    needMask_ = false;
    r.swallow = true;
    r.injects.push_back({InjectKind::KeyDown, Btn::None, kMaskVk});
    r.injects.push_back({InjectKind::KeyUp, Btn::None, kMaskVk});
    r.injects.push_back({InjectKind::KeyUp, Btn::None, vk});
  }
  if (!triggerReleased) return;
  if (state_ == State::Pending) {
    if (clickOn(owner_)) {
      r.emits.push_back(point(Emit::Kind::Click, px_, py_, owner_));
      state_ = State::SwallowUp;
    } else {
      // Plain click: re-press now; the real button-up will pass through.
      r.injects.push_back({InjectKind::ButtonDown, dragBtn_});
      state_ = State::Idle;
    }
  } else if (state_ == State::Wheel) {
    r.emits.push_back(Emit{Emit::Kind::Cancel});
    state_ = State::SwallowUp;
  }
}

void Decision::onMouseDown(const InputEvent& e, Result& r) {
  if (state_ == State::SwallowUp && e.btn == dragBtn_) state_ = State::Idle;  // the matching up was lost
  // A new right-down means the previous right-up never arrived (secure desktop, Win+L, UAC): don't swallow this one's.
  if (e.btn == Btn::Right) swallowRightUp_ = false;
  if (!active()) return;
  if ((state_ == State::Pending || state_ == State::Wheel) && e.btn == Btn::Right) {
    r.swallow = true;
    swallowRightUp_ = true;
    markSwallow();
    cancelGesture(r);
    return;
  }
  if (state_ != State::Idle) return;
  // Exactly one wheel's trigger must claim the press. When both do (Alt and Ctrl held), it's ambiguous:
  // pass it through untouched rather than guess.
  const bool ping = startsGesture(WheelKind::Ping, e.btn);
  const bool emote = startsGesture(WheelKind::Emote, e.btn);
  if (ping != emote) {
    r.swallow = true;
    markSwallow();
    state_ = State::Pending;
    owner_ = ping ? WheelKind::Ping : WheelKind::Emote;
    dragBtn_ = e.btn;
    px_ = e.x;
    py_ = e.y;
  }
}

void Decision::onMouseUp(const InputEvent& e, Result& r) {
  if (e.btn == Btn::Right && swallowRightUp_) {
    swallowRightUp_ = false;
    r.swallow = true;
    return;
  }
  if (state_ == State::Idle || e.btn != dragBtn_) return;
  r.swallow = true;
  if (state_ == State::Pending) {
    if (clickOn(owner_)) {
      r.emits.push_back(point(Emit::Kind::Click, px_, py_, owner_));
    } else {
      r.injects.push_back({InjectKind::ButtonDown, dragBtn_});
      r.injects.push_back({InjectKind::ButtonUp, dragBtn_});
    }
  } else if (state_ == State::Wheel) {
    r.emits.push_back(point(Emit::Kind::WheelRelease, e.x, e.y, owner_));
  }
  state_ = State::Idle;
}

void Decision::onMouseMove(const InputEvent& e, Result& r) {
  if (state_ == State::Pending) {
    const double dist = std::hypot(static_cast<double>(e.x - px_), static_cast<double>(e.y - py_));
    if (dist > cfg_.dragThresholdPx) {
      state_ = State::Wheel;
      r.emits.push_back(point(Emit::Kind::WheelOpen, px_, py_, owner_));
      r.emits.push_back(point(Emit::Kind::WheelMove, e.x, e.y, owner_));
    }
  } else if (state_ == State::Wheel) {
    r.emits.push_back(point(Emit::Kind::WheelMove, e.x, e.y, owner_));
  }
}

}  // namespace lp
