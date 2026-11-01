#include "../../native/hook-helper/src/decision.h"

#include <array>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string_view>

namespace {
constexpr std::array<uint32_t, 11> keys{0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x10, 0xA0, 0xA1, 0x5B, 0x5C};

// The input fixture groups generic, left and right keys by their documented modifier meaning.
uint32_t modifiers(unsigned held) {
  return ((held & 0x007) ? lp::ModCtrl : 0) | ((held & 0x038) ? lp::ModAlt : 0) |
         ((held & 0x1C0) ? lp::ModShift : 0) | ((held & 0x600) ? lp::ModWin : 0);
}

void key(lp::Decision& decision, uint32_t vk, lp::EvKind kind) {
  lp::InputEvent event;
  event.kind = kind;
  event.vk = vk;
  decision.onEvent(event);
}

void toggle(lp::Decision& decision, uint32_t chord, bool expected) {
  lp::Config config;
  config.trigger = lp::Trigger::None;
  config.toggleMods = chord;
  decision.setConfig(config);
  lp::InputEvent event;
  event.kind = lp::EvKind::KeyDown;
  event.vk = config.toggleVk;
  const auto result = decision.onEvent(event);
  if (result.swallow != expected || decision.enabled() == expected ||
      result.emits.size() != (expected ? 1u : 0u) ||
      (expected && (result.emits.front().kind != lp::Emit::Kind::Toggled || result.emits.front().enabled))) {
    throw std::runtime_error("modifier chord produced the wrong toggle result");
  }
  key(decision, config.toggleVk, lp::EvKind::KeyUp);
}

void measure() {
  for (const std::string_view workload : {"typing", "idle-click", "active-drag"}) {
    lp::Decision decision;
    lp::InputEvent event;
    event.btn = lp::Btn::Left;
    event.vk = 'A';
    if (workload == "active-drag") {
      key(decision, 0xA4, lp::EvKind::KeyDown);
      event.kind = lp::EvKind::MouseDown;
      decision.onEvent(event);
      event.kind = lp::EvKind::MouseMove;
      event.x = 100;
      decision.onEvent(event);
    }
    constexpr int count = 1'000'000;
    size_t observed = 0;
    const auto start = std::chrono::steady_clock::now();
    for (int n = 0; n < count; ++n) {
      if (workload == "typing") event.kind = n % 2 ? lp::EvKind::KeyUp : lp::EvKind::KeyDown;
      else if (workload == "idle-click") event.kind = n % 2 ? lp::EvKind::MouseUp : lp::EvKind::MouseDown;
      else event.x = n % 1000;
      const auto result = decision.onEvent(event);
      observed += result.swallow + result.emits.size() + result.injects.size();
    }
    const double ns = std::chrono::duration<double, std::nano>(std::chrono::steady_clock::now() - start).count() / count;
    std::cout << "{\"workload\":\"" << workload << "\",\"events\":" << count
              << ",\"nsPerEvent\":" << ns << ",\"observed\":" << observed << "}\n";
  }
}
}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string_view(argv[1]) == "--measure") {
      measure();
      return 0;
    }
    for (unsigned held = 0; held < (1u << keys.size()); ++held) {
      lp::Decision decision;
      lp::Config config;
      config.trigger = lp::Trigger::None;
      decision.setConfig(config);
      for (size_t i = 0; i < keys.size(); ++i) {
        if (held & (1u << i)) key(decision, keys[i], lp::EvKind::KeyDown);
      }
      // Ordinary keys contribute no modifier bits, including while they remain pressed.
      for (uint32_t vk : {0x41u, 0x42u, 0x43u}) key(decision, vk, lp::EvKind::KeyDown);
      toggle(decision, modifiers(held), true);
      toggle(decision, modifiers(held) ^ lp::ModCtrl, false);
      for (size_t i = 0; i < keys.size(); ++i) {
        key(decision, keys[i], lp::EvKind::KeyUp);
        toggle(decision, modifiers(held & ~(1u << i)), true);
        if (held & (1u << i)) key(decision, keys[i], lp::EvKind::KeyDown);
      }
      decision.syncKeyStates([](uint32_t) { return false; });
      toggle(decision, 0, true);
    }
    std::cout << "{\"scenario\":\"modifier lifecycle\",\"heldCombinations\":2048,\"toggleChecks\":28672}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
}
