// Unit tests for the context helper's platform-free part (no screen capture).
// Build and run: npm run test:helper
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "../src/context.h"
#include "../src/json.h"

using namespace lp::ctx;

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

Image blank(int w, int h, uint8_t v = 40) {
  Image img;
  img.w = w;
  img.h = h;
  img.px.assign(static_cast<size_t>(w) * h * 4, v);
  return img;
}

bool samePixel(const Image& a, const Image& b, int x, int y) {
  const size_t i = (static_cast<size_t>(y) * a.w + x) * 4;
  return a.px[i] == b.px[i] && a.px[i + 1] == b.px[i + 1] && a.px[i + 2] == b.px[i + 2];
}

std::map<std::string, std::string> fields(const std::string& line) {
  std::map<std::string, std::string> m;
  lp::parseFlatJson(line, m);
  return m;
}

// A capture command for display -1920,0 1920x1080 with two spots; `over` replaces fields (raw JSON values).
std::string captureLine(const std::map<std::string, std::string>& over = {}) {
  std::map<std::string, std::string> f{
      {"display", R"("-1920,0,1920,1080")"}, {"spots", R"("-1820,200;-420,900")"}, {"overview", "1600"},
      {"zoom", R"("1000,750")"}, {"quality", "80"}, {"dir", R"("C:\\Temp\\lp")"},
  };
  for (const auto& [k, v] : over) f[k] = v;
  std::string line = R"({"type":"capture","id":"a1")";
  for (const auto& [k, v] : f) line += ",\"" + k + "\":" + v;
  return line + "}";
}

}  // namespace

static void test_parse_capture_command() {
  const Command c = parseCommand(captureLine());
  CHECK(c.kind == Command::Kind::Capture);
  CHECK(c.id == "a1");
  CHECK(c.capture.display.x == -1920 && c.capture.display.y == 0);
  CHECK(c.capture.display.w == 1920 && c.capture.display.h == 1080);
  CHECK(c.capture.spots.size() == 2);
  CHECK(c.capture.spots[1].x == -420 && c.capture.spots[1].y == 900);
  CHECK(c.capture.overviewLongSide == 1600);
  CHECK(c.capture.zoomW == 1000 && c.capture.zoomH == 750);
  CHECK(c.capture.quality == 80);
  CHECK(c.capture.dir == "C:\\Temp\\lp");
}

static void test_parse_other_commands() {
  const Command f = parseCommand(R"({"type":"foreground","id":"f1"})");
  CHECK(f.kind == Command::Kind::Foreground && f.id == "f1");
  const Command p = parseCommand(R"({"type":"ping","id":"p1"})");
  CHECK(p.kind == Command::Kind::Ping && p.id == "p1");
  CHECK(parseCommand(R"({"type":"shutdown"})").kind == Command::Kind::Shutdown);
}

static void test_parse_rejects_bad_input() {
  CHECK(parseCommand("not json").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"dance","id":"x"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"ping"})").kind == Command::Kind::Bad);  // no id
  const auto bad = [](const std::string& field, const std::string& value) {
    return parseCommand(captureLine({{field, value}}));
  };
  const Command noRect = bad("display", R"("1,2,3")");
  CHECK(noRect.kind == Command::Kind::Bad);
  CHECK(noRect.id == "a1");  // the id is kept so the reply can name the request
  CHECK(bad("display", R"("0,0,0,1080")").kind == Command::Kind::Bad);  // empty display
  CHECK(bad("display", R"("0,0,1920x,1080")").kind == Command::Kind::Bad);
  CHECK(bad("spots", R"("100;200")").kind == Command::Kind::Bad);
  CHECK(bad("spots", R"("1,1;2,2;3,3;4,4;5,5")").kind == Command::Kind::Bad);  // more than 4
  CHECK(bad("overview", "0").kind == Command::Kind::Bad);
  CHECK(bad("zoom", R"("1000")").kind == Command::Kind::Bad);
  CHECK(bad("quality", "101").kind == Command::Kind::Bad);
  CHECK(bad("dir", R"("")").kind == Command::Kind::Bad);
  CHECK(bad("dir", R"("C:\\a;b")").kind == Command::Kind::Bad);  // ';' separates the reply's paths
  CHECK(bad("area", R"("0,0,0,10")").kind == Command::Kind::Bad);
  CHECK(bad("area", R"("0,0,10,10;0,0,5,5")").kind == Command::Kind::Bad);
  CHECK(bad("crops", R"("0,0,10,10")").kind == Command::Kind::Bad);  // two spots need two crops
  CHECK(parseCommand(R"({"type":"ping","id":"../x"})").kind == Command::Kind::Bad);  // the id names files
}

static void test_zoom_rect_stays_inside_the_display() {
  const Rect d{-1920, 0, 1920, 1080};
  const Rect mid = zoomRectAround(d, {-960, 540}, 1000, 750);
  CHECK(mid.x == -1460 && mid.y == 165 && mid.w == 1000 && mid.h == 750);
  const Rect corner = zoomRectAround(d, {-1910, 1070}, 1000, 750);
  CHECK(corner.x == -1920 && corner.y == 330);
  const Rect small = zoomRectAround(Rect{0, 0, 800, 600}, {400, 300}, 1000, 750);
  CHECK(small.x == 0 && small.y == 0 && small.w == 800 && small.h == 600);
}

static void test_overview_size_keeps_aspect() {
  int w = 0, h = 0;
  overviewSize(3840, 2160, 1600, w, h);
  CHECK(w == 1600 && h == 900);
  overviewSize(1080, 1920, 1600, w, h);
  CHECK(w == 900 && h == 1600);
  overviewSize(1280, 720, 1600, w, h);  // never enlarged
  CHECK(w == 1280 && h == 720);
}

static void test_draw_spot_marker() {
  const Image before = blank(200, 200);
  Image img = before;
  drawSpotMarker(img, 100, 100, 1);
  CHECK(samePixel(img, before, 100, 100));  // the spot itself stays visible
  CHECK(!samePixel(img, before, 100 + kMarkerRadius, 100));
  CHECK(!samePixel(img, before, 100 - kMarkerRadius, 100));
  CHECK(!samePixel(img, before, 100, 100 + kMarkerRadius));
  CHECK(!samePixel(img, before, 100, 100 - kMarkerRadius));
  CHECK(samePixel(img, before, 5, 195));  // far away: untouched
  int changed = 0;  // the number sits up and right of the ring
  for (int y = 100 - 2 * kMarkerRadius; y < 100 - kMarkerRadius; ++y)
    for (int x = 100 + kMarkerRadius; x < 100 + 2 * kMarkerRadius; ++x) changed += samePixel(img, before, x, y) ? 0 : 1;
  CHECK(changed > 10);
}

static void test_draw_spot_marker_clips_at_the_edge() {
  Image img = blank(30, 30);
  drawSpotMarker(img, 0, 0, 4);  // must not write outside the buffer
  drawSpotMarker(img, 29, 29, 4);
  CHECK(img.px.size() == 30u * 30u * 4u);
}

namespace {

struct Fake {
  std::vector<std::pair<std::string, Image>> written;
  ContextPlatform platform() {
    ContextPlatform p;
    p.grab = [](const Rect& d, Image& out, Failure&) {
      out = blank(d.w, d.h);
      return true;
    };
    p.resize = [](const Image&, int w, int h, Image& out) {
      out = blank(w, h);
      return true;
    };
    p.writeJpeg = [this](const Image& img, int, const std::string& path, Failure&) {
      written.emplace_back(path, img);
      return true;
    };
    p.foreground = [](std::string& app, std::string& title, std::string& windowId, uint32_t& pid, Failure&) {
      app = "notepad";
      title = "a \"note\".txt";
      windowId = "263544";
      pid = 4242;
      return true;
    };
    return p;
  }
};

}  // namespace

static void test_capture_writes_overview_and_one_zoom_per_spot() {
  Fake fake;
  const std::string reply = handleCommand(parseCommand(captureLine()), fake.platform()).line;
  const auto m = fields(reply);
  CHECK(m.at("type") == "captured");
  CHECK(m.at("id") == "a1");
  CHECK(m.at("ow") == "1600" && m.at("oh") == "900");
  CHECK(fake.written.size() == 3);
  CHECK(m.at("overview") == fake.written[0].first);
  CHECK(m.at("overview").rfind("C:\\Temp\\lp", 0) == 0);
  CHECK(m.at("zooms") == fake.written[1].first + ";" + fake.written[2].first);
  // Both spots sit near an edge: their crops are moved inside the display.
  CHECK(m.at("zoomRects") == "-1920,0,1000,750;-1000,330,1000,750");
  CHECK(fake.written[1].second.w == 1000 && fake.written[1].second.h == 750);
}

static void test_capture_scales_spots_to_a_larger_image() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect& d, Image& out, Failure&) {  // a Retina display: two pixels per point
    out = blank(d.w * 2, d.h * 2);
    return true;
  };
  const std::string reply = handleCommand(parseCommand(captureLine()), p).line;
  CHECK(fields(reply).at("type") == "captured");
  // The zoom is 1000 x 750 pixels of the capture, not points: half that area in points, at full detail.
  CHECK(fields(reply).at("zoomRects") == "-1920,13,500,375;-670,705,500,375");
  CHECK(fake.written[1].second.w == 1000 && fake.written[1].second.h == 750);
  CHECK(fake.written[2].second.w == 1000 && fake.written[2].second.h == 750);
}

static void test_capture_shows_the_area_and_the_crops() {
  Fake fake;
  // The overview shows an 800 x 600 window; spot 1's close-up is a 600 x 200 paragraph, spot 2's a 2400 x 900 panel.
  const std::string line = captureLine({{"area", R"("-1900,100,800,600")"},
                                        {"crops", R"("-1900,150,600,200;-1900,100,2400,900")"}});
  const Command c = parseCommand(line);
  CHECK(c.capture.area.x == -1900 && c.capture.area.w == 800);
  CHECK(c.capture.crops.size() == 2 && c.capture.crops[0].h == 200);
  const auto m = fields(handleCommand(c, fake.platform()).line);
  CHECK(m.at("ow") == "800" && m.at("oh") == "600");  // small enough to send at full size
  CHECK(fake.written[0].second.w == 800 && fake.written[0].second.h == 600);
  // A crop is cut to the display; one longer than the overview's long side is scaled down to it.
  CHECK(m.at("zoomRects") == "-1900,150,600,200;-1900,100,1900,900");
  CHECK(fake.written[1].second.w == 600 && fake.written[1].second.h == 200);
  CHECK(fake.written[2].second.w == 1600 && fake.written[2].second.h == 758);
  // An area off the display shows the whole display.
  Fake off;
  const auto o = fields(handleCommand(parseCommand(captureLine({{"area", R"("100,100,500,500")"}})), off.platform()).line);
  CHECK(o.at("ow") == "1600" && o.at("oh") == "900");
}

static void test_capture_failure_is_an_error_reply() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.grab = [](const Rect&, Image&, Failure& f) {
    f.code = "permission";
    f.message = "Screen Recording is off";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(captureLine()), p).line);
  CHECK(m.at("type") == "error" && m.at("id") == "a1" && m.at("code") == "permission");
  CHECK(m.at("message") == "Screen Recording is off");
  CHECK(fake.written.empty());
}

static void test_foreground_and_pong_replies() {
  Fake fake;
  const auto f = fields(handleCommand(parseCommand(R"({"type":"foreground","id":"f1"})"), fake.platform()).line);
  CHECK(f.at("type") == "foreground" && f.at("id") == "f1" && f.at("app") == "notepad");
  CHECK(f.at("title") == "a \"note\".txt");
  CHECK(f.at("window") == "263544");
  CHECK(f.at("pid") == "4242");
  const auto p = fields(handleCommand(parseCommand(R"({"type":"ping","id":"p1"})"), fake.platform()).line);
  CHECK(p.at("type") == "pong" && p.at("id") == "p1");
  const auto b = fields(handleCommand(parseCommand(R"({"type":"capture","id":"b1"})"), fake.platform()).line);
  CHECK(b.at("type") == "error" && b.at("id") == "b1" && b.at("code") == "bad");
}

static void test_front_reply() {
  Fake fake;
  ContextPlatform p = fake.platform();
  p.front = [](FrontWindow& out, Failure&) {
    out.window = "263544";
    out.title = "a \"note\".txt";
    out.box = Rect{-1920, 40, 900, 700};
    out.pid = 4242;
    return true;
  };
  const Command c = parseCommand(R"({"type":"front","id":"w1"})");
  CHECK(c.kind == Command::Kind::Front && c.id == "w1");
  const auto f = fields(handleCommand(c, p).line);
  CHECK(f.at("type") == "front" && f.at("id") == "w1" && f.at("window") == "263544");
  CHECK(f.at("title") == "a \"note\".txt");
  CHECK(f.at("x") == "-1920" && f.at("y") == "40" && f.at("w") == "900" && f.at("h") == "700");
  CHECK(f.at("pid") == "4242");
}

static void test_front_without_platform_is_bad() {
  Fake fake;  // no front hook, like the Linux helper
  const auto f = fields(handleCommand(parseCommand(R"({"type":"front","id":"w2"})"), fake.platform()).line);
  CHECK(f.at("type") == "error" && f.at("id") == "w2" && f.at("code") == "bad");
}

static void test_loop_answers_until_shutdown() {
  Fake fake;
  std::istringstream in("{\"type\":\"ping\",\"id\":\"1\"}\r\n\n{\"type\":\"shutdown\"}\n{\"type\":\"ping\",\"id\":\"2\"}\n");
  std::vector<std::string> out;
  const int code = runContextLoop(in, [&](const std::string& s) { out.push_back(s); return true; }, fake.platform());
  CHECK(code == 0);
  CHECK(out.size() == 1);
  CHECK(out.size() == 1 && fields(out[0]).at("id") == "1");
}

namespace {

std::filesystem::path testDir() {
  const std::filesystem::path dir = std::filesystem::temp_directory_path() / "lp-context-tests";
  std::filesystem::create_directories(dir);
  return dir;
}

// A read command with one spot near the display's left edge; `layers` adds raw JSON fields, each with its comma.
std::string readLine(const std::string& id, const std::string& layers) {
  return R"({"type":"read","id":")" + id + R"(","spots":"-1820,200",)" + layers + R"("dir":")" +
         lp::jsonEscape(testDir().string()) + R"("})";
}

std::string readFile(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  return std::string((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
}

// A platform whose three text probes answer at once with fixed results.
ContextPlatform readPlatform(Fake& fake) {
  ContextPlatform p = fake.platform();
  p.controls = [](const std::vector<Point>&, int, std::vector<RawMark>& out, Failure&) {
    out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    return true;
  };
  p.systemText = [](const std::vector<Point>& spots, bool, SystemText& out, Failure&) {
    for (size_t i = 0; i < spots.size(); ++i) out.spotTexts.push_back("spot " + std::to_string(i + 1));
    return true;
  };
  p.fileOf = [](std::string& path, std::string& address, std::string& how, Failure&) {
    path = "C:\\docs\\a.pdf";
    address.clear();
    how = "title";
    return true;
  };
  return p;
}

}  // namespace

static void test_parse_read_command() {
  const Command c = parseCommand(
      R"({"type":"read","id":"r1","spots":"-1820,200;-420,900","radius":600,"marks":true,"text":false,)"
      R"("file":true,"dir":"C:\\Temp\\lp"})");
  CHECK(c.kind == Command::Kind::Read && c.id == "r1");
  CHECK(c.read.spots.size() == 2 && c.read.spots[1].x == -420 && c.read.spots[1].y == 900);
  CHECK(c.read.radius == 600);
  CHECK(c.read.marks && !c.read.text && c.read.file);
  CHECK(c.read.dir == "C:\\Temp\\lp");
  CHECK(parseCommand(R"({"type":"read","id":"r1","marks":"yes","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","radius":-1,"dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","spots":"5","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"read","id":"r1","spots":"1,2"})").kind == Command::Kind::Bad);  // no dir
  // The separate commands are gone: an older main gets an error, not a hang.
  CHECK(parseCommand(R"({"type":"marks","id":"m1","dir":"C:\\t"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"systemText","id":"s1"})").kind == Command::Kind::Bad);
  CHECK(parseCommand(R"({"type":"fileOf","id":"f1"})").kind == Command::Kind::Bad);
}

static void test_read_answers_every_layer_it_was_asked_for() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.controls = [](const std::vector<Point>& spots, int radius, std::vector<RawMark>& out, Failure&) {
    if (spots.size() == 1 && spots[0].x == -1820 && radius == 100) {
      out.push_back(RawMark{"text", Rect{-1900, 110, 50, 20}, "Save\tall"});
      out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    }
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("r1", R"("radius":100,"marks":true,"text":true,"file":true,)")), p);
  const auto m = fields(r.line);
  CHECK(!r.exitAfter);
  CHECK(m.at("type") == "read" && m.at("id") == "r1");
  CHECK(m.at("marks") == "ok" && m.at("count") == "2");
  CHECK(m.at("marksPath") == (testDir() / "marks-r1.tsv").string());
  CHECK(readFile(m.at("marksPath")) == "text\t-1900\t110\t50\t20\tSave all\nbutton\t-1800\t190\t50\t20\tOK\n");
  CHECK(m.at("text") == "ok" && m.at("spotTexts") == "spot 1" && m.at("focusSecure") == "false");
  CHECK(m.at("file") == "ok" && m.at("filePath") == "C:\\docs\\a.pdf" && m.at("how") == "title");
  CHECK(m.at("fileAddress").empty());
}

static void test_read_sends_the_boxes_around_each_spot() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.boxes = [](const std::vector<Point>& spots, std::vector<std::vector<Rect>>& out, Failure&) {
    out.push_back({Rect{-1830, 190, 40, 20}, Rect{-1830, 190, 40, 20}, Rect{-1900, 150, 600, 200},
                   Rect{-1920, 0, 1920, 1040}});
    for (size_t i = 1; i < spots.size(); ++i) out.emplace_back();
    return true;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r1", R"("boxes":true,)")), p).line);
  CHECK(m.at("boxes") == "ok");
  CHECK(m.at("boxRects") == "-1830,190,40,20|-1900,150,600,200|-1920,0,1920,1040");  // the repeat is dropped
  CHECK(m.at("marks") == "off" && m.at("text") == "off");
  const auto none = fields(handleCommand(parseCommand(readLine("r2", "")), p).line);
  CHECK(none.at("boxes") == "off" && none.count("boxRects") == 0);
}

static void test_thin_boxes_keeps_the_inner_boxes_and_the_window() {
  std::vector<Rect> chain;
  for (int i = 0; i < 20; ++i) chain.push_back(Rect{0, 0, 10 + i, 10 + i});
  const std::vector<Rect> thin = thinBoxes(chain);
  CHECK(thin.size() == kMaxBoxes);
  CHECK(thin.front().w == 10 && thin[kMaxBoxes - 2].w == 10 + static_cast<int>(kMaxBoxes) - 2);
  CHECK(thin.back().w == 29);
  CHECK(thinBoxes({Rect{0, 0, 0, 5}, Rect{0, 0, 5, 5}}).size() == 1);  // a box with no area is dropped
}

static void test_read_leaves_out_the_layers_that_are_off() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  bool walked = false;
  p.controls = [&walked](const std::vector<Point>&, int, std::vector<RawMark>&, Failure&) {
    walked = true;
    return true;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r2", R"("text":true,)")), p).line);
  CHECK(!walked);
  CHECK(m.at("marks") == "off" && m.at("marksPath").empty() && m.at("count") == "0");
  CHECK(m.at("text") == "ok" && m.at("file") == "off");
  CHECK(m.count("filePath") == 0);
  const auto none = fields(handleCommand(parseCommand(readLine("r3", "")), p).line);
  CHECK(none.at("marks") == "off" && none.at("text") == "off" && none.at("file") == "off");
}

static void test_read_reports_a_failed_layer_and_keeps_the_others() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.systemText = [](const std::vector<Point>&, bool, SystemText&, Failure& f) {
    f.code = "permission";
    f.message = "Accessibility is off";
    return false;
  };
  const auto m = fields(handleCommand(parseCommand(readLine("r4", R"("marks":true,"text":true,"file":true,)")), p).line);
  CHECK(m.at("text") == "permission" && m.count("spotTexts") == 0);
  CHECK(m.at("marks") == "ok" && m.at("file") == "ok");
}

static void test_secure_focus_sends_no_value() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.systemText = [](const std::vector<Point>& spots, bool, SystemText& out, Failure&) {
    out.selection = "picked";
    for (size_t i = 0; i < spots.size(); ++i) out.spotTexts.push_back("spot " + std::to_string(i + 1));
    out.focusKind = "field";
    out.focusLabel = "Password";
    out.focusValue = "hunter2";
    out.focusSecure = true;
    out.address = "https://example.com/login";
    return true;
  };
  const std::string reply = handleCommand(parseCommand(readLine("s1", R"("text":true,)")), p).line;
  CHECK(reply.find(R"("focusValue":"")") != std::string::npos);
  CHECK(reply.find("hunter2") == std::string::npos);
  const auto m = fields(reply);
  CHECK(m.at("type") == "read" && m.at("id") == "s1");
  CHECK(m.at("selection").empty() && m.at("focusKind") == "field" && m.at("focusLabel") == "Password");
  CHECK(m.at("focusSecure") == "true");
  CHECK(m.at("spotTexts") == "spot 1");
  CHECK(m.at("address") == "https://example.com/login");
  // One text per spot, joined with U+001E (the test's flat parser reads no \u escapes, so look at the line).
  const std::string two = handleCommand(parseCommand(
      R"({"type":"read","id":"s2","spots":"1,2;3,4","text":true,"dir":"C:\\t"})"), p).line;
  CHECK(two.find(R"("spotTexts":"spot 1\u001espot 2")") != std::string::npos);
}

static void test_never_fill_focus_sends_no_value_and_no_selection() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.systemText = [](const std::vector<Point>&, bool, SystemText& out, Failure&) {
    out.selection = "4111111111111111";
    out.focusKind = "field";
    out.focusLabel = "Card number";  // the page does not mark it as a password
    out.focusValue = "4111111111111111";
    out.focusSecure = false;
    return true;
  };
  const std::string reply = handleCommand(parseCommand(readLine("s3", R"("text":true,)")), p).line;
  CHECK(reply.find("4111") == std::string::npos);
  const auto m = fields(reply);
  CHECK(m.at("focusValue").empty() && m.at("selection").empty());
  CHECK(m.at("focusSecure") == "true" && m.at("focusLabel") == "Card number");
  // A page is named after its title; a selection on a page about passwords is still sent.
  p.systemText = [](const std::vector<Point>&, bool, SystemText& out, Failure&) {
    out.selection = "Step 2";
    out.focusKind = "other";
    out.focusLabel = "Reset your password";
    return true;
  };
  const auto page = fields(handleCommand(parseCommand(readLine("s4", R"("text":true,)")), p).line);
  CHECK(page.at("selection") == "Step 2" && page.at("focusSecure") == "false");
}

static void test_read_runs_its_layers_under_one_deadline() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  // The walk and the file probe each take 60% of the budget: one after the other they would run over it, side by
  // side they fit. The quick text probe runs first on the walk's thread.
  constexpr int budget = 500;
  const auto wait = [] { std::this_thread::sleep_for(std::chrono::milliseconds(budget * 6 / 10)); };
  const auto order = std::make_shared<std::string>();
  p.controls = [wait, order](const std::vector<Point>&, int, std::vector<RawMark>& out, Failure&) {
    *order += "walk ";
    wait();
    out.push_back(RawMark{"button", Rect{-1800, 190, 50, 20}, "OK"});
    return true;
  };
  p.systemText = [order](const std::vector<Point>&, bool, SystemText& out, Failure&) {
    *order += "text ";
    out.spotTexts.push_back("spot 1");
    return true;
  };
  p.fileOf = [wait](std::string& path, std::string&, std::string& how, Failure&) {
    wait();
    path = "C:\\docs\\a.pdf";
    how = "title";
    return true;
  };
  const auto start = std::chrono::steady_clock::now();
  const Reply r = handleCommand(parseCommand(readLine("r5", R"("marks":true,"text":true,"file":true,)")), p, budget);
  const auto took = std::chrono::steady_clock::now() - start;
  const auto m = fields(r.line);
  CHECK(!r.exitAfter);
  CHECK(m.at("marks") == "ok" && m.at("text") == "ok" && m.at("file") == "ok");
  CHECK(took < std::chrono::milliseconds(budget));  // the whole command fits the one budget the client waits for
  CHECK(*order == "text walk ");  // never side by side: that fails the walk on a fresh helper
}

static void test_read_looks_up_a_browser_address_once() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  const auto asked = std::make_shared<std::vector<bool>>();
  p.systemText = [asked](const std::vector<Point>&, bool withAddress, SystemText& out, Failure&) {
    asked->push_back(withAddress);
    if (withAddress) out.address = "https://example.com/own";
    return true;
  };
  p.fileOf = [](std::string& path, std::string& address, std::string& how, Failure&) {
    path.clear();
    address = "https://example.com/a.pdf";
    how = "address";
    return true;
  };
  // With the file layer on, its address bar lookup also gives the text layer its address.
  const auto both = fields(handleCommand(parseCommand(readLine("r7", R"("text":true,"file":true,)")), p).line);
  CHECK(both.at("address") == "https://example.com/a.pdf" && both.at("fileAddress") == "https://example.com/a.pdf");
  // Without it, the text probe looks the address up itself.
  const auto alone = fields(handleCommand(parseCommand(readLine("r8", R"("text":true,)")), p).line);
  CHECK(alone.at("address") == "https://example.com/own");
  CHECK(*asked == std::vector<bool>({false, true}));
}

static void test_read_sends_what_finished_and_exits_after_a_slow_layer() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.fileOf = [](std::string&, std::string&, std::string&, Failure&) {
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("r6", R"("marks":true,"text":true,"file":true,)")), p, 30);
  const auto m = fields(r.line);
  CHECK(m.at("type") == "read" && m.at("id") == "r6");
  CHECK(m.at("file") == "slow" && m.count("filePath") == 0);
  CHECK(m.at("marks") == "ok" && m.at("count") == "1" && m.at("text") == "ok");
  CHECK(r.exitAfter);  // the file probe is still running, so the helper ends after this reply
  std::istringstream in(readLine("1", R"("file":true,)") + "\n{\"type\":\"ping\",\"id\":\"2\"}\n");
  std::vector<std::string> out;
  const int code = runContextLoop(in, [&](const std::string& s) { out.push_back(s); return true; }, p, 30);
  CHECK(out.size() == 1);  // the loop stopped after the slow reply
  CHECK(code == kExitNow);  // so the main ends the process at once
}

static void test_marks_file_escapes_tabs_and_newlines() {
  const std::string text =
      marksFileText({RawMark{"field", Rect{-5, 6, 7, 8}, "a\tb\r\nc\nd"}, RawMark{"tab", Rect{1, 2, 3, 4}, ""}});
  CHECK(text == "field\t-5\t6\t7\t8\ta b  c d\ntab\t1\t2\t3\t4\t\n");
}

static void test_marks_file_cuts_on_a_character_boundary() {
  std::string chinese;
  for (int i = 0; i < 130; ++i) chinese += "\xe4\xb8\xad";  // U+4E2D, three bytes each
  const std::string text = marksFileText({RawMark{"text", Rect{0, 0, 10, 10}, chinese}});
  const std::string prefix = "text\t0\t0\t10\t10\t";
  CHECK(text.rfind(prefix, 0) == 0);
  CHECK(text.back() == '\n');
  CHECK(text.substr(prefix.size()) == chinese.substr(0, 120 * 3) + "\n");
  // A cut that would land inside a character moves back to its start.
  const std::string mixed = marksFileText({RawMark{"text", Rect{0, 0, 10, 10}, std::string(119, 'a') + chinese}});
  CHECK(mixed.substr(prefix.size()) == std::string(119, 'a') + "\xe4\xb8\xad\n");
}

namespace {

std::vector<std::string> lines(const std::string& text) {
  std::vector<std::string> out;
  std::istringstream in(text);
  for (std::string line; std::getline(in, line);) out.push_back(line);
  return out;
}

RawField field(const std::string& id, const std::string& kind, const std::string& label) {
  RawField f;
  f.id = id;
  f.kind = kind;
  f.label = label;
  return f;
}

}  // namespace

static void test_form_fields_send_no_value_for_a_secure_field() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  p.formFields = [](const std::vector<Point>&, std::vector<RawField>& out, Failure&) {
    RawField password = field("42.7.1", "text", "Password");
    password.value = "hunter2";
    password.secure = true;
    RawField name = field("42.7.2", "text", "Name");
    name.value = "Ada";
    name.required = true;
    out = {password, name};
    return true;
  };
  const Reply r = handleCommand(parseCommand(readLine("f1", R"("fields":true,)")), p);
  const auto m = fields(r.line);
  CHECK(m.at("fields") == "ok" && m.at("fieldCount") == "2");
  CHECK(m.at("fieldsPath") == (testDir() / "fields-f1.jsonl").string());
  const std::string file = readFile(m.at("fieldsPath"));
  CHECK(file.find("hunter2") == std::string::npos);
  const std::vector<std::string> rows = lines(file);
  CHECK(rows.size() == 2);
  CHECK(rows[0].find(R"("id":"42.7.1","kind":"text","label":"Password","group":"","value":"","secure":true)") !=
        std::string::npos);
  const std::string ada = rows[1];
  CHECK(ada.find(R"("value":"Ada")") != std::string::npos && ada.find(R"("required":true)") != std::string::npos);
  CHECK(r.line.find("hunter2") == std::string::npos && r.line.find("Ada") == std::string::npos);
}

static void test_form_fields_file_cuts_labels_on_a_character_boundary() {
  std::string chinese;
  for (int i = 0; i < 130; ++i) chinese += "\xe4\xb8\xad";  // U+4E2D, three bytes each
  RawField f = field("1.2", "combo", chinese);
  f.group = chinese;
  f.value = std::string(2001, 'v');
  f.options = {chinese, "Small"};
  const std::vector<std::string> rows = lines(formFieldsFileText({f}));
  CHECK(rows.size() == 1);
  const std::string cut120 = chinese.substr(0, 120 * 3);
  CHECK(rows[0].find("\"label\":\"" + cut120 + "\"") != std::string::npos);
  CHECK(rows[0].find("\"group\":\"" + cut120 + "\"") != std::string::npos);
  CHECK(rows[0].find("\"options\":[\"" + cut120 + "\",\"Small\"]") != std::string::npos);
  CHECK(rows[0].find("\"value\":\"" + std::string(2000, 'v') + "\"") != std::string::npos);
  // A cut that would land inside a character moves back to its start.
  const std::string mixed = formFieldsFileText({field("1.3", "text", std::string(119, 'a') + chinese)});
  CHECK(mixed.find("\"label\":\"" + std::string(119, 'a') + "\xe4\xb8\xad\"") != std::string::npos);
}

static void test_form_fields_file_keeps_one_line_per_field_and_the_caps() {
  RawField f = field("1.1", "text", "Say \"hi\"\nthen\ttab");
  f.value = "line one\nline two";
  const std::string text = formFieldsFileText({f});
  CHECK(lines(text).size() == 1);  // the newlines are escaped
  const std::string escapedLabel = R"("label":"Say \"hi\"\nthen\ttab")";
  CHECK(text.find(escapedLabel) != std::string::npos);
  CHECK(text.find(R"("value":"line one\nline two")") != std::string::npos);
  std::vector<RawField> many;
  for (int i = 0; i < 70; ++i) many.push_back(field("1." + std::to_string(i), "text", "F"));
  many[0].options.assign(60, "o");
  const std::vector<std::string> rows = lines(formFieldsFileText(many));
  CHECK(rows.size() == kMaxFormFields);
  size_t options = 0;
  for (size_t at = rows[0].find("\"o\""); at != std::string::npos; at = rows[0].find("\"o\"", at + 1)) ++options;
  CHECK(options == kMaxFieldOptions);
  // A cut id would name another field: one that is too long is left out, as the TS parser does.
  const std::string tooLong = formFieldsFileText({field("1." + std::string(kFieldIdMax - 1, '2'), "text", "Long"), f});
  CHECK(lines(tooLong).size() == 1 && tooLong.find("Long") == std::string::npos);
}

static void test_form_fields_file_gives_each_field_its_box() {
  RawField name = field("1.1", "text", "Name");
  name.box = Rect{120, 340, 400, 32};
  const std::vector<std::string> rows = lines(formFieldsFileText({name, field("1.2", "text", "No box")}));
  CHECK(rows.size() == 2);
  CHECK(rows[0].find(R"("box":"120,340,400,32")") != std::string::npos);
  CHECK(rows[1].find("\"box\"") == std::string::npos);  // an empty box is left out
}

static void test_read_leaves_the_fields_layer_off_unless_asked_and_reports_a_failure() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  bool read = false;
  p.formFields = [&read](const std::vector<Point>&, std::vector<RawField>& out, Failure&) {
    read = true;
    out = {field("1.1", "text", "Name")};
    return true;
  };
  const auto off = fields(handleCommand(parseCommand(readLine("f2", R"("text":true,)")), p).line);
  CHECK(!read && off.at("fields") == "off" && off.count("fieldsPath") == 0);
  const auto no = fields(handleCommand(parseCommand(readLine("f3", R"("fields":false,)")), p).line);
  CHECK(!read && no.at("fields") == "off");
  p.formFields = [](const std::vector<Point>&, std::vector<RawField>&, Failure& f) {
    f.code = "permission";
    return false;
  };
  const auto failed = fields(handleCommand(parseCommand(readLine("f4", R"("fields":true,"text":true,)")), p).line);
  CHECK(failed.at("fields") == "permission" && failed.count("fieldsPath") == 0 && failed.at("text") == "ok");
  // A platform with no fields probe (macOS for now) answers off, not an error.
  p.formFields = nullptr;
  const auto none = fields(handleCommand(parseCommand(readLine("f5", R"("fields":true,)")), p).line);
  CHECK(none.at("fields") == "off");
  CHECK(parseCommand(R"({"type":"read","id":"r1","fields":"yes","dir":"C:\\t"})").kind == Command::Kind::Bad);
}

// The table that doRules.test.ts reads too, one entry per line: {"label":"...","neverFill":true}. The tests run in
// native/hook-helper (run.mjs), the repo root is two levels up.
static void test_never_fill_labels_match_the_shared_table() {
  std::ifstream in("../../tests/fixtures/never-fill-labels.json", std::ios::binary);
  if (!in) in.open("tests/fixtures/never-fill-labels.json", std::ios::binary);
  CHECK(static_cast<bool>(in));
  int rows = 0;
  for (std::string line; std::getline(in, line);) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const size_t open = line.find('{');
    if (open == std::string::npos) continue;
    const size_t close = line.rfind('}');
    const auto row = fields(line.substr(open, close - open + 1));
    CHECK(row.count("label") == 1 && row.count("neverFill") == 1);
    if (row.count("label") == 0 || row.count("neverFill") == 0) continue;
    ++rows;
    if (neverFillLabel(row.at("label")) != (row.at("neverFill") == "true")) {
      ++g_fail;
      std::printf("FAIL never-fill label: %s\n", row.at("label").c_str());
    }
  }
  CHECK(rows >= 40);
}

static void test_form_fields_blank_the_value_of_a_never_fill_label() {
  RawField card = field("1.1", "text", "Card number");
  card.value = "4111111111111111";  // the page does not mark it as a password
  RawField id = field("1.2", "text", "\xe8\xba\xab\xe4\xbb\xbd\xe8\xaf\x81\xe5\x8f\xb7");  // the ZH ID number label
  id.value = "110101199001011234";
  RawField name = field("1.3", "text", "Pinterest");
  name.value = "Ada";
  const std::vector<std::string> rows = lines(formFieldsFileText({card, id, name}));
  CHECK(rows.size() == 3);
  CHECK(rows[0].find(R"("value":"","secure":true)") != std::string::npos);
  CHECK(rows[1].find(R"("value":"","secure":true)") != std::string::npos);
  CHECK(rows[2].find(R"("value":"Ada","secure":false)") != std::string::npos);
  const std::string all = formFieldsFileText({card, id, name});
  CHECK(all.find("4111") == std::string::npos && all.find("110101") == std::string::npos);
}

static void test_read_runs_the_fields_search_after_the_text_probe_on_one_thread() {
  Fake fake;
  ContextPlatform p = readPlatform(fake);
  struct Seen {
    std::mutex lock;
    std::vector<std::string> order;
    std::vector<std::thread::id> threads;
  };
  const auto seen = std::make_shared<Seen>();
  const auto note = [seen](const char* what) {
    std::lock_guard<std::mutex> guard(seen->lock);
    seen->order.push_back(what);
    seen->threads.push_back(std::this_thread::get_id());
  };
  p.boxes = [note](const std::vector<Point>&, std::vector<std::vector<Rect>>&, Failure&) {
    note("boxes");
    return true;
  };
  p.systemText = [note](const std::vector<Point>&, bool, SystemText&, Failure&) {
    note("text");
    return true;
  };
  p.formFields = [note](const std::vector<Point>&, std::vector<RawField>&, Failure&) {
    note("fields");
    return true;
  };
  p.controls = [note](const std::vector<Point>&, int, std::vector<RawMark>&, Failure&) {
    note("marks");
    return true;
  };
  const auto m = fields(handleCommand(
      parseCommand(readLine("o1", R"("boxes":true,"text":true,"fields":true,"marks":true,)")), p).line);
  CHECK(m.at("fields") == "ok" && m.at("text") == "ok" && m.at("marks") == "ok");
  // One tree search at a time: UI Automation fails a search that runs beside another on a fresh helper.
  CHECK(seen->order == std::vector<std::string>({"boxes", "text", "fields", "marks"}));
  CHECK(std::all_of(seen->threads.begin(), seen->threads.end(), [&](const std::thread::id& t) {
    return t == seen->threads.front();
  }));
  // Fields alone still get a thread of their own to run on.
  seen->order.clear();
  const auto alone = fields(handleCommand(parseCommand(readLine("o2", R"("fields":true,)")), p).line);
  CHECK(alone.at("fields") == "ok" && seen->order == std::vector<std::string>({"fields"}));
}

static void test_budget_gives_up_on_a_slow_probe() {
  const auto start = std::chrono::steady_clock::now();
  const bool done = runWithBudget([] { std::this_thread::sleep_for(std::chrono::milliseconds(200)); }, 20);
  const auto took = std::chrono::steady_clock::now() - start;
  CHECK(!done);
  CHECK(took < std::chrono::milliseconds(100));
}

static void test_budget_returns_a_fast_probe() {
  const auto ran = std::make_shared<int>(0);
  CHECK(runWithBudget([ran] { *ran = 7; }, 1000));
  CHECK(*ran == 7);
}

static void test_cut_text_keeps_whole_characters() {
  const std::string zhong = "\xe4\xb8\xad";  // U+4E2D
  CHECK(cutText("hello", 3) == "hel");
  CHECK(cutText("hi", 5) == "hi");
  CHECK(cutText("ab" + zhong + zhong, 3) == "ab" + zhong);
  CHECK(cutText("\xf0\xa0\x80\x80" "ab", 1) == "\xf0\xa0\x80\x80");  // a four-byte character counts once
  CHECK(cutText("abc", 0).empty());
}

static void test_file_name_from_a_window_title() {
  CHECK(fileNameFromTitle("notes.txt - Notepad") == "notes.txt");
  CHECK(fileNameFromTitle("My Report.docx - Word") == "My Report.docx");
  CHECK(fileNameFromTitle("plan - final.pdf - Adobe Acrobat Pro (64-bit)") == "plan - final.pdf");
  CHECK(fileNameFromTitle("*notes.txt - Notepad") == "notes.txt");
  CHECK(fileNameFromTitle("\xe2\x97\x8f context.cpp - lolPing - Visual Studio Code") == "context.cpp");
  CHECK(fileNameFromTitle("My Notes.md - repo - Visual Studio Code") == "My Notes.md");
  CHECK(fileNameFromTitle("Reading report.PDF now") == "report.PDF");
  CHECK(fileNameFromTitle("Document1 - Word") == "Document1");
  CHECK(fileNameFromTitle("My Notes.md") == "My Notes.md");
  CHECK(fileNameFromTitle("a.js and b.py open") == "b.py");
  CHECK(fileNameFromTitle("C:\\a\\b.txt - Notepad++") == "b.txt");
  // Every extension the file layer reads as text names a file, not only the common ones.
  CHECK(fileNameFromTitle("App.tsx - web - Visual Studio Code") == "App.tsx");
  CHECK(fileNameFromTitle("deploy.sh - scripts - Visual Studio Code") == "deploy.sh");
  CHECK(fileNameFromTitle("values.yaml - chart - Visual Studio Code") == "values.yaml");
  CHECK(fileNameFromTitle("Program.cs - app - Visual Studio Code") == "Program.cs");
  CHECK(fileNameFromTitle("Settings").empty());
  CHECK(fileNameFromTitle("").empty());
  // ".pdfx" is not ".pdf", and an extension alone is no name.
  CHECK(fileNameFromTitle("a.pdfx - Viewer") == "a.pdfx");
  CHECK(fileNameFromTitle(".pdf").empty());
}

static void test_acrobat_mru_path() {
  CHECK(acrobatMruPath("/C/Users/me/My Docs/a.pdf") == "C:\\Users\\me\\My Docs\\a.pdf");
  CHECK(acrobatMruPath("/d/b.pdf") == "d:\\b.pdf");
  CHECK(acrobatMruPath("C:\\a.pdf").empty());
  CHECK(acrobatMruPath("/server/share/a.pdf").empty());
  CHECK(acrobatMruPath("/C").empty());
  CHECK(acrobatMruPath("").empty());
}

static void test_office_mru_path() {
  CHECK(officeMruPath("[F00000000][T01D93C7FC86CB1A0][O00000000]*C:\\Users\\me\\a.docx") == "C:\\Users\\me\\a.docx");
  CHECK(officeMruPath("C:\\Users\\me\\Desktop\\").empty());
  CHECK(officeMruPath("[F00000000]*").empty());
}

static void test_browser_address() {
  std::string path, address;
  const auto read = [&](const std::string& value) {
    path = "x";
    address = "x";
    return browserAddress(value, path, address);
  };
  CHECK(read("C:/Users/Darren Meng/a.pdf") && path == "C:\\Users\\Darren Meng\\a.pdf" && address.empty());
  CHECK(read("file:///C:/Users/Darren%20Meng/b%25.pdf") && path == "C:\\Users\\Darren Meng\\b%.pdf");
  CHECK(read("FILE:///d:/x.pdf") && path == "d:\\x.pdf");
  // Edge's PDF viewer adds "#page=N"; an encoded '#' or '?' is part of the name.
  CHECK(read("file:///C:/a/b.pdf#page=2") && path == "C:\\a\\b.pdf");
  CHECK(read("file:///C:/a/b%23c%3F.pdf?x=1") && path == "C:\\a\\b#c?.pdf");
  CHECK(read("file://server/share/c.pdf#page=1") && path == "\\\\server\\share\\c.pdf");
  CHECK(read("file://server/share/c.pdf") && path == "\\\\server\\share\\c.pdf");
  CHECK(read("C:/a/%E4%B8%AD.pdf") && path == "C:\\a\\\xe4\xb8\xad.pdf");
  CHECK(read("example.com/docs/a.pdf") && address == "https://example.com/docs/a.pdf" && path.empty());
  CHECK(read("https://example.com/a.pdf?x=1") && address == "https://example.com/a.pdf?x=1");
  CHECK(read("http://localhost:3000/") && address == "http://localhost:3000/");
  CHECK(read("localhost:3000/x") && address == "https://localhost:3000/x");
  CHECK(read("  example.com  ") && address == "https://example.com");
  CHECK(!read("") && path.empty() && address.empty());
  CHECK(!read("how to read a pdf"));
  CHECK(!read("about:blank"));
  CHECK(!read("hello"));
  CHECK(!read("file:///"));
}

namespace {

// What a paste or setField did, in order, shared with the check thread (which may outlive a slow test).
struct PasteState {
  std::mutex lock;
  std::vector<std::string> events;
  std::string fg = "263544", under = "263544";
  bool answers = true;
  bool selectionReadable = true, focusReadable = true;
  std::string selection;
  FieldFacts focus{"text", "Message", false}, atClick{"text", "Message", false};
  int slowChecksMs = 0;
  std::vector<std::vector<uint16_t>> keys;  // one per poll; the last repeats; none means every key is up
  size_t polls = 0;
  int failedOpens = 0;   // opens that fail before one succeeds; -1: every open fails
  int opensAllowed = -1;  // opens that succeed before every later one fails; -1: no limit
  std::vector<ClipFormat> clip;
  std::string unreadable;  // the name of a listed format whose bytes can't be read
  std::vector<std::vector<ClipFormat>> writes;
  uint32_t sequence = 1;  // the clipboard's: each write moves it on
  // The command loop's clock: waits move it on, and so do the calls given a cost here.
  int64_t clock = 0;
  int answerMs = 0, pollMs = 0;
  bool elevatedTarget = false;
  // What changes once the pasted text is on the clipboard, or while Ctrl+V goes out.
  bool moveAfterWrite = false, freezeAfterWrite = false, copyDuringPaste = false, throwOnPaste = false;
  // setField
  FieldFacts field{"text", "Name", false};
  std::string setResult = "ok";
  int slowSetMs = 0;
  std::vector<std::string> written;

  void note(const std::string& e) {
    std::lock_guard<std::mutex> guard(lock);
    events.push_back(e);
  }
  std::vector<std::string> seen() {
    std::lock_guard<std::mutex> guard(lock);
    return events;
  }
  bool saw(const std::string& prefix) {
    const std::vector<std::string> all = seen();
    return std::any_of(all.begin(), all.end(), [&](const std::string& e) { return e.rfind(prefix, 0) == 0; });
  }
};

ClipFormat format(unsigned id, const std::string& name, const std::string& bytes) {
  return ClipFormat{id, name, std::vector<uint8_t>(bytes.begin(), bytes.end())};
}

ContextPlatform pastePlatform(const std::shared_ptr<PasteState>& s) {
  ContextPlatform p;
  p.foreground = [s](std::string& app, std::string& title, std::string& windowId, uint32_t&, Failure&) {
    app = "notepad";
    title = "notes.txt - Notepad";
    windowId = s->fg;
    return true;
  };
  p.responsive = [s](const std::string& window) {
    s->note("responsive " + window);
    s->clock += s->answerMs;
    return s->answers;
  };
  p.elevated = [s](const std::string&) {
    s->note("elevated");
    return s->elevatedTarget;
  };
  p.windowAt = [s](Point at) {
    s->note("windowAt " + std::to_string(at.x) + "," + std::to_string(at.y));
    return s->under;
  };
  p.focusedSelection = [s](std::string& out) {
    s->note("uia selection");
    out = s->selection;
    return s->selectionReadable;
  };
  p.fieldFacts = [s](std::optional<Point> at, FieldFacts& out) {
    s->note(at ? "uia field at click" : "uia focus");
    if (s->slowChecksMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(s->slowChecksMs));
    out = at ? s->atClick : s->focus;
    return s->focusReadable;
  };
  p.keyStates = [s] {
    s->note("keys");
    s->clock += s->pollMs;
    if (s->keys.empty()) return std::vector<uint16_t>(10, 0);
    const std::vector<uint16_t> now = s->keys[std::min(s->polls, s->keys.size() - 1)];
    ++s->polls;
    return now;
  };
  p.openClipboard = [s] {
    s->note("open");
    if (s->failedOpens < 0) return false;
    if (s->failedOpens > 0) {
      --s->failedOpens;
      return false;
    }
    if (s->opensAllowed == 0) return false;
    if (s->opensAllowed > 0) --s->opensAllowed;
    return true;
  };
  p.closeClipboard = [s] { s->note("close"); };
  p.clipboardFormats = [s] {
    std::vector<ClipFormat> listed;
    for (const ClipFormat& f : s->clip) listed.push_back(ClipFormat{f.id, f.name, {}});
    return listed;
  };
  p.readClipboard = [s](ClipFormat& f) {
    if (!s->unreadable.empty() && f.name == s->unreadable) return false;
    for (const ClipFormat& have : s->clip) {
      if (have.id == f.id && have.name == f.name) {
        f.bytes = have.bytes;
        return true;
      }
    }
    return false;
  };
  p.writeClipboard = [s](const std::vector<ClipFormat>& all) {
    s->note("write");
    s->writes.push_back(all);
    s->clip = all;
    ++s->sequence;
    if (s->moveAfterWrite) s->under = "777";
    if (s->freezeAfterWrite) s->answers = false;
    return true;
  };
  p.clipboardSequence = [s] { return s->sequence; };
  p.click = [s](Point at) {
    s->note("click " + std::to_string(at.x) + "," + std::to_string(at.y));
    return true;
  };
  p.pressPaste = [s] {
    s->note("ctrl+v");
    if (s->throwOnPaste) throw std::runtime_error("out of memory");
    if (s->copyDuringPaste) ++s->sequence;  // the user copied something new
    return true;
  };
  p.wait = [s](int ms) {
    s->note("wait " + std::to_string(ms));
    s->clock += ms;
  };
  p.now = [s] { return s->clock; };
  p.setField = [s](const SetFieldRequest& r, const std::function<std::string(const FieldFacts&)>& check) {
    s->note("uia setField " + r.field);
    if (s->slowSetMs > 0) std::this_thread::sleep_for(std::chrono::milliseconds(s->slowSetMs));
    if (s->setResult == "gone") return std::string("gone");
    const std::string refused = check(s->field);
    if (!refused.empty()) return refused;
    std::lock_guard<std::mutex> guard(s->lock);
    s->written.push_back(r.value);
    return s->setResult;
  };
  return p;
}

// A paste command into window 263544; `extra` adds raw JSON fields, each with its comma.
std::string pasteLine(const std::string& extra = "") {
  return R"({"type":"paste","id":"p1","window":"263544","text":"hello",)" + extra + R"("mode":"insert"})";
}

std::string pasteResult(const ContextPlatform& p, const std::string& line, int budgetMs = kProbeBudgetMs) {
  const auto m = fields(handleCommand(parseCommand(line), p, budgetMs).line);
  return m.count("type") && m.at("type") == "pasted" && m.at("id") == "p1" ? m.at("result") : "?";
}

// Each key or button held for `polls` polls of the hands-off wait, then let go.
std::vector<std::vector<uint16_t>> heldFor(size_t polls) {
  std::vector<uint16_t> ctrl(10, 0);
  ctrl[5] = 0x8000;
  std::vector<std::vector<uint16_t>> out(polls, ctrl);
  out.push_back(std::vector<uint16_t>(10, 0));
  return out;
}

// The flat parser in the tests reads no \u escapes, so the lines carry UTF-8 as is.
std::string pasteOf(const std::string& text, const std::string& extra = "", const std::string& mode = "insert") {
  return R"({"type":"paste","id":"p1","window":"263544","text":")" + lp::jsonEscape(text) + "\"," + extra +
         R"("mode":")" + mode + "\"}";
}

bool isExclusion(const ClipFormat& f) {
  return f.name == "ExcludeClipboardContentFromMonitorProcessing" || f.name == "CanIncludeInClipboardHistory" ||
         f.name == "CanUploadToCloudClipboard";
}

// A write's three exclusion formats, each a DWORD 0.
bool marksExcluded(const std::vector<ClipFormat>& write) {
  int found = 0;
  for (const ClipFormat& f : write) {
    if (!isExclusion(f)) continue;
    if (f.bytes != std::vector<uint8_t>{0, 0, 0, 0}) return false;
    ++found;
  }
  return found == 3;
}

}  // namespace

static void test_parse_paste_command() {
  const Command c = parseCommand(pasteOf("line one\nline two", R"("click":"-1820,200",)"));
  CHECK(c.kind == Command::Kind::Paste && c.id == "p1");
  CHECK(c.paste.window == "263544" && c.paste.text == "line one\nline two");
  CHECK(c.paste.click && c.paste.click->x == -1820 && c.paste.click->y == 200);
  CHECK(!c.paste.replace && c.paste.asked.empty());
  const Command r = parseCommand(pasteOf("new", R"("click":"","asked":"old",)", "replace"));
  CHECK(r.kind == Command::Kind::Paste && r.paste.replace && r.paste.asked == "old" && !r.paste.click);
  std::string chinese;
  for (int i = 0; i < 20000; ++i) chinese += "\xe4\xb8\xad";  // characters, not bytes, are counted
  CHECK(parseCommand(pasteOf(chinese)).kind == Command::Kind::Paste);
  const auto bad = [](const std::string& line) { return parseCommand(line).kind == Command::Kind::Bad; };
  CHECK(bad(pasteOf(chinese + "a")));
  CHECK(bad(pasteOf("")));
  CHECK(bad(pasteOf("x", R"("click":"10",)")));
  CHECK(bad(pasteOf("x", R"("click":"1,2",)", "replace")));  // a click would drop the selection to replace
  CHECK(bad(pasteOf("x", "", "append")));
  CHECK(bad(pasteOf("x", "", "")));
  CHECK(bad(pasteOf("x", "\"asked\":\"" + std::string(4001, 'a') + "\",", "replace")));
  CHECK(bad(R"({"type":"paste","id":"p1","text":"x","mode":"insert"})"));  // no window
  CHECK(bad(R"({"type":"paste","id":"p1","window":"","text":"x","mode":"insert"})"));
  CHECK(bad(R"({"type":"paste","id":"p1","window":"12a","text":"x","mode":"insert"})"));
  CHECK(bad(R"({"type":"paste","id":"p1","window":"263544","mode":"insert"})"));  // no text
}

static void test_parse_set_field_command() {
  const Command c = parseCommand(R"({"type":"setField","id":"s1","window":"263544","field":"42.-7.1","value":"Ada"})");
  CHECK(c.kind == Command::Kind::SetField && c.id == "s1");
  CHECK(c.setField.window == "263544" && c.setField.field == "42.-7.1" && c.setField.value == "Ada");
  CHECK(parseCommand(R"({"type":"setField","id":"s1","window":"1","field":"7","value":""})").kind ==
        Command::Kind::SetField);  // clearing a field is a value too
  const auto bad = [](const std::string& rest) {
    return parseCommand(R"({"type":"setField","id":"s1",)" + rest + "}").kind == Command::Kind::Bad;
  };
  CHECK(bad(R"("window":"1","field":"a.b","value":"x")"));
  CHECK(bad(R"("window":"1","field":"","value":"x")"));
  CHECK(bad(R"("window":"1","field":"1..2","value":"x")"));
  CHECK(bad(R"("window":"1","field":")" + std::string(121, '1') + R"(","value":"x")"));
  const std::string longValue = R"("window":"1","field":"1.2","value":")" + std::string(2001, 'v') + "\"";
  CHECK(bad(longValue));
  CHECK(bad(R"("field":"1.2","value":"x")"));
  CHECK(bad(R"("window":"1","field":"1.2")"));
}

static void test_restore_keeps_every_saved_format() {
  const std::vector<ClipFormat> listed = {
      ClipFormat{13, "", {}},  ClipFormat{0xC09E, "HTML Format", {}}, ClipFormat{0xC0A1, "Rich Text Format", {}},
      ClipFormat{0xC0B0, "DataObject", {}}, ClipFormat{0xC0B1, "Ole Private Data", {}}, ClipFormat{14, "", {}},
      ClipFormat{8, "", {}}, ClipFormat{0xC0C0, "Chromium Web Custom MIME Data Format", {}},
      ClipFormat{0xC0D0, "CanIncludeInClipboardHistory", {}}, ClipFormat{1, "", {}}, ClipFormat{7, "", {}},
      ClipFormat{16, "", {}}, ClipFormat{2, "", {}}, ClipFormat{17, "", {}}, ClipFormat{9, "", {}},
      ClipFormat{3, "", {}}, ClipFormat{0x0300, "", {}}, ClipFormat{0x0200, "", {}}};
  std::vector<unsigned> kept;
  for (const ClipFormat& f : formatsToRestore(listed)) kept.push_back(f.id);
  // Text, HTML, RTF, the enhanced metafile, the bitmap and a custom format, in their order; Windows makes the
  // synthesized ones up again, the OLE ones point into the old owner, and the exclusions are written fresh.
  CHECK(kept == std::vector<unsigned>({13, 0xC09E, 0xC0A1, 14, 8, 0xC0C0}));

  const auto s = std::make_shared<PasteState>();
  const std::string html = "Version:0.9\r\nStartHTML:1\r\n<b>bold</b>";
  s->clip = {format(13, "", std::string("h\0i\0\0\0", 6)), format(1, "", "hi"), format(0xC09E, "HTML Format", html),
             format(0xC0A1, "Rich Text Format", "{\\rtf1 hi}"), format(14, "", "EMF bits"),
             format(0xC0B0, "DataObject", "ole"), format(0xC0C0, "Chromium Web Custom MIME Data Format", "\x01\x02")};
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "ok");
  const std::vector<ClipFormat> after = s->clip;
  std::vector<ClipFormat> restored;
  for (const ClipFormat& f : after) {
    if (!isExclusion(f)) restored.push_back(f);
  }
  CHECK(restored.size() == 5);
  if (restored.size() == 5) {
    CHECK(restored[0].bytes == format(13, "", std::string("h\0i\0\0\0", 6)).bytes);
    CHECK(restored[1].id == 0xC09E && restored[1].name == "HTML Format");
    CHECK(restored[1].bytes == format(0, "", html).bytes);
    CHECK(restored[2].id == 0xC0A1 && restored[2].bytes == format(0, "", "{\\rtf1 hi}").bytes);
    CHECK(restored[3].id == 14 && restored[3].bytes == format(0, "", "EMF bits").bytes);
    CHECK(restored[4].id == 0xC0C0 && restored[4].bytes == format(0, "", "\x01\x02").bytes);
  }
}

// Excel, Word and password managers put empty marker formats on the clipboard; read as empty, not as unreadable, they
// let the paste go ahead and come back empty.
static void test_paste_keeps_an_empty_marker_format() {
  const auto s = std::make_shared<PasteState>();
  s->clip = {format(13, "", std::string("h\0i\0\0\0", 6)), format(0xC0E0, "Clipboard Viewer Ignore", "")};
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "ok");
  std::vector<ClipFormat> restored;
  for (const ClipFormat& f : s->clip) {
    if (!isExclusion(f)) restored.push_back(f);
  }
  CHECK(restored.size() == 2);
  if (restored.size() == 2) CHECK(restored[1].name == "Clipboard Viewer Ignore" && restored[1].bytes.empty());
}

static void test_exclusion_formats_are_recognised_by_name() {
  const std::vector<ClipFormat> marks = exclusionFormats();
  CHECK(marks.size() == 3);
  for (const ClipFormat& f : marks) CHECK(isExclusionFormat(f.name));
  CHECK(!isExclusionFormat("HTML Format") && !isExclusionFormat("") && !isExclusionFormat("0|public.utf8-plain-text"));
}

static void test_paste_marks_both_writes_as_excluded() {
  const auto s = std::make_shared<PasteState>();
  s->clip = {format(0xC09E, "HTML Format", "<i>mine</i>")};
  CHECK(pasteResult(pastePlatform(s), pasteOf("h\xc3\xa9 \xe4\xb8\xad\n\xf0\x9f\x98\x80")) == "ok");
  CHECK(s->writes.size() == 2);
  if (s->writes.size() != 2) return;
  CHECK(marksExcluded(s->writes[0]) && marksExcluded(s->writes[1]));
  // The pasted text is the only other format: UTF-16 with its terminating zero, a surrogate pair for the emoji.
  const std::vector<uint8_t> utf16 = {'h', 0, 0xE9, 0, ' ', 0, 0x2D, 0x4E, '\n', 0, 0x3D, 0xD8, 0x00, 0xDE, 0, 0};
  CHECK(s->writes[0].size() == 4);
  CHECK(s->writes[0].front().id == 13 && s->writes[0].front().bytes == utf16);
  CHECK(s->writes[1].size() == 4 && s->writes[1].front().name == "HTML Format");
}

static void test_paste_refuses_a_window_that_does_not_answer() {
  const auto s = std::make_shared<PasteState>();
  s->answers = false;
  CHECK(pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200",)")) == "hung");
  CHECK(s->saw("responsive 263544"));
  // No UI Automation call on a frozen app (each blocks about 10 s), no clipboard, no click and no Ctrl+V.
  CHECK(!s->saw("uia") && !s->saw("open") && !s->saw("click") && !s->saw("ctrl+v") && !s->saw("windowAt"));
  CHECK(s->writes.empty());
}

static void test_paste_refuses_another_window() {
  const auto s = std::make_shared<PasteState>();
  s->fg = "999";
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "window");
  CHECK(s->seen().empty());  // checked before anything else is asked of the target
  // A click that would land in another window.
  const auto c = std::make_shared<PasteState>();
  c->under = "777";
  CHECK(pasteResult(pastePlatform(c), pasteLine(R"("click":"-1820,200",)")) == "window");
  CHECK(!c->saw("uia") && !c->saw("open") && !c->saw("click"));
}

static void test_paste_replaces_only_while_the_selection_holds_the_asked_text() {
  const auto replace = [](const std::string& selection, bool readable, const std::string& asked) {
    const auto s = std::make_shared<PasteState>();
    s->selection = selection;
    s->selectionReadable = readable;
    const std::string result =
        pasteResult(pastePlatform(s), pasteOf("better", "\"asked\":\"" + lp::jsonEscape(asked) + "\",", "replace"));
    return std::make_pair(result, s);
  };
  CHECK(replace("old text", true, "old text").first == "ok");
  CHECK(replace(" old text\r\n", true, "old text").first == "ok");  // the same words, as pastePlan trims them
  const auto moved = replace("something else", true, "old text");
  CHECK(moved.first == "selection");
  CHECK(!moved.second->saw("open") && !moved.second->saw("ctrl+v"));
  CHECK(replace("old text", false, "old text").first == "selection");  // unreadable: fail closed
  CHECK(replace("", true, "").first == "selection");                    // nothing was asked about
  // Word's line break (U+000B) is in the selection read now, and the client left it out of `asked`.
  CHECK(replace("old\x0btext", true, "oldtext").first == "ok");
  CHECK(replace("old text\x0b\x0b", true, "old text").first == "ok");
  // A secure field wins over a selection that moved, and its selection is never read.
  const auto both = std::make_shared<PasteState>();
  both->focus.secure = true;
  both->selection = "something else";
  CHECK(pasteResult(pastePlatform(both), pasteOf("better", R"("asked":"old text",)", "replace")) == "secure");
  CHECK(!both->saw("uia selection"));
  // An insert never reads the selection.
  const auto s = std::make_shared<PasteState>();
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "ok" && !s->saw("uia selection"));
}

static void test_paste_refuses_a_secure_field() {
  const auto run = [](const std::function<void(PasteState&)>& set, const std::string& extra = "") {
    const auto s = std::make_shared<PasteState>();
    set(*s);
    const std::string result = pasteResult(pastePlatform(s), pasteLine(extra));
    CHECK(!s->saw("open") && !s->saw("ctrl+v") && !s->saw("click"));
    return result;
  };
  CHECK(run([](PasteState& s) { s.focus.secure = true; }) == "secure");
  CHECK(run([](PasteState& s) { s.focus.label = "Card number"; }) == "secure");
  CHECK(run([](PasteState& s) { s.focus.label = "\xe5\xaf\x86\xe7\xa0\x81"; }) == "secure");  // the ZH password
  CHECK(run([](PasteState& s) { s.focusReadable = false; }) == "secure");                     // fail closed
  CHECK(run([](PasteState& s) { s.atClick.secure = true; }, R"("click":"-1820,200",)") == "secure");
  // The checks come after the hands-off wait, when the user has let go, and after the frozen-app check.
  const auto s = std::make_shared<PasteState>();
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "ok");
  std::vector<std::string> seen = s->seen();
  seen.resize(std::min<size_t>(seen.size(), 4));
  CHECK(seen == std::vector<std::string>({"keys", "responsive 263544", "elevated", "uia focus"}));
}

static void test_paste_fails_closed_when_its_checks_run_over() {
  const auto s = std::make_shared<PasteState>();
  s->slowChecksMs = 300;
  const Reply r = handleCommand(parseCommand(pasteLine()), pastePlatform(s), 50);
  const auto m = fields(r.line);
  CHECK(m.at("type") == "pasted" && m.at("result") == "secure");
  CHECK(r.exitAfter);  // the check is still inside UI Automation: the helper ends after this reply
  CHECK(!s->saw("open") && !s->saw("ctrl+v"));
}

static void test_hands_off_ignores_released_keys() {
  CHECK(handsOff({}));
  CHECK(handsOff({0, 0, 0}));
  CHECK(handsOff({0x0001, 0}));          // pressed since the last call, up now
  CHECK(!handsOff({0, 0x8000}));         // held
  CHECK(!handsOff({0x8001, 0}));
  // Ctrl held for three polls, then let go: the paste goes on 150 ms later.
  const auto s = std::make_shared<PasteState>();
  std::vector<uint16_t> ctrl(10, 0);
  ctrl[5] = 0x8000;
  s->keys = {ctrl, ctrl, ctrl, std::vector<uint16_t>(10, 1)};
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "ok");
  const std::vector<std::string> seen = s->seen();
  const auto open = std::find(seen.begin(), seen.end(), "open");
  CHECK(std::count(seen.begin(), open, "wait 50") == 3);
  // Held all along: no paste after 3 s.
  const auto held = std::make_shared<PasteState>();
  held->keys = {ctrl};
  CHECK(pasteResult(pastePlatform(held), pasteLine()) == "hands");
  const std::vector<std::string> waited = held->seen();
  CHECK(std::count(waited.begin(), waited.end(), "wait 50") == 60);
  CHECK(!held->saw("open") && !held->saw("ctrl+v"));
  // Taken again between the wait and Ctrl+V: no Ctrl+Shift+V or the like, and the clipboard goes back.
  const auto late = std::make_shared<PasteState>();
  late->clip = {format(0xC09E, "HTML Format", "<i>mine</i>")};
  late->keys = {std::vector<uint16_t>(10, 0), ctrl};
  CHECK(pasteResult(pastePlatform(late), pasteLine()) == "hands");
  CHECK(!late->saw("ctrl+v") && late->writes.size() == 2);
  CHECK(late->clip.size() == 4 && late->clip.front().name == "HTML Format");
}

static void test_paste_gives_up_on_a_busy_clipboard() {
  const auto s = std::make_shared<PasteState>();
  s->failedOpens = -1;
  CHECK(pasteResult(pastePlatform(s), pasteLine()) == "busy");
  const std::vector<std::string> seen = s->seen();
  CHECK(std::count(seen.begin(), seen.end(), "open") == 20);
  CHECK(std::count(seen.begin(), seen.end(), "wait 25") == 19);
  CHECK(!s->saw("ctrl+v") && s->writes.empty());
  // A few busy tries are fine.
  const auto later = std::make_shared<PasteState>();
  later->failedOpens = 3;
  CHECK(pasteResult(pastePlatform(later), pasteLine()) == "ok");
}

static void test_paste_refuses_when_the_clipboard_cannot_be_saved() {
  // Windows formats and macOS items (whose ids are all zero) must both survive a partial read failure.
  const std::vector<std::vector<ClipFormat>> clipboards = {
      {format(13, "", std::string("h\0i\0\0\0", 6)), format(0xC09E, "HTML Format", "<b>mine</b>"),
       format(0xC0C0, "Private Format", "\x01")},
      {format(0, "0|public.utf8-plain-text", "mine"), format(0, "0|public.html", "<b>mine</b>"),
       format(0, "1|com.apple.pasteboard.promised-file-url", "promise")}};
  for (const std::vector<ClipFormat>& original : clipboards) {
    const auto s = std::make_shared<PasteState>();
    s->clip = original;
    s->unreadable = original.back().name;
    const std::string line = pasteLine(R"("click":"-1820,200",)");
    CHECK(pasteResult(pastePlatform(s), line) == "busy");
    CHECK(s->writes.empty() && !s->saw("write") && !s->saw("ctrl+v") && !s->saw("click"));
    const std::vector<std::string> seen = s->seen();
    CHECK(std::count(seen.begin(), seen.end(), "open") == 1);
    CHECK(std::count(seen.begin(), seen.end(), "close") == 1 && seen.back() == "close");
    CHECK(s->sequence == 1 && s->clip.size() == original.size());
    if (s->clip.size() == original.size()) {
      for (size_t i = 0; i < original.size(); ++i) {
        CHECK(s->clip[i].id == original[i].id && s->clip[i].name == original[i].name &&
              s->clip[i].bytes == original[i].bytes);
      }
    }
    // With every format readable, the same route still pastes and restores each original byte.
    s->unreadable.clear();
    CHECK(pasteResult(pastePlatform(s), line) == "ok");
    CHECK(s->clip.size() == original.size() + 3);
    if (s->clip.size() == original.size() + 3) {
      for (size_t i = 0; i < original.size(); ++i) {
        CHECK(s->clip[i].id == original[i].id && s->clip[i].name == original[i].name &&
              s->clip[i].bytes == original[i].bytes);
      }
    }
  }
}

static void test_paste_asks_the_front_window_without_calling_into_the_app() {
  const auto s = std::make_shared<PasteState>();
  ContextPlatform p = pastePlatform(s);
  p.foreground = [s](std::string&, std::string&, std::string&, uint32_t&, Failure&) {
    s->note("foreground");
    return false;
  };
  p.frontWindowId = [s] {
    s->note("front");
    return s->fg;
  };
  CHECK(pasteResult(p, pasteLine()) == "ok");
  CHECK(s->saw("front") && !s->saw("foreground") && s->saw("ctrl+v"));
  s->answers = false;
  CHECK(pasteResult(p, pasteLine()) == "hung");
  // An unreadable or different front window refuses, even if foreground could name the original window.
  p.foreground = pastePlatform(s).foreground;
  p.frontWindowId = [] { return std::string(); };
  CHECK(pasteResult(p, pasteLine()) == "window");
  p.frontWindowId = [] { return std::string("777"); };
  CHECK(pasteResult(p, pasteLine()) == "window");
}

static void test_setfield_asks_the_front_window_without_calling_into_the_app() {
  const auto s = std::make_shared<PasteState>();
  ContextPlatform p = pastePlatform(s);
  p.foreground = [s](std::string&, std::string&, std::string&, uint32_t&, Failure&) {
    s->note("foreground");
    return false;
  };
  p.frontWindowId = [s] {
    s->note("front");
    return s->fg;
  };
  const Command cmd = parseCommand(R"({"type":"setField","id":"s1","window":"263544","field":"1.2","value":"x"})");
  const auto got = fields(handleCommand(cmd, p).line);
  CHECK(got.at("type") == "set" && got.at("result") == "ok");
  CHECK(s->saw("front") && !s->saw("foreground") && s->written == std::vector<std::string>{"x"});
  s->fg = "777";
  CHECK(fields(handleCommand(cmd, p).line).at("result") == "window");
  CHECK(!s->saw("foreground") && s->written.size() == 1);
}

static void test_paste_clicks_presses_ctrl_v_and_restores_a_second_later() {
  const auto s = std::make_shared<PasteState>();
  CHECK(pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200",)")) == "ok");
  std::vector<std::string> seen = s->seen();
  seen.erase(seen.begin(), std::find(seen.begin(), seen.end(), "open"));
  // The cheap checks again right before the click: window in front (not an event here), hands, click target, answer.
  CHECK(seen == std::vector<std::string>({"open", "write", "close", "keys", "windowAt -1820,200", "responsive 263544",
                                          "click -1820,200", "wait 150", "ctrl+v", "wait 1000", "open", "write",
                                          "close"}));
  // A click that moved the foreground: the text is taken back and nothing is pressed.
  const auto moved = std::make_shared<PasteState>();
  ContextPlatform p = pastePlatform(moved);
  p.click = [moved](Point) {
    moved->note("click");
    moved->fg = "555";
    return true;
  };
  CHECK(pasteResult(p, pasteLine(R"("click":"-1820,200",)")) == "window");
  CHECK(!moved->saw("ctrl+v") && moved->writes.size() == 2);
}

static void test_paste_clicks_only_on_the_field_it_was_meant_for() {
  const auto run = [](const std::function<void(PasteState&)>& set, const std::string& extra) {
    const auto s = std::make_shared<PasteState>();
    set(*s);
    const std::string result = pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200",)" + extra));
    // A refused click touches nothing: no clipboard, no click, no Ctrl+V.
    if (result != "ok") CHECK(!s->saw("open") && !s->saw("click") && !s->saw("ctrl+v"));
    return result;
  };
  const std::string reply = R"("field":"42.7.1",)";
  CHECK(parseCommand(pasteLine(R"("click":"-1820,200",)" + reply)).paste.field == "42.7.1");
  CHECK(run([](PasteState& s) { s.atClick.id = "42.7.1"; }, reply) == "ok");
  // The page moved since the ask: another element is under the point now.
  CHECK(run([](PasteState& s) { s.atClick.id = "42.7.9"; }, reply) == "window");
  CHECK(run([](PasteState& s) { s.atClick = FieldFacts{"other", "Send", false, "42.7.1"}; }, R"("field":"",)") ==
        "window");
  // Without an id the point must still be on a text field, never a button.
  CHECK(run([](PasteState& s) { s.atClick = FieldFacts{"other", "Send", false, "9.9"}; }, "") == "window");
  CHECK(run([](PasteState& s) { s.atClick = FieldFacts{"multiline", "Notes", false, "9.9"}; }, "") == "ok");
  CHECK(parseCommand(pasteLine(R"("field":")" + std::string(121, '1') + R"(",)")).kind == Command::Kind::Bad);
}

static void test_paste_click_finds_its_field_above_the_element_hit() {
  const auto run = [](const std::function<void(PasteState&)>& set) {
    const auto s = std::make_shared<PasteState>();
    set(*s);
    const std::string result =
        pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200","field":"42.7.1",)"));
    if (result != "ok") CHECK(!s->saw("open") && !s->saw("click") && !s->saw("ctrl+v"));
    return result;
  };
  const auto paragraph = [](std::vector<AncestorFacts> above) {
    FieldFacts f{"other", "", false, "42.7.1.5"};
    f.ancestors = std::move(above);
    return f;
  };
  // The browser's hit test lands on a paragraph inside the field: its parent is the field.
  CHECK(run([&](PasteState& s) { s.atClick = paragraph({{"42.7.1", "Message", false}}); }) == "ok");
  CHECK(run([&](PasteState& s) {
          s.atClick = paragraph({{"42.7.1.4", "", false}, {"42.7.1.3", "", false}, {"42.7.1", "Message", false}});
        }) == "ok");
  // A button inside the field, such as a clear or emoji button, is not the field.
  CHECK(run([&](PasteState& s) {
          s.atClick = paragraph({{"42.7.1", "Message", false}});
          s.atClick.activatable = true;
        }) == "window");
  // Four levels up is too far to be the field the click meant.
  CHECK(run([&](PasteState& s) {
          s.atClick = paragraph({{"9.1", "", false}, {"9.2", "", false}, {"9.3", "", false}, {"42.7.1", "", false}});
        }) == "window");
  // The matched field is a password field, though the element hit says nothing of it.
  CHECK(run([&](PasteState& s) { s.atClick = paragraph({{"42.7.1", "Message", true}}); }) == "secure");
  CHECK(run([&](PasteState& s) { s.atClick = paragraph({{"42.7.1", "Card number", false}}); }) == "secure");
  CHECK(run([&](PasteState& s) { s.atClick = paragraph({{"42.7.1", "Message", false}}); s.atClick.secure = true; }) ==
        "secure");
  // The field hit directly is fine even when it reports a click action of its own.
  CHECK(clickTarget(FieldFacts{"text", "Message", false, "42.7.1", true, {}}, "42.7.1").empty());
  // Without an id the element hit must itself be a text field: a parent field does not count.
  CHECK(clickTarget(paragraph({{"42.7.1", "Message", false}}), "") == "window");
}

static void test_paste_click_refuses_a_button_between_the_element_hit_and_its_field() {
  const auto above = [](AncestorFacts between) {
    FieldFacts f{"other", "", false, "42.7.1.5"};
    f.ancestors = {std::move(between), AncestorFacts{"42.7.1", "Message", false, false}};
    return f;
  };
  // <button><span>x</span></button> inside a contenteditable: the text hit passes, but the click reaches the button.
  CHECK(clickTarget(above(AncestorFacts{"42.7.1.4", "Clear", false, true}), "42.7.1") == "window");
  CHECK(clickTarget(above(AncestorFacts{"42.7.1.4", "example.com", false, true}), "42.7.1") == "window");  // a link
  CHECK(clickTarget(above(AncestorFacts{"42.7.1.4", "", false, false}), "42.7.1").empty());
  // The same through the paste: nothing is touched.
  const auto s = std::make_shared<PasteState>();
  s->atClick = above(AncestorFacts{"42.7.1.4", "Clear", false, true});
  CHECK(pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200","field":"42.7.1",)")) == "window");
  CHECK(!s->saw("open") && !s->saw("click") && !s->saw("ctrl+v"));
  // The field matched is not judged by its own click action (an exact match, as for the element hit).
  FieldFacts direct = above(AncestorFacts{"42.7.1.4", "", false, false});
  direct.ancestors[1].activatable = true;
  CHECK(clickTarget(direct, "42.7.1").empty());
}

static void test_paste_checks_again_right_before_the_click() {
  const std::vector<ClipFormat> mine = {format(0xC09E, "HTML Format", "<i>mine</i>")};
  // The click point now lands in another window (the field scrolled away, a window opened over it).
  const auto under = std::make_shared<PasteState>();
  under->clip = mine;
  under->moveAfterWrite = true;
  CHECK(pasteResult(pastePlatform(under), pasteLine(R"("click":"-1820,200",)")) == "window");
  CHECK(!under->saw("click") && !under->saw("ctrl+v"));
  CHECK(under->writes.size() == 2 && under->clip.size() == 4 && under->clip.front().name == "HTML Format");
  // The app stopped answering while the clipboard was set.
  const auto frozen = std::make_shared<PasteState>();
  frozen->clip = mine;
  frozen->freezeAfterWrite = true;
  CHECK(pasteResult(pastePlatform(frozen), pasteLine()) == "hung");
  CHECK(!frozen->saw("ctrl+v") && frozen->writes.size() == 2 && frozen->clip.front().name == "HTML Format");
}

static void test_paste_finishes_inside_its_deadline() {
  // Hands on for 2.95 s, then an app slow to answer: too little time is left for Ctrl+V, the second's wait and the
  // restore, so the text never goes on the clipboard.
  const auto late = std::make_shared<PasteState>();
  late->keys = heldFor(59);
  late->answerMs = 900;
  CHECK(pasteResult(pastePlatform(late), pasteLine()) == "busy");
  CHECK(late->writes.empty() && !late->saw("ctrl+v"));
  // The same wait with a quick app pastes, clicks included, and the reply leaves inside the deadline.
  const auto quick = std::make_shared<PasteState>();
  quick->keys = heldFor(59);
  quick->answerMs = 100;
  CHECK(pasteResult(pastePlatform(quick), pasteLine(R"("click":"-1820,200",)")) == "ok");
  CHECK(quick->clock <= kPasteDeadlineMs && quick->writes.size() == 2);
  // The hands-off wait is wall time, however long a poll takes.
  const auto slow = std::make_shared<PasteState>();
  slow->keys = heldFor(1000);
  slow->pollMs = 100;
  CHECK(pasteResult(pastePlatform(slow), pasteLine()) == "hands");
  const std::vector<std::string> seen = slow->seen();
  CHECK(std::count(seen.begin(), seen.end(), "wait 50") == 20 && slow->clock < kHandsOffWaitMs + 200);
}

static void test_paste_puts_the_clipboard_back_or_says_it_could_not() {
  const std::vector<ClipFormat> mine = {format(0xC09E, "HTML Format", "<i>mine</i>")};
  // Another app holds the clipboard from the moment Ctrl+V went out: the restore keeps trying for 1.5 s, then says so.
  const auto held = std::make_shared<PasteState>();
  held->clip = mine;
  held->opensAllowed = 1;
  const auto m = fields(handleCommand(parseCommand(pasteLine()), pastePlatform(held)).line);
  CHECK(m.at("result") == "ok" && m.count("restored") == 1 && m.at("restored") == "false");
  std::vector<std::string> seen = held->seen();
  seen.erase(seen.begin(), std::find(seen.begin(), seen.end(), "ctrl+v"));
  CHECK(std::count(seen.begin(), seen.end(), "wait 25") == kRestoreTryMs / kClipboardRetryMs);
  CHECK(held->clock <= kPasteDeadlineMs);
  // A restore that works says nothing.
  const auto fine = std::make_shared<PasteState>();
  fine->clip = mine;
  CHECK(fields(handleCommand(parseCommand(pasteLine()), pastePlatform(fine)).line).count("restored") == 0);
  // The user copied something newer meanwhile: theirs stays, the old clipboard is not put over it.
  const auto newer = std::make_shared<PasteState>();
  newer->clip = mine;
  newer->copyDuringPaste = true;
  const auto n = fields(handleCommand(parseCommand(pasteLine()), pastePlatform(newer)).line);
  CHECK(n.at("result") == "ok" && n.count("restored") == 0 && newer->writes.size() == 1);
  // Whatever goes wrong after the text went on, the clipboard comes back.
  const auto thrown = std::make_shared<PasteState>();
  thrown->clip = mine;
  thrown->throwOnPaste = true;
  CHECK(fields(handleCommand(parseCommand(pasteLine()), pastePlatform(thrown)).line).at("type") == "error");
  CHECK(thrown->writes.size() == 2 && thrown->clip.front().name == "HTML Format");
}

static void test_paste_refuses_an_app_run_as_administrator() {
  const auto s = std::make_shared<PasteState>();
  s->elevatedTarget = true;
  CHECK(pasteResult(pastePlatform(s), pasteLine(R"("click":"-1820,200",)")) == "elevated");
  CHECK(!s->saw("uia") && !s->saw("open") && !s->saw("click") && !s->saw("ctrl+v"));
}

static void test_paste_and_set_field_need_a_platform_that_has_them() {
  Fake fake;
  const auto m = fields(handleCommand(parseCommand(pasteLine()), fake.platform()).line);
  CHECK(m.at("type") == "error" && m.at("code") == "bad");
  const auto f = fields(handleCommand(parseCommand(
      R"({"type":"setField","id":"s1","window":"263544","field":"1.2","value":"x"})"), fake.platform()).line);
  CHECK(f.at("type") == "error" && f.at("code") == "bad");
}

namespace {

std::string setResult(const ContextPlatform& p, const std::string& value = "Ada", int budgetMs = kProbeBudgetMs) {
  const std::string line =
      R"({"type":"setField","id":"s1","window":"263544","field":"42.7.1","value":")" + value + "\"}";
  const auto m = fields(handleCommand(parseCommand(line), p, budgetMs).line);
  return m.count("type") && m.at("type") == "set" && m.at("id") == "s1" ? m.at("result") : "?";
}

}  // namespace

static void test_setfield_refuses_a_password_field() {
  const auto s = std::make_shared<PasteState>();
  s->field = FieldFacts{"text", "Password", true};
  CHECK(setResult(pastePlatform(s), "hunter2") == "secure");
  CHECK(s->written.empty());
  const auto card = std::make_shared<PasteState>();
  card->field = FieldFacts{"text", "\xe8\xba\xab\xe4\xbb\xbd\xe8\xaf\x81\xe5\x8f\xb7", false};  // the ZH ID number
  CHECK(setResult(pastePlatform(card)) == "secure" && card->written.empty());
  const auto name = std::make_shared<PasteState>();
  CHECK(setResult(pastePlatform(name)) == "ok");
  CHECK(name->written == std::vector<std::string>({"Ada"}));
  CHECK(name->seen().front() == "responsive 263544");  // the frozen-app check comes first
}

static void test_setfield_checks_the_window_and_finds_the_field() {
  const auto other = std::make_shared<PasteState>();
  other->fg = "1";
  CHECK(setResult(pastePlatform(other)) == "window" && other->seen().empty());
  const auto frozen = std::make_shared<PasteState>();
  frozen->answers = false;
  CHECK(setResult(pastePlatform(frozen)) == "hung" && !frozen->saw("uia"));
  const auto gone = std::make_shared<PasteState>();
  gone->setResult = "gone";
  CHECK(setResult(pastePlatform(gone)) == "gone");
  const auto refused = std::make_shared<PasteState>();
  refused->setResult = "refused";
  CHECK(setResult(pastePlatform(refused)) == "refused");
  // A write still running at its budget: the app is not answering, and the helper ends after the reply.
  const auto slow = std::make_shared<PasteState>();
  slow->slowSetMs = 300;
  const Reply r = handleCommand(
      parseCommand(R"({"type":"setField","id":"s1","window":"263544","field":"42.7.1","value":"Ada"})"),
      pastePlatform(slow), 50);
  CHECK(fields(r.line).at("result") == "hung" && r.exitAfter);
}

int main() {
  test_parse_paste_command();
  test_parse_set_field_command();
  test_restore_keeps_every_saved_format();
  test_paste_keeps_an_empty_marker_format();
  test_exclusion_formats_are_recognised_by_name();
  test_paste_marks_both_writes_as_excluded();
  test_paste_refuses_a_window_that_does_not_answer();
  test_paste_refuses_another_window();
  test_paste_replaces_only_while_the_selection_holds_the_asked_text();
  test_paste_refuses_a_secure_field();
  test_paste_fails_closed_when_its_checks_run_over();
  test_hands_off_ignores_released_keys();
  test_paste_gives_up_on_a_busy_clipboard();
  test_paste_refuses_when_the_clipboard_cannot_be_saved();
  test_paste_asks_the_front_window_without_calling_into_the_app();
  test_setfield_asks_the_front_window_without_calling_into_the_app();
  test_paste_clicks_presses_ctrl_v_and_restores_a_second_later();
  test_paste_clicks_only_on_the_field_it_was_meant_for();
  test_paste_click_finds_its_field_above_the_element_hit();
  test_paste_click_refuses_a_button_between_the_element_hit_and_its_field();
  test_paste_checks_again_right_before_the_click();
  test_paste_finishes_inside_its_deadline();
  test_paste_puts_the_clipboard_back_or_says_it_could_not();
  test_paste_refuses_an_app_run_as_administrator();
  test_paste_and_set_field_need_a_platform_that_has_them();
  test_setfield_refuses_a_password_field();
  test_setfield_checks_the_window_and_finds_the_field();
  test_parse_capture_command();
  test_parse_other_commands();
  test_parse_rejects_bad_input();
  test_zoom_rect_stays_inside_the_display();
  test_overview_size_keeps_aspect();
  test_draw_spot_marker();
  test_draw_spot_marker_clips_at_the_edge();
  test_capture_writes_overview_and_one_zoom_per_spot();
  test_capture_scales_spots_to_a_larger_image();
  test_capture_shows_the_area_and_the_crops();
  test_capture_failure_is_an_error_reply();
  test_foreground_and_pong_replies();
  test_front_reply();
  test_front_without_platform_is_bad();
  test_loop_answers_until_shutdown();
  test_parse_read_command();
  test_read_answers_every_layer_it_was_asked_for();
  test_read_sends_the_boxes_around_each_spot();
  test_thin_boxes_keeps_the_inner_boxes_and_the_window();
  test_read_leaves_out_the_layers_that_are_off();
  test_read_reports_a_failed_layer_and_keeps_the_others();
  test_secure_focus_sends_no_value();
  test_never_fill_focus_sends_no_value_and_no_selection();
  test_read_runs_its_layers_under_one_deadline();
  test_read_looks_up_a_browser_address_once();
  test_read_sends_what_finished_and_exits_after_a_slow_layer();
  test_marks_file_escapes_tabs_and_newlines();
  test_marks_file_cuts_on_a_character_boundary();
  test_form_fields_send_no_value_for_a_secure_field();
  test_form_fields_file_cuts_labels_on_a_character_boundary();
  test_form_fields_file_keeps_one_line_per_field_and_the_caps();
  test_form_fields_file_gives_each_field_its_box();
  test_read_leaves_the_fields_layer_off_unless_asked_and_reports_a_failure();
  test_never_fill_labels_match_the_shared_table();
  test_form_fields_blank_the_value_of_a_never_fill_label();
  test_read_runs_the_fields_search_after_the_text_probe_on_one_thread();
  test_budget_gives_up_on_a_slow_probe();
  test_budget_returns_a_fast_probe();
  test_cut_text_keeps_whole_characters();
  test_file_name_from_a_window_title();
  test_acrobat_mru_path();
  test_office_mru_path();
  test_browser_address();
  std::printf("%d passed, %d failed\n", g_pass, g_fail);
  return g_fail == 0 ? 0 : 1;
}
