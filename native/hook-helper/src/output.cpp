#include "output.h"

#include "json.h"

namespace lp {

std::string formatEmit(const Emit& e) {
  const char* wheel = e.wheel == WheelKind::Emote ? "emote" : e.wheel == WheelKind::Ask ? "ask" : "ping";
  auto pt = [&](const char* type) {
    return std::string("{\"type\":\"") + type + "\",\"x\":" + std::to_string(e.x) + ",\"y\":" + std::to_string(e.y) +
           ",\"wheel\":\"" + wheel + "\"}";
  };
  switch (e.kind) {
    case Emit::Kind::WheelOpen: return pt("wheelOpen");
    case Emit::Kind::WheelMove: return pt("wheelMove");
    case Emit::Kind::WheelRelease: return pt("wheelRelease");
    case Emit::Kind::Click: return pt("click");
    case Emit::Kind::Cancel: return "{\"type\":\"cancel\"}";
    case Emit::Kind::Toggled: return std::string("{\"type\":\"toggled\",\"enabled\":") + (e.enabled ? "true" : "false") + "}";
    case Emit::Kind::TextRequested: return "{\"type\":\"textRequested\"}";
    case Emit::Kind::Panel: return std::string("{\"type\":\"panel\",\"show\":") + (e.show ? "true" : "false") + "}";
    case Emit::Kind::TriggerUp: return std::string("{\"type\":\"triggerUp\",\"wheel\":\"") + wheel + "\"}";
    case Emit::Kind::AskWords: return "{\"type\":\"askWords\",\"x\":" + std::to_string(e.x) + ",\"y\":" + std::to_string(e.y) + "}";
    case Emit::Kind::Scroll: return "{\"type\":\"scroll\",\"x\":" + std::to_string(e.x) + ",\"y\":" + std::to_string(e.y) + "}";
  }
  return "{}";
}

Output::Output(Writer writer, size_t maxQueued) : writer_(std::move(writer)), max_(maxQueued), thread_([this] { run(); }) {}

Output::~Output() { stop(); }

void Output::enqueue(Message message) {
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (stopping_) return;
    if (const auto* move = std::get_if<Emit>(&message);
        move && move->kind == Emit::Kind::WheelMove && !q_.empty()) {
      auto* pending = std::get_if<Emit>(&q_.back());
      if (pending && pending->kind == Emit::Kind::WheelMove && pending->wheel == move->wheel) {
        *pending = *move;
        return;
      }
    }
    if (q_.size() >= max_) {
      ++dropped_;
      return;
    }
    q_.push_back(std::move(message));
  }
  cv_.notify_one();
}

void Output::line(std::string s) { enqueue(std::move(s)); }

void Output::emit(const Emit& e) { enqueue(e); }

// Version 6: the config takes askDoubleTap; askWords and scroll events and the staleWatch command are new.
void Output::ready() { line("{\"type\":\"ready\",\"version\":6}"); }

void Output::error(const std::string& message) { line("{\"type\":\"error\",\"message\":\"" + jsonEscape(message) + "\"}"); }

void Output::error(const std::string& code, const std::string& message) {
  line("{\"type\":\"error\",\"code\":\"" + jsonEscape(code) + "\",\"message\":\"" + jsonEscape(message) + "\"}");
}

void Output::stop() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    stopping_ = true;
  }
  cv_.notify_one();
  if (thread_.joinable()) thread_.join();
}

size_t Output::dropped() const {
  std::lock_guard<std::mutex> lk(mu_);
  return dropped_;
}

void Output::run() {
  std::unique_lock<std::mutex> lk(mu_);
  while (true) {
    cv_.wait(lk, [this] { return !q_.empty() || stopping_; });
    if (q_.empty()) return;  // stopping and fully drained
    Message message = std::move(q_.front());
    q_.pop_front();
    lk.unlock();
    const auto* event = std::get_if<Emit>(&message);
    const bool ok = event ? writer_(formatEmit(*event)) : writer_(std::get<std::string>(message));
    lk.lock();
    if (!ok) {  // Electron is gone: drop the rest
      dropped_ += q_.size();
      q_.clear();
      stopping_ = true;
      return;
    }
  }
}

}  // namespace lp
