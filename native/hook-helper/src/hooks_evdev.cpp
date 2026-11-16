// Linux evdev + uinput backend, for Wayland sessions where no program can watch or hold back another's input.
// Each keyboard and mouse is grabbed (EVIOCGRAB) and mirrored by a uinput clone. Every event the decision does not
// swallow is written to the clone in the order it arrived, so the compositor sees the same input as without lolPing.
// If this process dies, the kernel drops the grabs and destroys the clones with the file descriptors.
#include "hooks_evdev.h"

#include <dirent.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <poll.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "commands.h"
#include "evdev_logic.h"

namespace lp {
namespace {

namespace ev = lp::evdev;

constexpr uint64_t kTickMs = 25;
constexpr uint64_t kSettleMs = 150;       // a new clone needs this long to be picked up by the compositor
constexpr uint64_t kKeysDownRetryMs = 50;
constexpr uint64_t kOpenRetryMs = 100;
constexpr uint64_t kOpenGiveUpMs = 5000;  // a node udev has not made readable yet
constexpr uint64_t kWatchdogMs = 200;
constexpr size_t kMaxGrabbed = 128;
constexpr size_t kMaxFrameEvents = 4096;

uint64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

// The grabbed descriptors (fd + 1, 0 = free slot), readable by the watchdog thread without a lock: if the loop is
// stuck it may be holding any lock.
std::array<std::atomic<int>, kMaxGrabbed> g_grabbed{};

int claimSlot(int fd) {
  for (size_t i = 0; i < g_grabbed.size(); ++i) {
    if (g_grabbed[i].load() == 0) {
      g_grabbed[i].store(fd + 1);
      return static_cast<int>(i);
    }
  }
  return -1;
}

// Gives every device back to the system and ends the process, when the loop that forwards input has stopped.
void watchdog(const std::atomic<uint64_t>& lastTick, const std::atomic<bool>& stop) {
  while (!stop.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
    if (stop.load()) return;
    if (nowMs() - lastTick.load() <= kWatchdogMs) continue;
    bool any = false;
    for (auto& s : g_grabbed) {
      const int fd = s.load() - 1;
      if (fd < 0) continue;
      ::ioctl(fd, EVIOCGRAB, 0);
      any = true;
    }
    if (any) _exit(4);
    // Nothing is grabbed, so nothing is held back: the loop may be slow, and that is harmless.
  }
}

template <size_t N>
void readBits(int fd, int type, std::bitset<N>& out) {
  unsigned char buf[(N + 7) / 8] = {};
  if (::ioctl(fd, EVIOCGBIT(type, sizeof(buf)), buf) < 0) return;
  for (size_t i = 0; i < N; ++i) {
    if ((buf[i / 8] >> (i % 8)) & 1) out.set(i);
  }
}

std::string ioctlString(int fd, unsigned long req) {
  char buf[256] = {};
  if (::ioctl(fd, req, buf) < 0) return std::string();
  return std::string(buf);
}

ev::DeviceCaps readCaps(int fd) {
  ev::DeviceCaps c;
  c.name = ioctlString(fd, EVIOCGNAME(255));
  c.phys = ioctlString(fd, EVIOCGPHYS(255));
  readBits(fd, 0, c.ev);
  if (c.ev[EV_KEY]) readBits(fd, EV_KEY, c.key);
  if (c.ev[EV_REL]) readBits(fd, EV_REL, c.rel);
  if (c.ev[EV_ABS]) readBits(fd, EV_ABS, c.abs);
  return c;
}

// Which keys and buttons the device holds down right now.
std::vector<uint16_t> keysDown(int fd) {
  unsigned char keys[KEY_MAX / 8 + 1] = {};
  std::vector<uint16_t> down;
  if (::ioctl(fd, EVIOCGKEY(sizeof(keys)), keys) < 0) return down;
  for (int code = 0; code <= KEY_MAX; ++code) {
    if ((keys[code / 8] >> (code % 8)) & 1) down.push_back(static_cast<uint16_t>(code));
  }
  return down;
}

int openUinput() {
  for (const char* path : {"/dev/uinput", "/dev/input/uinput", "/dev/misc/uinput"}) {
    const int fd = ::open(path, O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd >= 0) return fd;
  }
  return -1;
}

// The clone's capabilities beyond what classify() looks at.
struct Extras {
  input_id id{};
  std::bitset<MSC_CNT> msc;
  std::bitset<LED_CNT> led;
  std::bitset<INPUT_PROP_CNT> props;
};

Extras readExtras(int fd, const ev::DeviceCaps& caps) {
  Extras x;
  ::ioctl(fd, EVIOCGID, &x.id);
  if (caps.ev[EV_MSC]) readBits(fd, EV_MSC, x.msc);
  if (caps.ev[EV_LED]) readBits(fd, EV_LED, x.led);
  unsigned char props[(INPUT_PROP_CNT + 7) / 8] = {};
  if (::ioctl(fd, EVIOCGPROP(sizeof(props)), props) >= 0) {
    for (size_t i = 0; i < INPUT_PROP_CNT; ++i) {
      if ((props[i / 8] >> (i % 8)) & 1) x.props.set(i);
    }
  }
  return x;
}

// A uinput device with the same name, ids, keys, axes and properties as the real one, so the compositor treats it
// the same way. Not copied: EV_REP (the real device's kernel repeat events are forwarded, a second repeater on the
// clone would double them), sounds, force feedback. Its phys string marks it as ours.
int createClone(int fd, const ev::DeviceCaps& caps, const Extras& x) {
  const int ui = openUinput();
  if (ui < 0) return -1;
  bool ok = true;
  const auto set = [&](unsigned long req, int value) { ok = ::ioctl(ui, req, value) >= 0 && ok; };
  for (const int type : {EV_KEY, EV_REL, EV_ABS, EV_MSC, EV_LED}) {
    if (caps.ev[static_cast<size_t>(type)]) set(UI_SET_EVBIT, type);
  }
  for (int c = 0; c <= KEY_MAX; ++c) {
    if (caps.key[static_cast<size_t>(c)]) set(UI_SET_KEYBIT, c);
  }
  for (int c = 0; c <= REL_MAX; ++c) {
    if (caps.rel[static_cast<size_t>(c)]) set(UI_SET_RELBIT, c);
  }
  for (int c = 0; c <= MSC_MAX; ++c) {
    if (x.msc[static_cast<size_t>(c)]) set(UI_SET_MSCBIT, c);
  }
  for (int c = 0; c <= LED_MAX; ++c) {
    if (x.led[static_cast<size_t>(c)]) set(UI_SET_LEDBIT, c);
  }
  for (int c = 0; c <= ABS_MAX; ++c) {
    if (!caps.abs[static_cast<size_t>(c)]) continue;
    set(UI_SET_ABSBIT, c);
    uinput_abs_setup abs{};
    abs.code = static_cast<__u16>(c);
    if (::ioctl(fd, EVIOCGABS(c), &abs.absinfo) >= 0) ok = ::ioctl(ui, UI_ABS_SETUP, &abs) >= 0 && ok;
  }
  for (int p = 0; p < INPUT_PROP_CNT; ++p) {
    if (x.props[static_cast<size_t>(p)]) set(UI_SET_PROPBIT, p);
  }
  ok = ::ioctl(ui, UI_SET_PHYS, ev::kClonePhys) >= 0 && ok;
  uinput_setup setup{};
  setup.id = x.id;
  std::strncpy(setup.name, caps.name.c_str(), UINPUT_MAX_NAME_SIZE - 1);
  ok = ::ioctl(ui, UI_DEV_SETUP, &setup) >= 0 && ok;
  if (!ok || ::ioctl(ui, UI_DEV_CREATE) < 0) {
    ::close(ui);
    return -1;
  }
  return ui;
}

struct Device {
  int id = 0;
  std::string path;
  std::string name;
  ev::DeviceKind kind = ev::DeviceKind::Skip;
  int fd = -1;
  int ui = -1;
  bool active = false;   // grabbed and known to the core; otherwise its clone is settling
  uint64_t readyAt = 0;  // when a settling device may be grabbed
  int slot = -1;
  ev::Frame frame;
  bool dropped = false;  // the kernel's buffer overflowed: ignore events up to the next SYN_REPORT
};

enum class Prepared { Done, Skip, Retry };

class Backend {
 public:
  explicit Backend(Output& o) : out_(o), core_(decision_) {
    decision_.setMaskMenuKeys(false);
    decision_.setPanelRepeatGap(0);  // like X11: a swallowed key's repeats are not a reliable sign it is still down
  }

  ~Backend() {
    for (const int id : ids()) destroy(id);
    if (inotify_ >= 0) ::close(inotify_);
  }

  bool start() {
    inotify_ = ::inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (inotify_ >= 0) ::inotify_add_watch(inotify_, "/dev/input", IN_CREATE | IN_DELETE | IN_ATTRIB);
    return true;
  }

  int run();

 private:
  std::vector<int> ids() const {
    std::vector<int> v;
    for (const auto& [id, d] : devices_) v.push_back(id);
    return v;
  }
  // Nothing is held until the app's first config arrives. Suspended or paused: the keyboards stay, so the toggle
  // chord still works; the mice are given back.
  bool wants(ev::DeviceKind kind) const {
    if (!configured_ || suspended_) return false;
    return decision_.enabled() || kind == ev::DeviceKind::Keyboard || kind == ev::DeviceKind::Both;
  }
  bool known(const std::string& path) const {
    for (const auto& [id, d] : devices_) {
      if (d.path == path) return true;
    }
    return false;
  }
  void scan(uint64_t now);
  void consider(const std::string& path, uint64_t now);
  Prepared prepare(const std::string& path, uint64_t now);
  void settle(uint64_t now);
  void destroy(int id);
  void execute(const ev::Step& step);
  bool write(Device& d, const ev::Frame& frame);
  void readDevice(Device& d, uint64_t now);
  void forwardLeds(Device& d);
  void readHotplug(uint64_t now);
  void command(const std::string& line, uint64_t now);
  void reconcile(uint64_t now);
  void reap();

  Output& out_;
  Decision decision_;
  ev::EvdevCore core_;
  std::map<int, Device> devices_;
  std::map<std::string, std::pair<uint64_t, uint64_t>> retry_;  // path -> next try, give up at (0: never)
  std::set<std::string> busyLogged_;
  std::vector<int> doomed_;
  int nextId_ = 1;
  int inotify_ = -1;
  bool configured_ = false;
  bool suspended_ = false;
  bool lastEnabled_ = true;
  bool lastSuspended_ = false;
  bool lastConfigured_ = false;
  bool uinputLogged_ = false;
  bool quit_ = false;
};

void Backend::scan(uint64_t now) {
  DIR* dir = ::opendir("/dev/input");
  if (!dir) return;
  std::vector<std::string> paths;
  while (const dirent* e = ::readdir(dir)) {
    if (std::strncmp(e->d_name, "event", 5) == 0) paths.push_back(std::string("/dev/input/") + e->d_name);
  }
  ::closedir(dir);
  for (const auto& path : paths) {
    if (!known(path)) consider(path, now);
  }
}

void Backend::consider(const std::string& path, uint64_t now) {
  const Prepared p = prepare(path, now);
  if (p == Prepared::Retry) {
    const auto it = retry_.find(path);
    retry_[path] = {now + kOpenRetryMs, it == retry_.end() ? now + kOpenGiveUpMs : it->second.second};
  } else {
    retry_.erase(path);
  }
}

// Opens the node, and if it is a keyboard or mouse we want, creates its clone. The grab comes later, once the
// clone has settled (settle()), so the input typed in between still reaches the compositor.
Prepared Backend::prepare(const std::string& path, uint64_t now) {
  int fd = ::open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0 && (errno == EACCES || errno == EPERM)) fd = ::open(path.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return (errno == EACCES || errno == EPERM) ? Prepared::Retry : Prepared::Skip;
  if (busyLogged_.count(path)) {  // held by another program: not tried again until the next pause or resume
    ::close(fd);
    return Prepared::Skip;
  }
  const ev::DeviceCaps caps = readCaps(fd);
  const ev::DeviceKind kind = ev::classify(caps);
  if (kind == ev::DeviceKind::Skip || !wants(kind) || devices_.size() >= kMaxGrabbed) {
    ::close(fd);
    return Prepared::Skip;
  }
  const int ui = createClone(fd, caps, readExtras(fd, caps));
  if (ui < 0) {
    if (!uinputLogged_) std::cerr << "evdev: cannot create a virtual device for " << caps.name << " (" << path << ")\n";
    uinputLogged_ = true;
    ::close(fd);
    return Prepared::Skip;
  }
  Device d;
  d.id = nextId_++;
  d.path = path;
  d.name = caps.name;
  d.kind = kind;
  d.fd = fd;
  d.ui = ui;
  d.readyAt = now + kSettleMs;
  devices_[d.id] = d;
  return Prepared::Done;
}

// Grabs the devices whose clones have settled. A key or button that is down is waited out: the compositor saw its
// press from the real device, so after the grab its release would never come.
void Backend::settle(uint64_t now) {
  for (const int id : ids()) {
    const auto it = devices_.find(id);
    if (it == devices_.end()) continue;
    Device& d = it->second;
    if (d.active || now < d.readyAt) continue;
    if (!wants(d.kind)) {
      destroy(id);
      continue;
    }
    if (!keysDown(d.fd).empty()) {
      d.readyAt = now + kKeysDownRetryMs;
      continue;
    }
    if (::ioctl(d.fd, EVIOCGRAB, 1) < 0) {
      if (busyLogged_.insert(d.path).second) {
        std::cerr << "evdev: " << d.name << " (" << d.path << ") is grabbed by another program, leaving it alone ("
                  << std::strerror(errno) << ")\n";
      }
      destroy(id);
      continue;
    }
    d.slot = claimSlot(d.fd);
    if (d.slot < 0) {
      ::ioctl(d.fd, EVIOCGRAB, 0);
      destroy(id);
      continue;
    }
    // What queued up before the grab was also delivered to the compositor directly: forwarding it would repeat it.
    input_event junk[64];
    while (::read(d.fd, junk, sizeof(junk)) > 0) {
    }
    d.active = true;
    core_.addDevice(d.id, d.kind);
  }
}

void Backend::destroy(int id) {
  const auto it = devices_.find(id);
  if (it == devices_.end()) return;
  Device& d = it->second;
  if (d.active) {
    // Release what it held for the decision (its writes go to the clone, which still exists), then give the device back.
    execute(core_.removeDevice(id, nowMs()));
    ::ioctl(d.fd, EVIOCGRAB, 0);
    if (d.slot >= 0) g_grabbed[static_cast<size_t>(d.slot)].store(0);
  }
  ::close(d.fd);
  if (d.ui >= 0) {
    ::ioctl(d.ui, UI_DEV_DESTROY);
    ::close(d.ui);
  }
  devices_.erase(it);
}

void Backend::reap() {
  while (!doomed_.empty()) {
    const int id = doomed_.back();
    doomed_.pop_back();
    destroy(id);
  }
}

bool Backend::write(Device& d, const ev::Frame& frame) {
  std::vector<input_event> buf(frame.size());
  std::memset(buf.data(), 0, buf.size() * sizeof(input_event));
  for (size_t i = 0; i < frame.size(); ++i) {
    buf[i].type = frame[i].type;
    buf[i].code = frame[i].code;
    buf[i].value = frame[i].value;
  }
  const char* p = reinterpret_cast<const char*>(buf.data());
  size_t left = buf.size() * sizeof(input_event);
  int stalls = 0;
  while (left > 0) {
    const ssize_t n = ::write(d.ui, p, left);
    if (n > 0) {
      p += n;
      left -= static_cast<size_t>(n);
    } else if (n < 0 && errno == EINTR) {
      continue;
    } else if (n < 0 && errno == EAGAIN && ++stalls < 5) {
      pollfd pfd{d.ui, POLLOUT, 0};
      ::poll(&pfd, 1, 5);
    } else {
      return false;
    }
  }
  return true;
}

void Backend::execute(const ev::Step& step) {
  for (const auto& w : step.writes) {
    const auto it = devices_.find(w.device);
    if (it == devices_.end()) continue;
    Device& d = it->second;
    if (std::find(doomed_.begin(), doomed_.end(), d.id) != doomed_.end()) continue;
    if (write(d, w.frame)) continue;
    // The clone no longer takes input: let the real device through again at once, then drop it.
    std::cerr << "evdev: writing to the virtual device for " << d.name << " failed (" << std::strerror(errno) << ")\n";
    ::ioctl(d.fd, EVIOCGRAB, 0);
    doomed_.push_back(d.id);
  }
  for (const auto& m : step.messages) out_.line(m.text());
}

void Backend::readDevice(Device& d, uint64_t now) {
  for (int round = 0; round < 16; ++round) {
    input_event buf[64];
    const ssize_t n = ::read(d.fd, buf, sizeof(buf));
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno != EAGAIN) doomed_.push_back(d.id);  // ENODEV: unplugged
      return;
    }
    if (n == 0) return;
    const size_t count = static_cast<size_t>(n) / sizeof(input_event);
    for (size_t i = 0; i < count; ++i) {
      const input_event& e = buf[i];
      if (e.type == EV_SYN && e.code == SYN_DROPPED) {
        d.frame.clear();
        d.dropped = true;
        continue;
      }
      d.frame.push_back(ev::Event{e.type, e.code, e.value});
      if (e.type != EV_SYN || e.code != SYN_REPORT) {
        if (d.frame.size() > kMaxFrameEvents) d.frame.clear();
        continue;
      }
      ev::Frame frame;
      frame.swap(d.frame);
      if (d.dropped) {
        // Events were lost: what the device holds down now is what counts.
        d.dropped = false;
        execute(core_.resync(d.id, keysDown(d.fd), now));
      } else {
        execute(core_.onFrame(d.id, frame, now));
      }
      if (std::find(doomed_.begin(), doomed_.end(), d.id) != doomed_.end()) return;
    }
    if (static_cast<size_t>(n) < sizeof(buf)) return;
  }
}

// The compositor sets the lock LEDs on the clone; the real keyboard has the lamps.
void Backend::forwardLeds(Device& d) {
  input_event e;
  while (::read(d.ui, &e, sizeof(e)) == static_cast<ssize_t>(sizeof(e))) {
    if (e.type == EV_LED && ::write(d.fd, &e, sizeof(e)) < 0) break;
  }
}

void Backend::readHotplug(uint64_t now) {
  alignas(inotify_event) char buf[4096];
  while (true) {
    const ssize_t n = ::read(inotify_, buf, sizeof(buf));
    if (n <= 0) return;
    for (ssize_t off = 0; off < n;) {
      const auto* e = reinterpret_cast<const inotify_event*>(buf + off);
      off += static_cast<ssize_t>(sizeof(inotify_event) + e->len);
      if (e->len == 0 || std::strncmp(e->name, "event", 5) != 0) continue;
      const std::string path = std::string("/dev/input/") + e->name;
      if (e->mask & IN_DELETE) {
        retry_.erase(path);
        for (auto& [id, d] : devices_) {
          if (d.path == path) doomed_.push_back(id);
        }
      } else if (!known(path)) {
        consider(path, now);  // IN_ATTRIB fires when udev makes a new node readable
      }
    }
  }
}

void Backend::command(const std::string& line, uint64_t now) {
  const Command c = parseCommand(line, decision_.config());
  switch (c.kind) {
    case Command::Kind::Config:
      configured_ = true;
      execute(core_.apply(decision_.setConfig(c.config), now));
      break;
    case Command::Kind::SetEnabled: execute(core_.apply(decision_.setEnabled(c.flag), now)); break;
    case Command::Kind::Suspend:
      suspended_ = c.flag;
      execute(core_.apply(decision_.setSuspended(c.flag), now));
      break;
    case Command::Kind::StaleWatch: execute(core_.apply(decision_.setStaleWatch(c.flag), now)); break;
    case Command::Kind::Shutdown: quit_ = true; break;
    default: out_.error("invalid command: " + line); break;
  }
  reconcile(now);
}

// A change of state (first config, pause, suspend) decides which devices are held.
void Backend::reconcile(uint64_t now) {
  const bool enabled = decision_.enabled();
  if (enabled == lastEnabled_ && suspended_ == lastSuspended_ && configured_ == lastConfigured_) return;
  lastEnabled_ = enabled;
  lastSuspended_ = suspended_;
  lastConfigured_ = configured_;
  busyLogged_.clear();
  for (const int id : ids()) {
    const auto it = devices_.find(id);
    if (it != devices_.end() && !wants(it->second.kind)) destroy(id);
  }
  scan(now);
}

int Backend::run() {
  std::atomic<uint64_t> lastTick{nowMs()};
  std::atomic<bool> stopWatchdog{false};
  std::thread dog(watchdog, std::cref(lastTick), std::cref(stopWatchdog));
  std::string pending;
  std::vector<pollfd> fds;
  struct Owner {
    int id;
    bool clone;
  };
  std::vector<Owner> owners;
  while (!quit_) {
    fds.clear();
    owners.clear();
    fds.push_back({STDIN_FILENO, POLLIN, 0});
    fds.push_back({inotify_, POLLIN, 0});
    for (const auto& [id, d] : devices_) {
      if (!d.active) continue;
      fds.push_back({d.fd, POLLIN, 0});
      owners.push_back({id, false});
      fds.push_back({d.ui, POLLIN, 0});
      owners.push_back({id, true});
    }
    const int ready = ::poll(fds.data(), fds.size(), static_cast<int>(kTickMs));
    const uint64_t now = nowMs();
    lastTick.store(now);
    if (ready < 0 && errno != EINTR) break;
    if (ready > 0) {
      for (size_t i = 2; i < fds.size(); ++i) {
        if (!fds[i].revents) continue;
        const auto it = devices_.find(owners[i - 2].id);
        if (it == devices_.end()) continue;
        if (owners[i - 2].clone) {
          if (fds[i].revents & POLLIN) forwardLeds(it->second);
        } else if (fds[i].revents & POLLIN) {
          readDevice(it->second, now);
        } else if (fds[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
          doomed_.push_back(it->first);
        }
      }
      if (fds[1].revents & POLLIN) readHotplug(now);
      if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
        char buf[4096];
        const ssize_t count = ::read(STDIN_FILENO, buf, sizeof(buf));
        if (count <= 0) break;  // Electron is gone
        pending.append(buf, static_cast<size_t>(count));
        size_t end;
        while ((end = pending.find('\n')) != std::string::npos) {
          command(pending.substr(0, end), now);
          pending.erase(0, end + 1);
          if (quit_) break;
        }
        if (pending.size() > 65536) {
          out_.error("command too long");
          break;
        }
      }
    }
    execute(core_.tick(now));
    reap();
    settle(now);
    for (auto it = retry_.begin(); it != retry_.end();) {
      const std::string path = it->first;
      const auto limits = it->second;
      ++it;
      if (now < limits.first) continue;
      if (limits.second != 0 && now > limits.second) {
        retry_.erase(path);
      } else if (!known(path)) {
        consider(path, now);
      }
    }
    reconcile(now);
    lastTick.store(nowMs());
  }
  stopWatchdog.store(true);
  dog.join();
  for (const int id : ids()) destroy(id);
  return 0;
}

// Without readable event nodes and /dev/uinput the backend cannot work; the app shows how to set that up.
bool hasAccess(Output& out) {
  const int ui = openUinput();
  if (ui < 0) {
    out.error("needsSetup", std::string("Cannot open /dev/uinput (") + std::strerror(errno) +
                                "). lolPing needs access to it to pass input through unchanged.");
    return false;
  }
  ::close(ui);
  DIR* dir = ::opendir("/dev/input");
  int readable = 0;
  int total = 0;
  if (dir) {
    while (const dirent* e = ::readdir(dir)) {
      if (std::strncmp(e->d_name, "event", 5) != 0) continue;
      ++total;
      const int fd = ::open((std::string("/dev/input/") + e->d_name).c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC);
      if (fd < 0) continue;
      ++readable;
      ::close(fd);
    }
    ::closedir(dir);
  }
  if (readable == 0) {
    out.error("needsSetup", total == 0 ? "No input devices found in /dev/input."
                                       : "Cannot read /dev/input/event*. lolPing needs access to see wheel gestures.");
    return false;
  }
  return true;
}

}  // namespace

int runEvdevHooks(Output& out) {
  if (!hasAccess(out)) return 3;
  Backend backend(out);
  backend.start();
  out.ready();
  return backend.run();
}

}  // namespace lp
