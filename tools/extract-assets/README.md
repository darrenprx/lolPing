# Asset extraction

`assets/sounds`, `assets/textures` and `assets/emotes` were extracted from a local League of Legends install. This tool regenerates them after a League patch changes the pings or emotes.

## Sounds

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --vgmstream path/to/vgmstream-cli.exe
```

1. Reads `Game/DATA/FINAL/Maps/Shipping/Common.wad.client` (WAD v3; zstd entries; paths hashed with xxHash64).
2. Pulls `hud_global_events.bnk` (event graph) and `hud_global_audio.bnk` (embedded WEM media).
3. Follows each `Play_sfx_hud_base_Pings_*` event (FNV-1 32-bit id of the lower-cased name) → action → layer container → sounds.
4. Decodes Wwise Vorbis with vgmstream, then mixes multi-layer events with ffmpeg (`amix` + `alimiter` at −1 dB).

## Textures

Most textures were exported as DDS (DXT5) with Obsidian. To convert a folder of them:

```bash
py -3.14 tools/extract-assets/extract_assets.py --dds-dir path/to/dds
```

Bait and Vision Cleared are read straight from League's `.tex` files in `Global.wad.client` (see `WAD_TEXTURES` in the script). This needs Pillow installed for Python 3.14:

```bash
py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --wad-textures
```

No game file says which sound those two pings play: `SRP_11` (Bait) and `SRP_6` (Vision Cleared) were identified by listening. `SRP_13` is the structure-defend ping.

Never reference the colourblind (`*_cb*`) files in the app.

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
