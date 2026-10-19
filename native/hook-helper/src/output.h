#pragma once
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "decision.h"

namespace lp {

/** One app the user can switch to: its process image's file name and the path of that image. */
struct AppEntry {
  std::string name;
  std::string path;
};

// Writes protocol lines on a background thread so the hook thread never blocks
// on a full stdout pipe. When the queue is full, new lines are dropped.
class Output {
 public:
  using Writer = std::function<bool(const std::string&)>;  // false = pipe is gone

  explicit Output(Writer writer, size_t maxQueued = 4096);
  ~Output();
  Output(const Output&) = delete;
  Output& operator=(const Output&) = delete;

  void line(std::string s);
  void emit(const Emit& e);
  void ready();
  void foregroundApp(const std::string& name);
  void appList(const std::vector<AppEntry>& apps);
  void error(const std::string& message);
  void error(const std::string& code, const std::string& message);  // machine-readable code, e.g. "noAccess"
  void stop();  // drains the queue, then joins the writer thread
  size_t dropped() const;

 private:
  void run();

  Writer writer_;
  size_t max_;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::deque<std::string> q_;
  bool stopping_ = false;
  size_t dropped_ = 0;
  std::thread thread_;  // declared last: starts after everything above is initialised
};

std::string formatEmit(const Emit& e);

}  // namespace lp
