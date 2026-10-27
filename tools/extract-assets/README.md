# Asset extraction

`assets/sounds`, `assets/textures`, `assets/emotes` and `assets/ui` were extracted from a local League of Legends install. This tool regenerates them after a League patch changes the pings or emotes.

## Sounds

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --vgmstream path/to/vgmstream-cli.exe
```

1. Reads `Game/DATA/FINAL/Maps/Shipping/Common.wad.client` (WAD v3; zstd entries; paths hashed with xxHash64).
2. Pulls `hud_global_events.bnk` (event graph) and `hud_global_audio.bnk` (embedded WEM media).
3. Follows each `Play_sfx_hud_base_Pings_*` event (FNV-1 32-bit id of the lower-cased name) → action → layer container → sounds.
4. Decodes Wwise Vorbis with vgmstream, then mixes multi-layer events with ffmpeg (`amix` + `alimiter` at −1 dB).
5. Stores the resulting 16-bit PCM losslessly in `assets/sounds/<name>.flac`, preserving channels, sample rate and duration.
   FLAC compression level 12 changes encoding effort. Metadata padding is omitted. Web Audio decodes each sound before playback.

To compare the committed FLAC files against the original WAV assets through Electron's Web Audio decoder, run:

```sh
node tools/performance/audio-assets.mjs f24a51e5a11c2b31dab72d89a571cc4025ad3c98
```

The scenario reads the original WAV bytes from Git and checks every decoded sample at 44.1 kHz and 48 kHz,
including channels, length and sample rate. It reports encoded bytes and six alternating decode-time samples for each
format, then removes its temporary data. It uses the installed Electron binary; ffmpeg and a League install are needed
for extraction only. A different comparison revision must contain the original WAV files.

## Textures

Most textures were exported as DDS (DXT5) with Obsidian. To convert a folder of them:

```bash
py -3.14 tools/extract-assets/extract_assets.py --dds-dir path/to/dds
```

Bait, Vision Cleared, On My Way and the normal-colour icons for All In, Assist Me, Need Vision and Enemy Missing are read straight from League's `.tex` files in `Global.wad.client` (see `WAD_TEXTURES` in the script). This needs Pillow installed for Python 3.14:

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --wad-textures
```

`enemy_missing_flipped.png` is not a League file: it is `png_enemymissing_128x128.png` turned 180° for the upside-down Enemy Missing ping. `--dds-dir` makes it again; on its own:

```bash
py -3.14 tools/extract-assets/extract_assets.py --derived
```

`omw_cyan.png` is made the same way: League's upright On My Way (`omw.png`) is colourblind blue, and its only normal-colour one is the flat ground render `pingwheel_omw.png`. `--derived` measures the hue, saturation and brightness change between `pingwheel_omw_cb.png` and `pingwheel_omw.png` and applies it to `omw.png`. This step also needs NumPy.

No game file says which sound those two pings play: `SRP_11` (Bait) and `SRP_6` (Vision Cleared) were identified by listening. `SRP_13` is the structure-defend ping.

Never reference the colourblind files in the app: the `*_cb*` ones, and the 128 px icons from `PingUpdate/Need/` (lime, lemon, blue and pink where the normal set is teal, gold, cyan and red).

## Room UI art

`assets/ui` holds the art the room panel, the vote widgets and the text box are drawn with. `UI_ART` in the script lists each file: where it comes from and, for an atlas, the box cut out of it. Needs Pillow.

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --ui
```

- In-game, from `Game/DATA/FINAL/UI.wad.client`: the surrender widget (`SurrenderAtlas.tex`), the Tab scoreboard (`ScoreboardAtlas.tex`), the options window and its buttons (`OptionsMenuAtlas.tex`). League's fonts are not taken: they are licensed from a type foundry.
- Client, from the plugin WADs: the Summoner's Rift scene and map icon (`rcp-be-lol-game-data`), and from `rcp-fe-lol-static-assets` and `rcp-fe-lol-navigation` the ready check frame and mask, the Accept button art, the four timer videos and three sounds (match found, countdown, accepted loop) that the client's ready check plays.

The crop boxes were measured from the decoded atlases. After a patch that moves things in an atlas, decode it again and check each piece.

## Emotes

`assets/emotes/` and `src/shared/emoteCatalog.ts` are generated from League's summoner-emote effect files by `emote_bake.py`. Each emote is baked into a 320×320 animated WebP (3 s, 30 fps, played once) that matches the in-game animation.

### Setup

The emote modes need Pillow and NumPy for Python 3.14, plus ffmpeg on PATH and vgmstream-cli:

```bash
py -3.14 -m pip install pillow numpy
```

`tools/extract-assets/.cache/` (git-ignored) holds these downloads:

| File | Source | Used for |
|---|---|---|
| `hashes.binfields.txt`, `hashes.bintypes.txt`, `hashes.binentries.txt` | `https://raw.githubusercontent.com/CommunityDragon/Data/master/hashes/lol/` | Field names in effect files. Without them, skipped fields show as hashes and most emotes read as "not faithful". |
| `summoner-emotes.zh_cn.json` | `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/summoner-emotes.json` | Chinese names (`nameZh`). Download it by hand: `--emotes` stops without it, and the gallery then shows English names with a warning |
| `vgmstream/` | vgmstream release zip (r2117) | Decoding Wwise audio; pass `--vgmstream .cache/vgmstream/vgmstream-cli.exe` |

The English emote list (`summoner-emotes.json`) is read from the client's `default-assets.wad` and cached in `.cache/`. It is read again whenever `default-assets.wad` changes size or modification time (after a client patch), so a stale list is never reused.

### `--emote-gallery`: browse and pick

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --emote-gallery --vgmstream tools/extract-assets/.cache/vgmstream/vgmstream-cli.exe
py -3.14 -m http.server 8766 --directory "%TEMP%/lolping-emote-gallery"
```

This writes `gallery.html` into `%TEMP%/lolping-emote-gallery/` (about 10 minutes). Serve that folder and open `http://localhost:8766/gallery.html`.

- The page lists every emote that has an effect, about 2,400 of them.
- The `EMOTE_SET` emotes come first, already ticked, along with the default wheel and centre.
- Baked emotes play their animation and sound. The rest show their still icon.
- Esports emotes are hidden until "Show esports emotes" is ticked.
- Badges mark "not faithful" emotes (the baker skips something that changes their look), special or animated effects, and emotes that only have a family sound.
- "Copy selection" gives `pick: <ids> | wheel: <ids> | centre: <id>`.

### `--emotes`: the bundled set

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --emotes --vgmstream tools/extract-assets/.cache/vgmstream/vgmstream-cli.exe
```

`EMOTE_SET` in `extract_assets.py` pins the selection by League id (slug → id, in pool order). `DEFAULT_EMOTE_WHEEL` (8 slugs, top then clockwise) and `DEFAULT_CLICK_EMOTE` set the defaults.

For every entry, `--emotes` writes:

- **`assets/emotes/<slug>.webp`:** the bake, with lossy alpha at `WEBP_ALPHA_QUALITY` (90, in `emote_bake.py`; it also sets the galleries' alpha).
- **Edge feather:** every frame's alpha fades to 0 over the outer `EDGE_FEATHER_PX` (40) px of the canvas, so glows and light rays fade out instead of being cut off.
- **`assets/emotes/<slug>.png`:** the emote's `_selector` icon.
- **`assets/emotes/<slug>.ogg`:** the emote's sound, mixed like the ping sounds and encoded with `ffmpeg -c:a libopus -b:a 96k`. The sound is chosen in this order:
  1. The event its effect names (`soundOnCreateDefault`).
  2. A bank event named after it, for example `Play_sfx_Emotes_<id>` or `Play_sfx_Emotes_Gasp` for the particle `EM_Gasp`.
  3. Only when it has no sound of its own, its family template's `Play_sfx_Goodies_Emotes_Template_<Family>`, which the game plays for every emote.

  Voice lines come from the `EMOTE_VO_LOCALE` (`en_US`) banks. If an own sound can't be used (its event is in no bank, for example because that voice WAD is missing, or its media is missing or won't decode), the run prints a `WARNING` and the emote takes its family sound instead. With no sound at all, there is no `.ogg` and the emote gets `hasSound: false`.

`--glow-opacity <n>` draws the halos behind the emotes at that opacity instead of `GLOW_OPACITY`.

It then deletes every other file in `assets/emotes/` and generates `src/shared/emoteCatalog.ts`. `NAME_OVERRIDES` in `extract_assets.py` (slug → name, nameZh) replaces a catalog name where the client's is not enough; the two Unworthy emotes need it, and the run refuses two emotes with the same name. The output is deterministic: running it again on the same League version writes byte-identical files.

### Adding an emote later

1. Run `--emote-gallery` and find the emote (search by English or Chinese name). Note its League id.
2. Append `'slug': id,` to `EMOTE_SET` in `extract_assets.py`. The slug must match `^[a-z0-9_]{1,40}$` and be unique; the position in the dict is its position in the pool.
3. Run `--emotes`, check the new files in `assets/emotes/`, and commit them with `src/shared/emoteCatalog.ts`.

### Developer commands

`emote_bake.py` also has these commands (`--league` is required for all of them):

| Command | What it does |
|---|---|
| `dump --emote <id>` | Prints an emote's effect file and linked templates as JSON |
| `specials` | Lists effects outside the three template families |
| `sounds` | Scans the banks for emote events |
| `bake --emote <id> ...` | Bakes just those emotes into a gallery |

The renderer's assumptions and constants are listed at the top of `emote_bake.py`. One example is `GLOW_OPACITY`, which draws the halo behind an emote at a tenth of its data opacity.
