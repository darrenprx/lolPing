#pragma once
// Pure logic of the Linux evdev backend: key tables, device classification and the frame filter. No syscalls, so
// the tests drive it with hand-built frames. Linux only (it uses the kernel's event code constants).
#include <linux/input-event-codes.h>

#include <bitset>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "decision.h"

namespace lp::evdev {

/** One kernel input event without its timestamp (mirrors struct input_event). */
struct Event {
  uint16_t type = 0;
  uint16_t code = 0;
  int32_t value = 0;
};
/** The events of one device up to and including its SYN_REPORT. */
using Frame = std::vector<Event>;
using DeviceId = int;

/** The phys string every clone carries. It is how a clone is told from a real device, even after a helper crash. */
inline constexpr const char* kClonePhys = "lolping-virtual";

enum class DeviceKind { Skip, Keyboard, Mouse, Both };

struct DeviceCaps {
  std::string name;
  std::string phys;
  std::bitset<EV_CNT> ev;
  std::bitset<KEY_CNT> key;
  std::bitset<REL_CNT> rel;
  std::bitset<ABS_CNT> abs;
};

/** Keyboards and mice are grabbed. Touchpads, tablets, touchscreens, gamepads, buttons and our own clones are not. */
DeviceKind classify(const DeviceCaps& caps);
bool isOwnClone(const std::string& phys);

/** KEY_* code -> the VK the protocol uses (the values linuxinput.cpp gives the same physical key); 0 if unmapped. */
uint32_t keyCodeToVk(uint16_t code);
/** The KEY_* code that types a VK; 0 if none. */
uint16_t vkToKeyCode(uint32_t vk);
Btn buttonOfCode(uint16_t code);
uint16_t codeOfButton(Btn b);

std::string pointerWantLine(bool want);

/** A line for Electron, in order: a decision emit (points already relative) or a pointer want change. */
struct Message {
  bool isPointer = false;
  bool want = false;  // isPointer only
  Emit emit{Emit::Kind::Cancel};  // otherwise
  std::string text() const;
};

struct WriteFrame {
  DeviceId device;  // whose clone gets the frame
  Frame frame;      // ends with SYN_REPORT
};

struct Step {
  std::vector<WriteFrame> writes;
  std::vector<Message> messages;
};

/** Sits between the devices and their clones. Feeds the shared Decision and says what to write and send. */
class EvdevCore {
 public:
  explicit EvdevCore(Decision& decision);

  void addDevice(DeviceId id, DeviceKind kind);
  /** The device is gone: its held keys and buttons are released for the decision first. */
  Step removeDevice(DeviceId id, uint64_t nowMs);
  Step onFrame(DeviceId id, const Frame& frame, uint64_t nowMs);
  /** The device's keys that are really down now (after a SYN_DROPPED): the difference is fed as presses and releases. */
  Step resync(DeviceId id, const std::vector<uint16_t>& downCodes, uint64_t nowMs);
  /** Handles the result of a decision call that did not come from a frame (config, enable, suspend). */
  Step apply(const Result& r, uint64_t nowMs);
  Step tick(uint64_t nowMs);

  bool pointerWanted() const { return wanted_; }

 private:
  Result feed(const InputEvent& e, DeviceId dev, Step& step, Frame& kept);
  void finish(const Result& r, Step& step);
  void syncPointer(Step& step);
  DeviceId deviceForKey(uint32_t vk) const;
  DeviceId deviceForButton(Btn b) const;
  DeviceId firstOf(bool keyboard) const;

  Decision& dec_;
  std::map<DeviceId, DeviceKind> devices_;
  std::map<DeviceId, std::set<uint16_t>> down_;  // EV_KEY codes each device holds down
  std::vector<DeviceId> keyDevice_;              // by VK: the device that last produced it
  std::vector<uint16_t> keyCode_;                // by VK: the code it came in as
  std::vector<DeviceId> buttonDevice_;           // by Btn
  int64_t x_ = 0;                                // the virtual pointer: the sum of every REL_X and REL_Y
  int64_t y_ = 0;
  int64_t anchorX_ = 0;                          // where the current gesture's press happened
  int64_t anchorY_ = 0;
  bool wanted_ = false;
};

}  // namespace lp::evdev
