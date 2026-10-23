// Build with output.cpp and json.cpp, then run. --measure reports the same workload on an earlier revision.
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "../../native/hook-helper/src/output.h"

namespace {
using Clock = std::chrono::steady_clock;
using Kind = lp::Emit::Kind;
using Wheel = lp::WheelKind;

class SlowConsumer {
  std::mutex mutex_;
  std::condition_variable changed_;
  bool entered_ = false;
  bool released_ = false;
  bool succeeds_;
  std::vector<std::string> lines_;

 public:
  lp::Output output;

  explicit SlowConsumer(size_t capacity = 4096, bool succeeds = true)
      : succeeds_(succeeds), output([this](const std::string& line) {
          std::unique_lock<std::mutex> lock(mutex_);
          entered_ = true;
          changed_.notify_all();
          changed_.wait(lock, [this] { return released_; });
          if (!succeeds_) return false;
          lines_.push_back(line);
          return true;
        }, capacity) {}

  ~SlowConsumer() { release(); }

  void block() {
    output.ready();
    std::unique_lock<std::mutex> lock(mutex_);
    if (!changed_.wait_for(lock, std::chrono::seconds(5), [this] { return entered_; })) {
      lock.unlock();
      release();
      throw std::runtime_error("writer did not reach the blocked consumer");
    }
  }

  void release() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      released_ = true;
    }
    changed_.notify_all();
  }

  const std::vector<std::string>& finish() {
    release();
    output.stop();
    return lines_;
  }
};

lp::Emit point(Kind kind, int x, Wheel wheel = Wheel::Ping) {
  lp::Emit event{kind};
  event.x = x;
  event.y = 100;
  event.wheel = wheel;
  return event;
}

void compare(const std::vector<std::string>& actual, const std::vector<std::string>& expected, const char* scenario) {
  if (actual == expected) return;
  std::cerr << scenario << ": expected " << expected.size() << " messages, received " << actual.size() << '\n';
  for (size_t i = 0; i < std::max(actual.size(), expected.size()); ++i) {
    const std::string a = i < actual.size() ? actual[i] : "<absent>";
    const std::string e = i < expected.size() ? expected[i] : "<absent>";
    if (a != e) std::cerr << "  message " << i << ": expected " << e << "; received " << a << '\n';
  }
  throw std::runtime_error(scenario);
}

void backpressure(bool measureOnly) {
  constexpr int moves = 8000;
  SlowConsumer consumer;
  consumer.block();
  const auto start = Clock::now();
  consumer.output.emit(point(Kind::WheelOpen, 100));
  for (int x = 101; x <= 100 + moves; ++x) consumer.output.emit(point(Kind::WheelMove, x));
  consumer.output.emit(point(Kind::WheelRelease, 100 + moves));
  consumer.output.emit({Kind::Cancel});
  const auto enqueueUs = std::chrono::duration<double, std::micro>(Clock::now() - start).count();
  const auto& lines = consumer.finish();
  size_t bytes = 0;
  for (const auto& line : lines) bytes += line.size() + 1;
  std::cout << "backpressure: moves=" << moves << " messages=" << lines.size() << " bytes=" << bytes
            << " dropped=" << consumer.output.dropped() << " enqueue_us=" << enqueueUs << '\n';
  if (measureOnly) return;
  compare(lines, {
    R"({"type":"ready","version":4})",
    R"({"type":"wheelOpen","x":100,"y":100,"wheel":"ping"})",
    R"({"type":"wheelMove","x":8100,"y":100,"wheel":"ping"})",
    R"({"type":"wheelRelease","x":8100,"y":100,"wheel":"ping"})",
    R"({"type":"cancel"})",
  }, "backpressure preserves the latest position and closing events");
  if (consumer.output.dropped() != 0) throw std::runtime_error("moves exhausted the queue");
  consumer.output.emit(point(Kind::WheelOpen, 999));
  consumer.output.line("after stop");
  consumer.output.stop();
  if (lines.size() != 5) throw std::runtime_error("stopped output accepted another message");
}

void boundaries() {
  SlowConsumer consumer;
  consumer.block();
  for (const auto event : {
      point(Kind::WheelOpen, 0), point(Kind::WheelMove, 1), point(Kind::WheelMove, 2),
      point(Kind::WheelMove, 3, Wheel::Emote), point(Kind::WheelMove, 4, Wheel::Emote),
      point(Kind::WheelRelease, 5, Wheel::Emote), point(Kind::WheelMove, 6, Wheel::Emote),
    }) consumer.output.emit(event);
  consumer.output.emit({Kind::Cancel});
  consumer.output.emit(point(Kind::WheelOpen, 7, Wheel::Emote));
  consumer.output.emit(point(Kind::WheelMove, 8, Wheel::Emote));
  consumer.output.line("boundary");
  consumer.output.emit(point(Kind::WheelMove, 9, Wheel::Emote));
  consumer.output.emit(point(Kind::Click, 10, Wheel::Emote));
  lp::Emit toggled{Kind::Toggled};
  toggled.enabled = true;
  consumer.output.emit(toggled);
  consumer.output.emit(point(Kind::WheelMove, 11));
  consumer.output.emit({Kind::TextRequested});
  consumer.output.emit(point(Kind::WheelMove, 12));
  lp::Emit panel{Kind::Panel};
  panel.show = true;
  consumer.output.emit(panel);
  consumer.output.emit(point(Kind::WheelMove, 13));
  compare(consumer.finish(), {
    R"({"type":"ready","version":4})",
    R"({"type":"wheelOpen","x":0,"y":100,"wheel":"ping"})",
    R"({"type":"wheelMove","x":2,"y":100,"wheel":"ping"})",
    R"({"type":"wheelMove","x":4,"y":100,"wheel":"emote"})",
    R"({"type":"wheelRelease","x":5,"y":100,"wheel":"emote"})",
    R"({"type":"wheelMove","x":6,"y":100,"wheel":"emote"})",
    R"({"type":"cancel"})",
    R"({"type":"wheelOpen","x":7,"y":100,"wheel":"emote"})",
    R"({"type":"wheelMove","x":8,"y":100,"wheel":"emote"})",
    "boundary",
    R"({"type":"wheelMove","x":9,"y":100,"wheel":"emote"})",
    R"({"type":"click","x":10,"y":100,"wheel":"emote"})",
    R"({"type":"toggled","enabled":true})",
    R"({"type":"wheelMove","x":11,"y":100,"wheel":"ping"})",
    R"({"type":"textRequested"})",
    R"({"type":"wheelMove","x":12,"y":100,"wheel":"ping"})",
    R"({"type":"panel","show":true})",
    R"({"type":"wheelMove","x":13,"y":100,"wheel":"ping"})",
  }, "wheel identity and control messages separate move runs");
}

void capacity() {
  SlowConsumer consumer(3);
  consumer.block();
  consumer.output.emit(point(Kind::WheelOpen, 1));
  consumer.output.emit({Kind::Cancel});
  consumer.output.emit(point(Kind::Click, 2));
  consumer.output.emit(point(Kind::WheelRelease, 3));
  compare(consumer.finish(), {
    R"({"type":"ready","version":4})",
    R"({"type":"wheelOpen","x":1,"y":100,"wheel":"ping"})",
    R"({"type":"cancel"})",
    R"({"type":"click","x":2,"y":100,"wheel":"ping"})",
  }, "critical-only queue retains its capacity and FIFO contract");
  if (consumer.output.dropped() != 1) throw std::runtime_error("critical-only overflow count changed");
}

void failedWriter() {
  SlowConsumer consumer(4, false);
  consumer.block();
  consumer.output.emit(point(Kind::WheelOpen, 1));
  consumer.output.emit(point(Kind::WheelMove, 2));
  consumer.output.emit(point(Kind::WheelMove, 3));
  consumer.output.emit(point(Kind::WheelRelease, 4));
  if (!consumer.finish().empty()) throw std::runtime_error("failed writer delivered a message");
  if (consumer.output.dropped() != 3) throw std::runtime_error("failed writer did not discard its pending queue");
  consumer.output.emit({Kind::Cancel});
  consumer.output.stop();
  if (consumer.output.dropped() != 3) throw std::runtime_error("failed output accepted more work");
  SlowConsumer restarted;
  restarted.block();
  restarted.output.emit(point(Kind::WheelOpen, 5));
  restarted.output.emit(point(Kind::WheelRelease, 6));
  compare(restarted.finish(), {
    R"({"type":"ready","version":4})",
    R"({"type":"wheelOpen","x":5,"y":100,"wheel":"ping"})",
    R"({"type":"wheelRelease","x":6,"y":100,"wheel":"ping"})",
  }, "replacement output starts with an empty queue");
}
}  // namespace

int main(int argc, char** argv) {
  try {
    const bool measureOnly = argc == 2 && std::string(argv[1]) == "--measure";
    if (argc > 2 || (argc == 2 && !measureOnly)) throw std::runtime_error("usage: output-scenario [--measure]");
    backpressure(measureOnly);
    if (!measureOnly) {
      boundaries();
      capacity();
      failedWriter();
      std::cout << "PASS: backpressure, boundaries, capacity, shutdown, writer failure and replacement\n";
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
