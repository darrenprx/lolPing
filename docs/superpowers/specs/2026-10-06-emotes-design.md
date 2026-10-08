# Emotes — Design Spec

**Date:** 2026-10-06
**Status:** Approved in brainstorming; not yet implemented
**Target:** M1 → v0.5.0, M2 → v0.5.1
**Builds on:** the shipped wheel (v0.2.1), rooms ([2026-10-04-room-ping-sharing-design.md](2026-10-04-room-ping-sharing-design.md)) and internet rooms ([2026-10-05-internet-rooms-design.md](2026-10-05-internet-rooms-design.md)). The update checker that also ships in v0.5.0 has its own spec.

## 1. Purpose

A League-style **emote wheel**: hold a second key, drag, let go on an emote, and it pops up on your screen and on your room members' screens. It is for reacting with friends in rooms and for being seen on stream, equally.

**Success criteria:**
1. Ctrl + drag (⌃ Control + drag on a Mac) opens an emote wheel. Alt + drag still opens the ping wheel.
2. Bundled League emotes look and sound like they do in game, including the ones with special animations.
3. Your own images (PNG, JPG, GIF, WebP) can go on the emote wheel. Animated ones play on your screen.
4. Room members see your emotes at the same spot with your name tag. In M2 they also see your own images, as a still.
5. A v0.4 peer and a v0.5 peer still ping each other. The v0.4 peer just doesn't see emotes.
6. Windows ↔ Windows, Windows ↔ macOS and macOS ↔ macOS all work.

## 2. Decisions log

| Topic | Decision |
|---|---|
| What an emote is | League's emote wheel: 8 slices plus a centre emote, the same shape as the ping wheel. |
| Opening it | Its own trigger, `emoteTrigger`, with the same choices as the ping trigger plus **Off**. Default **Ctrl** on both platforms. Trigger + click places the centre emote, off by default. |
| Ctrl + drag | Taken over while lolPing is on. The README says so and points to the setting. Ctrl + click without a drag still reaches apps (the helper replays it). |
| Bundled set | About 32 curated League emotes, picked by the user from a gallery of baked candidates. |
| Bundled animation | League emotes are particle effects (one effect file per emote driving `_vfx`, `_glow` and shared erode/bubble textures). The extract tool **bakes** each curated emote's effect into a 3 s animated WebP. The app only plays images. |
| Bundled sound | Each curated emote ships its League sound (`Play_sfx_Emotes_<id>`) as Opus in `.ogg`. |
| Duration | Fixed at 3 s, as in League. There is no duration setting. |
| Own images | Imported in the settings window. Every image gets a ≤ 12 KB WebP **still**, whose hash is its ID. GIF and animated WebP also keep the original **animation**, up to 5 MB, for your screen only. At most 24. |
| Own images in rooms | M1: friends see a placeholder. M2: stills travel to friends through announce + request + chunks (approach "prefetch with placeholder fallback"). Animations never travel. |
| Spam | One emote per person on screen at a time: a new emote from the same person replaces the old one, as in League. Pings and emotes share the incoming limit. |
| Protocol | `PROTOCOL_VERSION` stays 1. New message types and presence fields are additive; v0.4 peers drop them silently. |
| Milestones | M1 (v0.5.0): everything except stills travelling. M2 (v0.5.1): stills travel, plus **Show friends' custom emotes**. |

## 3. Architecture

```
native/hook-helper        two triggers; every point event says which wheel
main process
 ├─ OverlayManager        routes wheel:* by wheel; emote clicks; remote emotes with resolved art
 ├─ EmoteLibrary          own images on disk: save, remove, check at launch
 ├─ EmoteCache       (M2) received stills, LRU
 ├─ RoomManager           emote messages; (M2) presence `em`, want/chunk via EmoteTransfer
 │   └─ EmoteTransfer (M2) sender queue + receiver assembler, pure logic
 └─ appProtocol           lolping://emotes/… serves EmoteLibrary and EmoteCache files
overlay renderer          two Wheel instances; emoteFx plays emotes
settings renderer         Emotes section; emoteImport turns a file into still + animation
tools/extract-assets      --emotes: reads League data, bakes animations, extracts sounds
```

### 3.1 New modules

| Module | Kind | Responsibility |
|---|---|---|
| `src/shared/emotes.ts` | pure | `EmoteRef` type and validation, `BUNDLED_EMOTES` (re-exported from the generated catalog), default emote wheel and centre emote, asset URL helpers. |
| `src/shared/emoteCatalog.ts` | generated | Written by `tools/extract-assets --emotes`: `slug`, League emote `id`, `name`, `hasSound`, plus the default wheel. A header comment says it is generated. |
| `src/main/emoteLibrary.ts` | fs | Owns `<settings folder>/emotes/`: writes an import atomically (temp names, then rename both), removes, lists, and at launch drops `customEmotes` entries whose still is missing. |
| `src/main/emoteCache.ts` | fs (M2) | Owns `<settings folder>/emote-cache/`: `has(hash)`, `put(hash, bytes)` after verification, LRU eviction (at most 200 files and 4 MB, by last use; checked at launch and on every put). |
| `src/main/emoteTransfer.ts` | logic (M2) | Sender queues and the receiver assembler (§8). Clock and send functions are injected for tests. |
| `src/renderer/overlay/emoteFx.ts` | DOM | Spawns, replaces and removes emotes (§6). |
| `src/renderer/settings/emoteImport.ts` | DOM | File → still (+ animation) (§5.2). |
| `src/renderer/settings/components/EmoteSection.tsx` | React | The Emotes section (§7). |
| `tools/extract-assets/emote_bake.py` | tool | Effect-file parser and frame renderer (§5.1). |

### 3.2 Changed modules

| Module | Change |
|---|---|
| `native/hook-helper` (`decision.*`, `commands.cpp`, `output.cpp`) | Second trigger (§4). `ready` version 1 → 2. |
| `src/shared/protocol.ts` | `HelperEvent` point events gain `wheel: 'ping' \| 'emote'` (missing → `'ping'`). The `config` command gains `emoteTrigger: HelperTrigger \| 'off'`, `emoteTriggerVk`, `emoteClick`. |
| `src/shared/settings.ts` | New fields (§7.1) with normalization. `OverlaySettings` gains the emote fields. |
| `src/shared/ipc.ts` | `emote:spawn` overlay event, `OVERLAY_EMOTED`, and new `SettingsApi` calls (§7.2). |
| `src/shared/roomProtocol.ts` | `emote` message (M1); presence `em`, `want`, `chunk` (M2). |
| `src/main/overlayManager.ts` | Routes `wheel:*` by `wheel`; handles emote clicks; `spawnRemoteEmote`; emits `'sharedEmote'`. |
| `src/main/roomManager.ts` | `sendEmote`, receive path for emotes; (M2) EmoteTransfer wiring and the low-priority relay budget. |
| `src/main/appProtocol.ts` | An `emotes` host for custom files, registered in dev and production. |
| `src/renderer/overlay/wheel.ts` | Generic over its items: `WheelItem { key: string; icon: string }` plus a centre label (`PING` / `EMOTE`). |
| `src/renderer/overlay/index.html` | CSP: `img-src 'self' data: blob: lolping://emotes; connect-src 'self' lolping://emotes`. |
| `src/renderer/overlay/soundBank.ts` | Loads by URL as well as by name, so it can play `assets/emotes/<slug>.ogg`. |
| `src/renderer/settings/components/WheelEditor.tsx` | Generic over its items, so the Emotes section reuses it. |
| `src/shared/i18n.ts` | New strings (§10.2), English and 简体中文. |
| `tools/extract-assets/extract_assets.py` | `--emotes` mode (§5.1). |
| `tools/room-peer` | `--emotes`: also fires bundled emotes and, in M2, announces and serves one custom emote. |

## 4. Input

### 4.1 Helper

`Config` gains:

```cpp
Trigger emoteTrigger = Trigger::None;  // new enum value None = emote wheel off
uint32_t emoteTriggerVk = 0;           // only for Trigger::CustomVk
bool emoteClick = false;
```

- **Gesture owner.** The trigger held when the mouse button goes down owns the gesture, and every `wheelOpen`, `wheelMove`, `wheelRelease` and `click` it produces carries `"wheel":"ping"` or `"wheel":"emote"`.
- **Both held** (for example Ctrl + Alt, or AltGr, which Windows reports as Ctrl + Alt): nothing opens and the input passes through untouched.
- **Unchanged and shared by both wheels:** drag threshold, Esc / right-click cancel, the 10 s watchdog, replaying a click that never became a drag, swallowing a custom key trigger, the pause shortcut, and `suspend`.
- **Releasing the owning trigger mid-gesture** behaves as it does for the ping wheel today.
- **Key rules** (enforced in settings, §7.1): the emote trigger differs from the ping trigger, and a custom emote key differs from the pause shortcut's key.
- **macOS:** Control + click without a drag is replayed, so it still works as a secondary click.

### 4.2 Main and overlay

- `configCommand` sends the emote fields. `parseHelperLine` reads `wheel`.
- OverlayManager tracks the open wheel's kind with its display and forwards `wheel:open|move|release|cancel` with `{ wheel }`. Only one wheel is open at a time.
- An emote `click` spawns `clickEmoteId` at the point and emits `'sharedEmote'`, like ping clicks.
- The overlay holds two `Wheel` instances, the ping wheel and the emote wheel, sharing the existing SVG geometry. The emote wheel's slice icons are bundled `_selector` art or custom stills, drawn round.

## 5. Emote assets

### 5.1 Bundled emotes (`tools/extract-assets --emotes`)

**Inputs** (all from a local League install):
- `Plugins/rcp-be-lol-game-data/default-assets.wad` → `plugins/rcp-be-lol-game-data/global/default/v1/summoner-emotes.json`: id, name and inventory icon path of all 2,379 emotes.
- `Game/DATA/FINAL/Global.wad.client`:
  - Per emote, the textures `assets/loadouts/summoneremotes/<…>/<base>_vfx.tex`, `_glow.tex` and `_selector.tex`, where `<base>` comes from the inventory icon path, lower-cased, with `_inventory.png` removed.
  - The emote's effect file (`Loadouts/SummonerEmotes/Particles/EM_…`, about 4 KB) and the template files it links (`Loadouts/SummonerEmotes.<hash>.bin`).
  - The shared textures under `ASSETS/Shared/Particles/Emotes/Templates/`.
- The Wwise bank that holds `Play_sfx_Emotes_*` events.

**What the effect files contain** (measured on the installed client, 2026-10-05):
- 2,399 effect files.
- Three motion families cover about 96% of emotes: standard dissolve plus bubbles (1,767), and two "Anger/Confused" erode variants (276 and 271).
- About 25 emotes have one-off effects (spin, rays, coloured glow, 13–18 texture layers). These are the specially animated ones.
- 1,084 effect files name their own sound event.

**Baker** (`emote_bake.py`, Pillow + NumPy):
1. Parses the `PROP` effect file and its linked templates: emitters, textures, lifetime and delays, birth and over-life curves for scale, colour/alpha, erosion, rotation and translation, particle counts and spawn rate, and blend mode. Field names are FNV-1a hashes. The tool embeds the names it needs, taken from CommunityDragon's published hash lists during the spike.
2. Renders 3 s at 30 fps onto a 320 × 320 transparent canvas, emote centred. Supported features: additive and alpha blending, erosion thresholding against the erode texture, and keyframed curves with linear interpolation.
3. Writes `assets/emotes/<slug>.webp` (animated, lossy with alpha, quality 80, played once), `assets/emotes/<slug>.png` (the `_selector` icon) and `assets/emotes/<slug>.ogg`.
4. Logs every effect property it skipped, per emote, so unfaithful bakes are visible.

**Sound:** the emote's `Play_sfx_Emotes_<id>` event, decoded with vgmstream and mixed with ffmpeg like the ping sounds, then encoded as Opus (96 kbps) in `.ogg`. An emote whose effect names no sound uses League's shared emote sound if the spike finds one, and is otherwise silent (`hasSound: false`).

**Curation:**
1. The spike (plan task 1) bakes one standard emote and one special one, and the user compares them with the game.
2. When both match, the tool bakes a candidate list into a gallery page that plays each animation with its sound.
3. The user picks about 32, plus the default wheel (8) and centre emote.
4. An emote is only included if its bake is faithful. The selection is stored as a list of League emote ids in the tool, so a re-extract after a patch reproduces it.

Expected size: 150–300 KB per animation, a few KB per icon and sound, 5–10 MB in total.

### 5.2 Your own images (`emoteImport.ts`, settings renderer)

**Accepted:** PNG, JPG, GIF and WebP, up to 8 MB, from **Add image…** (a hidden `<input type="file">`) or a file dropped on the pool. The type is sniffed from the first bytes, not the extension.

**Processing** (`ImageDecoder`, `OffscreenCanvas`):
1. Decode frame 0.
2. **Still:** scale so the longest side is 160 px and encode WebP at quality 0.85. Step quality down by 0.1 to 0.45 until it is ≤ 12 KB (12,288 bytes). If it is still too big, repeat at 128 px. If that fails too, refuse with "This image is too detailed".
3. **Animation** (GIF or WebP with more than one frame): the original bytes, if ≤ 5 MB and ≤ 1024 px on its longest side, otherwise refuse (decoding a huge animation for every emote would stall the overlay). It is not re-encoded.
4. `id` = `c:` + the first 32 hex characters of SHA-256(still).
5. `name` = the file name without its extension, sanitized like room names, at most 24 code points.
6. Send `{ name, still, anim?, animExt? }` to main (`importEmote`). Importing an image whose `id` already exists does nothing and says so.

**Storage** (EmoteLibrary): `<settings folder>/emotes/<hash>.webp` and `<hash>.anim.gif|webp`. Both are written to temp names first, then renamed. A failure removes both, and the `customEmotes` entry is added only after both renames succeed.

**Serving:** `lolping://emotes/<hash>.webp` (the still) and `lolping://emotes/<hash>.anim` (the animation: `.anim.gif` or `.anim.webp` on disk, falling back to the still if neither exists) resolve with `resolveInside`, first in `emotes/` and then (M2) in `emote-cache/`. No other names are served.

**Removing** deletes the files and the entry. Wheel slots using it fall back as in §7.1.

## 6. On screen (`emoteFx.ts`)

- **Where:** at the wheel's centre, like pings. A trigger + click places it at the click point. Remote emotes use the room's display mapping and show the sender's name tag (the existing tag style).
- **Size:** `emoteSizePx` (default 150) is how wide the emote art appears. A bundled animation's 320 px canvas holds 256 px of art, so it is drawn at `emoteSizePx × 320 / 256`. Custom images are drawn with their longest side at `emoteSizePx`.
- **Bundled:** the baked animation is the whole show (it already dissolves in and out). Each spawn creates a fresh object URL from a Blob fetched once per emote, because Chromium shares one animation clock between images with the same URL. A fresh URL guarantees every emote starts at frame 0. The URL is revoked when the element is removed. Its sound plays at the ping volume unless `emoteSound` is off or sound is muted.
- **Custom** (static or animated): a CSS envelope.
  1. 0–0.25 s: scale 0 → 1.15 → 1.
  2. Hold: bob ±4 px.
  3. Last 0.35 s: scale to 0.85 and fade out.

  The glow is a soft white `drop-shadow`. Animations loop inside the envelope. Custom emotes have no sound.
- **Placeholder** (a custom emote the receiver doesn't have): a CSS speech bubble with "?" and the sender's tag, in the same envelope.
- **Lifetime:** 3 s, then removed.
- **One per person:** emoteFx keeps `owner → element`, where owner is `self` or a peer ID. A new emote from the same owner removes the old element at once.

## 7. Settings

### 7.1 New fields

| Field | Type | Default | Normalization |
|---|---|---|---|
| `emoteTrigger` | `TriggerKey \| 'off'` | `'ctrl'` | Equal to `trigger`, or a custom key equal to the pause shortcut's key → `'off'`, with a problem noted in About. |
| `emoteClick` | `boolean` | `false` | |
| `emoteWheel` | `EmoteRef[8]` | catalog default | Must be 8 distinct valid refs, else the default. A custom ref not in `customEmotes` is replaced by that slot's default emote, or, if that emote is already on the wheel, by the first bundled emote not on it. |
| `clickEmoteId` | `EmoteRef` | catalog default | Invalid or unknown → default. |
| `emoteSizePx` | `number` | 150 | `LIMITS.emoteSizePx = { min: 80, max: 300, step: 1 }`. |
| `emoteSound` | `boolean` | `true` | |
| `customEmotes` | `{ id, name, animated }[]` | `[]` | At most 24, unique ids matching `c:[0-9a-f]{32}`, names sanitized. At launch EmoteLibrary drops entries whose still is missing, then the wheel rule above applies. |
| `friendEmotes` (M2) | `boolean` | `true` | |

`EmoteRef` is a bundled slug in the catalog, or `c:` + 32 lower-case hex characters.

A `setSettings` patch that would make the two triggers equal, or a custom emote key equal to the pause shortcut's key, is refused (`ok: false`) whichever field it changes. The normalization above only covers settings files edited by hand.

### 7.2 IPC

- **`SettingsApi`:**
  - `importEmote(file) → { ok: true; id } | { ok: false; error: ImportError }`, where `ImportError` is `'type' | 'size' | 'animSize' | 'detail' | 'full' | 'duplicate' | 'disk'`.
  - `removeEmote(id)`
  - `previewEmote(ref)`, which plays it in the middle of the primary display, like `previewPing`.
- **Overlay events:**
  - `emote:spawn` → `{ x, y, owner, tag?, art }`. `art` is `{ kind: 'bundled', slug }`, `{ kind: 'custom', url, animated }` or `{ kind: 'placeholder' }`. The overlay resolves its own wheel emotes from `OverlaySettings`. Main resolves remote ones, because only main knows the cache.
  - `OVERLAY_EMOTED`: overlay → main `{ ref, x, y }` after the emote wheel places one, so it can be shared.

## 8. Rooms

### 8.1 M1: emote messages

```ts
interface EmoteMsg extends Base { t: 'emote'; e: EmoteRef; d: number; x: number; y: number }
```

- **Validation:** `e` must be a valid `EmoteRef` shape. A bundled slug not in this version's catalog (sent by a newer peer) is accepted and shown as the placeholder. `d`, `x` and `y` follow the ping rules.
- **Sending:** `sendEmote` mirrors `sendPing`: same routes, same paused check, and over relays the same `relayCap` bucket (5/s, burst 10), shared by pings and emotes.
- **Receiving:** same gates as pings (paused, room muted, member muted, `needsUpdate`), and the same `limiter` budget per member, so pings and emotes share the incoming limit. Then `resolveTarget(d)` → `'remoteEmote'` → OverlayManager resolves art: bundled → bundled, custom in library or cache → custom URL (static still only), otherwise placeholder.
- **Old peers:** a member whose presence `app` is below `0.5.0` shows "Can't see emotes, needs an update" in the member list.

### 8.2 M2: custom stills travel

**Announce.** Presence gains `em: string[]`: the 32-hex hashes of custom emotes currently on your emote wheel and centre, at most 9. A presence with `em` stays under 600 bytes before sealing.

**Messages:**

```ts
interface WantMsg  extends Base { t: 'want';  to: string; h: string; need: number[] }        // need ≤ 64 indexes; [] = all
interface ChunkMsg extends Base { t: 'chunk'; h: string; i: number; n: number; b: string }   // b = base64, ≤ 1000 chars
```

- `n` ≤ 17 (12 KB at about 750 bytes per chunk), `i` < `n`. A chunk's sealed packet stays ≤ 1,200 bytes.
- Validation rejects wrong shapes, `n` over 17, `b` over 1,000 characters or not base64, and `need` over 64 entries.

**Who asks.** On a presence with `em`, for each hash that is not in the library or cache and not already being assembled, and only when `friendEmotes` is on and the member isn't muted: send `want { to: owner, h, need: [] }` on that member's route.

**Sender** (EmoteTransfer):
- Only answers `want` for hashes in its own current `em`.
- Keeps one queue per hash. A new `want` merges its `need` into the queue.
- **LAN:** chunks go point-to-point to the requester, at most 20 per second per requester.
- **Relays:** chunks are broadcast, at low priority on the ping bucket: a chunk is sent only if at least 5 tokens remain afterwards. So pings always keep a burst of 5, and an idle sender streams about one 12 KB image every 6 s.
- A queue is dropped when it is done, when the requester leaves, or when the hash leaves `em`.

**Receiver** (EmoteTransfer):
- Accepts chunks for any hash some current member has announced, whether it asked or not (one relay broadcast fills everyone's cache), and only from the member who announced that hash.
- **Limits:** at most 16 assemblies, 256 KB in total, and an assembly is dropped 60 s after its first chunk.
- **Re-asks:** 3 s without a new chunk → `want` with the missing indexes, at most 3 times. After that the hash waits for the announcer's next presence.
- **Completion:** SHA-256 prefix equals `h`, the bytes start with `RIFF....WEBP`, and the WebP header's size is ≤ 160 px on its longest side → `EmoteCache.put`. Otherwise the assembly is discarded.

**Switch.** **Show friends' custom emotes** off: no `want` is sent, chunks are ignored, and friends' custom emotes are not shown at all (not even the placeholder).

## 9. Privacy and trust

- Emote messages, presence `em`, `want` and `chunk` are sealed with the room key like every room message. Relays see only more ciphertext events of the usual size, at most 5 per second per sender.
- A custom emote's ID is its content hash: nobody can substitute another member's image, and the cache is verified.
- Any member can show any image they like to the room, the same as choosing their own name. Mute that person, or turn off **Show friends' custom emotes**. Rooms are invite-only by code, with at most 8 people.
- Received images are decoded only by Chromium in the sandboxed overlay renderer, after the size and header checks above.

## 10. User experience

### 10.1 Settings window

A new **Emotes** section between **Wheel** and **Room**, with a nav entry:
- **Emote key:** the trigger picker plus **Off**. The current ping trigger is disabled in the list.
- **{key} + click places an emote:** a switch.
- **Emote size:** a slider.
- **Emote sound:** a switch.
- **Emote wheel:** the generic `WheelEditor`. The pool lists the bundled emotes, then your own images (each with ×), then **Add image…**. Dropping a file on the pool imports it. Import errors show under the pool.
- **Room section (M2):** **Show friends' custom emotes**.

### 10.2 Strings (en / zh-CN)

`navEmotes`, `emoteKey`, `emoteKeyDesc`, `emoteKeyOff`, `emoteClick(key)`, `emoteSize`, `emoteSound`, `emoteWheel`, `addImage`, `removeImage`, `importErrType`, `importErrSize`, `importErrAnimSize`, `importErrDetail`, `importErrFull`, `importErrDuplicate`, `importErrDisk`, `memberOldNoEmotes`, `friendEmotes`, `friendEmotesDesc`, `problemEmoteKeyClash`. The wheel centre labels `PING` / `EMOTE` stay English, like League.

### 10.3 README (both languages)

- **Use:** a row for the emote wheel.
- **Settings:** the Emotes settings.
- **Rooms:** emotes and own images.
- **Known limitations:** "While lolPing is on, Ctrl + drag opens the emote wheel instead of copying files or text. Pick another emote key, or turn it off, in Settings → Emotes."
- **Ping assets:** emotes are © Riot Games too.

## 11. Failure handling

| Situation | Behaviour |
|---|---|
| Bundled emote animation, icon or sound missing | Listed in About → problems like missing ping textures. The emote shows the placeholder. A missing sound just stays silent. |
| Custom still missing at launch | Entry dropped, wheel slots fall back (§7.1). |
| Custom animation missing | Shown as its still. |
| Import fails | Inline error, nothing saved, no half-written files. |
| Helper restarts | Both wheels are dismissed, as today. |
| Emote key clashes after a settings edit by hand | Emote key turned off, problem noted. |
| Malformed, oversize, unrequested or unannounced chunks | Dropped silently. |
| Hash mismatch after assembly | Discarded. The next presence can try again. |
| Cache folder unwritable | Received stills stay unavailable (placeholder). Logged once. |

## 12. Testing

**C++ (`npm run test:helper`):**
- An emote gesture with each trigger kind.
- `wheel` on every point event.
- Both triggers held → pass-through.
- Emote click on and off.
- Esc and right-click cancel an emote gesture.
- `emoteTrigger` None.
- A custom emote key is swallowed.
- Pause stops both wheels.

**TypeScript (vitest):**
- `EmoteRef` validation.
- Settings normalization: the key clash, the custom-key / pause-key clash, unknown custom refs on the wheel, the 24 limit, size limits.
- `parseHelperLine` with and without `wheel`, and the `configCommand` emote fields.
- The helper protocol test in `--simulate` mode covers an emote gesture.
- `roomProtocol`: `emote`, presence `em`, `want`, `chunk`, including size limits and unknown bundled slugs.
- RoomManager: emotes use the same gates and budgets as pings; old-peer detection.
- EmoteTransfer:
  - chunking and reassembly, out of order and duplicates
  - hash mismatch, limits and the 60 s drop
  - re-asks and their limit
  - merged queues
  - LAN rate, and the relay rule that keeps 5 tokens free
  - accepting unrequested chunks only for announced hashes from their announcer
- EmoteCache: LRU by count and by bytes.
- emoteImport: the quality and size stepping (pure function). WebP encoding itself is checked in the running app.

**In the running app** (over CDP, as for earlier features):
- Import a PNG, a GIF and an over-detailed photo.
- Emote wheel on both overlays.
- One-per-person replacement.
- Bundled animations restart from frame 0 on repeat.
- `tools/room-peer --emotes`, over LAN and with `--relay`: bundled emotes, the M1 placeholder, and (M2) a custom still arriving and then showing.

**Baker:** compared by eye against the game during the spike and in the gallery. Re-running the tool on the same League version writes identical files.

## 13. Delivery

**M1 → v0.5.0**
1. Spike: bake one standard emote and one special emote, compare with the game. Go / no-go for the baker.
2. Baker and sound extraction; gallery; the user picks the set, default wheel and centre; `emoteCatalog.ts` and `assets/emotes/` generated.
3. Helper second trigger.
4. Settings fields, IPC, generic `Wheel` and `WheelEditor`, Emotes section.
5. emoteFx and the overlay's second wheel.
6. EmoteLibrary, emoteImport, `lolping://emotes`.
7. Room `emote` messages, placeholder, old-peer note.
8. README and README.zh-CN; version bump. Released together with the update checker.

**M2 → v0.5.1**
1. Presence `em`, `want`, `chunk`, EmoteTransfer, EmoteCache.
2. **Show friends' custom emotes**.
3. `tools/room-peer --emotes` custom-still serving; LAN and relay tests across two machines.

## 14. Out of scope

- Emotes in the browser demo (`site/`).
- League's automatic "Reactions" (start of game, first blood, ace, victory).
- Animated custom images in rooms.
- The full 2,379-emote catalog, or reading emotes from the user's League install at runtime.
- Sounds for custom emotes.
- An emote duration setting.
