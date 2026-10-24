#include "decision.h"

#include <algorithm>
#include <cmath>

namespace lp {
namespace {

constexpr uint32_t kVkShift = 0x10, kVkCtrl = 0x11, kVkAlt = 0x12;
constexpr uint32_t kVkLShift = 0xA0, kVkRShift = 0xA1, kVkLCtrl = 0xA2, kVkRCtrl = 0xA3;
constexpr uint32_t kVkLAlt = 0xA4, kVkRAlt = 0xA5, kVkLWin = 0x5B, kVkRWin = 0x5C, kVkEsc = 0x1B;

// A process name as the skip list matches it: lower-case, without a trailing ".exe".
std::string appStem(std::string s) {
  size_t start = 0;
  while (start < s.size() && (s[start] == ' ' || s[start] == '\t')) ++start;
  size_t end = s.size();
  while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t')) --end;
  s = s.substr(start, end - start);
  for (char& ch : s) {
    if (ch >= 'A' && ch <= 'Z') ch += 'a' - 'A';
  }
  if (s.size() > 4 && s.compare(s.size() - 4, 4, ".exe") == 0) s.resize(s.size() - 4);
  return s;
}

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

Emit panelEmit(bool show) {
  Emit e{Emit::Kind::Panel};
  e.show = show;
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
  skipStems_.clear();
  size_t pos = 0;
  while (pos < c.skipApps.size()) {
    const size_t comma = c.skipApps.find(',', pos);
    const std::string stem = appStem(c.skipApps.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos));
    if (!stem.empty() && std::find(skipStems_.begin(), skipStems_.end(), stem) == skipStems_.end())
      skipStems_.push_back(stem);
    if (comma == std::string::npos) break;
    pos = comma + 1;
  }
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

void Decision::setFullscreenProbe(std::function<bool(int x, int y)> probe) { fullscreenProbe_ = std::move(probe); }

void Decision::setForegroundApp(std::function<std::string()> fg) { foregroundApp_ = std::move(fg); }

// The skip list costs one supplier call per gesture or hotkey press, and none at all while it is empty.
bool Decision::inSkippedApp() const {
  if (skipStems_.empty() || !foregroundApp_) return false;
  const std::string name = foregroundApp_();
  if (name.empty()) return false;
  const std::string stem = appStem(name);
  return std::find(skipStems_.begin(), skipStems_.end(), stem) != skipStems_.end();
}

Result Decision::releasePanel() {
  Result r;
  if (panelDown_ == 0) return r;
  keyDown_[panelDown_] = false;
  panelDown_ = 0;
  r.emits.push_back(panelEmit(false));
  return r;
}

Result Decision::tick(uint64_t nowMs) {
  Result r;
  // A captured panel key whose repeats stopped lost its key-up: hide the panel. The real up, if it still
  // comes, stays swallowed through swallowKeyUps_, and the key counts as up for the next press.
  if (panelDown_ != 0 && panelRepeatGapMs_ != 0 && nowMs > lastPanelMs_ && nowMs - lastPanelMs_ > panelRepeatGapMs_)
    r = releasePanel();
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
  if (!held(WheelKind::Ping) && !held(WheelKind::Emote)) foreignKey_ = false;
}

Result Decision::onEvent(const InputEvent& e) {
  Result r;
  if (e.selfInjected) return r;
  switch (e.kind) {
    case EvKind::KeyDown: {
      // Tap-through: another key while a custom trigger key is held back means the user is typing.
      // The held-back key is sent first; if this key would pass through, it would overtake that queued
      // inject, so it is swallowed and replayed right behind it instead, keeping the typed order.
      const bool flushed = flushHeldBack(e.vk & 0xFF, r);
      onKeyDown(e, r);
      if (flushed && !r.swallow) {
        r.swallow = true;
        r.injects.push_back({InjectKind::KeyDown, Btn::None, e.vk & 0xFF});
      }
      break;
    }
    case EvKind::KeyUp:
      onKeyUp(e, r);
      break;
    case EvKind::MouseDown:
      lastX_ = e.x;
      lastY_ = e.y;
      lastMouseMs_ = e.timeMs;
      onMouseDown(e, r);
      break;
    case EvKind::MouseUp:
      lastX_ = e.x;
      lastY_ = e.y;
      lastMouseMs_ = e.timeMs;
      onMouseUp(e, r);
      break;
    case EvKind::MouseMove:
      lastX_ = e.x;
      lastY_ = e.y;
      lastMouseMs_ = e.timeMs;
      onMouseMove(e, r);
      break;
  }
  return r;
}

// Sends the held-back custom trigger key down when a different key arrives, and switches that key to typing:
// from now on its repeats and real key-up reach the OS. Returns whether a key was flushed.
bool Decision::flushHeldBack(uint32_t vk, Result& r) {
  if (heldBackVk_ == 0 || vk == heldBackVk_) return false;
  const uint32_t heldVk = heldBackVk_;
  heldBackVk_ = 0;
  typedVk_ = heldVk;
  swallowKeyUps_.erase(heldVk);  // the OS now sees it down, so it must see it go up
  r.injects.push_back({InjectKind::KeyDown, Btn::None, heldVk});
  return true;
}

void Decision::onKeyDown(const InputEvent& e, Result& r) {
  const uint32_t vk = e.vk & 0xFF;
  const bool repeat = keyDown_[vk];
  keyDown_[vk] = true;
  // Windows stops a key's auto-repeat once another key goes down, so a key press while the panel key is held
  // is proof it is still held: keep the repeat watchdog from hiding the panel.
  if (panelDown_ != 0 && vk != panelDown_) lastPanelMs_ = e.timeMs;

  // Another program's chord is starting (Alt+Tab's switcher, Win+Tab's task view, Alt+F4...):
  // until every trigger is released, clicks belong to that context and must not open a wheel.
  // Only in Idle: a foreign key arriving mid-gesture (Esc cancelling a wheel) says nothing about
  // the NEXT gesture.
  if (state_ == State::Idle && modBit(vk) == 0 && !isTriggerVk(WheelKind::Ping, vk) &&
      !isTriggerVk(WheelKind::Emote, vk) && (held(WheelKind::Ping) || held(WheelKind::Emote)))
    foreignKey_ = true;

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
  if (active() && cfg_.textVk != 0 && vk == cfg_.textVk && mods() == cfg_.textMods) {
    r.swallow = true;
    swallowKeyUps_.insert(vk);
    markSwallow();
    if (!repeat) {
      cancelGesture(r);
      r.emits.push_back(Emit{Emit::Kind::TextRequested});
    }
    return;
  }
  // The room panel key: a deliberate exception to "input passes through" (spec 5.3). Plain key, captured at
  // once and never replayed. Its repeats stay swallowed even if the config changed since, because the OS never saw the down.
  if (panelDown_ != 0 && vk == panelDown_) {
    r.swallow = true;
    lastPanelMs_ = e.timeMs;
    return;
  }
  if (active() && !repeat && cfg_.panelVk != 0 && vk == cfg_.panelVk && mods() == 0 &&
      !isTriggerVk(WheelKind::Ping, vk) && !isTriggerVk(WheelKind::Emote, vk) &&
      !(cfg_.gameCheck && fullscreenProbe_ && fullscreenProbe_(lastX_, lastY_))) {
    r.swallow = true;
    swallowKeyUps_.insert(vk);
    panelDown_ = vk;
    lastPanelMs_ = e.timeMs;
    r.emits.push_back(panelEmit(true));
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
    // Tap-through: the trigger key was flushed for typing, so its auto-repeats type too.
    if (vk == typedVk_) {
      swallowKeyUps_.erase(vk);
      return;
    }
    if (ownKey(WheelKind::Ping) || ownKey(WheelKind::Emote)) {
      r.swallow = true;
      swallowKeyUps_.insert(vk);
      // Tap-through: hold a custom key back instead of dropping it; onKeyUp types it if no drag used it.
      // Caps Lock keeps the old behaviour: a replayed tap would toggle it.
      const auto customKey = [&](WheelKind k) { return spec(k).trigger == Trigger::CustomVk && vk == spec(k).vk; };
      if (!repeat && (customKey(WheelKind::Ping) || customKey(WheelKind::Emote))) heldBackVk_ = vk;
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
  if (!held(WheelKind::Ping) && !held(WheelKind::Emote)) foreignKey_ = false;
  const bool triggerReleased = heldBefore && !held(owner_) && isTriggerVk(owner_, vk);

  if (swallowKeyUps_.erase(vk) > 0) r.swallow = true;
  if (vk == panelDown_) {
    panelDown_ = 0;
    r.emits.push_back(panelEmit(false));
  }
  // Tap-through: a flushed key's real up passes (its swallow was dropped at the flush), ending typing mode.
  if (vk == typedVk_) typedVk_ = 0;
  // Tap-through: the key was pressed and released with nothing in between: type it now (down + up).
  // The real up stays swallowed: the OS never saw the real down.
  if (vk == heldBackVk_) {
    heldBackVk_ = 0;
    r.swallow = true;
    r.injects.push_back({InjectKind::KeyDown, Btn::None, vk});
    r.injects.push_back({InjectKind::KeyUp, Btn::None, vk});
  }
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
  }
  // An open wheel ignores the trigger, as in League: the button-up picks the slice. A trackpad's
  // three-finger drag sends that up about a second after the trigger is let go.
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
  if (foreignKey_) return;  // the trigger is part of another program's chord: let the click through
  // Exactly one wheel's trigger must claim the press. When both do (Alt and Ctrl held), it's ambiguous:
  // pass it through untouched rather than guess.
  const bool ping = startsGesture(WheelKind::Ping, e.btn);
  const bool emote = startsGesture(WheelKind::Emote, e.btn);
  if (ping != emote) {
    // A fullscreen app (a game) owns the screen: its clicks belong to it, not to a wheel. Probed
    // only when a gesture would actually start, so plain clicks never pay for the check.
    if (cfg_.gameCheck && fullscreenProbe_ && fullscreenProbe_(e.x, e.y)) return;
    r.swallow = true;
    markSwallow();
    heldBackVk_ = 0;  // tap-through: the held-back key started a gesture, so it is never typed
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
