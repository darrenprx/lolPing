#!/usr/bin/env python3
"""Re-extracts lolPing's ping sounds (and optionally textures) from a local League of Legends install.

Requirements:
  * Python 3.14+ (uses the built-in compression.zstd module)
  * ffmpeg on PATH
  * vgmstream-cli (https://github.com/vgmstream/vgmstream/releases), passed with --vgmstream
  * Pillow, only for --dds-dir, --wad-textures, --emote-gallery and --emotes; NumPy, only for the last two

Examples:
  py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --vgmstream C:/tools/vgmstream/vgmstream-cli.exe
  py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --wad-textures
  py -3.14 tools/extract-assets/extract_assets.py --dds-dir C:/Users/me/Downloads/need
  py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --emote-gallery --vgmstream C:/tools/vgmstream/vgmstream-cli.exe
  py -3.14 tools/extract-assets/extract_assets.py --league "C:/Riot Games/League of Legends" --emotes --vgmstream C:/tools/vgmstream/vgmstream-cli.exe
"""
import argparse
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

from compression import zstd

REPO = Path(__file__).resolve().parents[2]
SOUND_OUT = REPO / 'assets' / 'sounds'
TEXTURE_OUT = REPO / 'assets' / 'textures'
EMOTE_OUT = REPO / 'assets' / 'emotes'
EMOTE_CATALOG = REPO / 'src' / 'shared' / 'emoteCatalog.ts'
WAD_REL = Path('Game/DATA/FINAL/Maps/Shipping/Common.wad.client')
GLOBAL_WAD_REL = Path('Game/DATA/FINAL/Global.wad.client')
BANK_DIR = 'assets/sounds/wwise2016/sfx/shared/'
EVENTS_BANK = BANK_DIR + 'hud_global_events.bnk'
AUDIO_BANK = BANK_DIR + 'hud_global_audio.bnk'

# output wav name -> Wwise event (see src/shared/pings.ts for which ping uses which file)
SOUNDS = {
    'SRP_12': 'Play_sfx_hud_base_Pings_SRP_12',              # danger
    'SRP_9': 'Play_sfx_hud_base_Pings_SRP_9',                # push
    'OnMyWay': 'Play_sfx_hud_base_Pings_OnMyWay',            # on my way
    'SRP_4': 'Play_sfx_hud_base_Pings_SRP_4',                # all in
    'ComeHere': 'Play_sfx_hud_base_Pings_ComeHere',          # assist me
    'SRP_7': 'Play_sfx_hud_base_Pings_SRP_7',                # need vision
    'MIA': 'Play_sfx_hud_base_Pings_MIA',                    # enemy missing
    'AreaIsWarded': 'Play_sfx_hud_base_Pings_AreaIsWarded',  # enemy vision
    'Base': 'Play_sfx_hud_base_Pings_Base',                  # generic
    'SRP_11': 'Play_sfx_hud_base_Pings_SRP_11',              # bait
    'SRP_6': 'Play_sfx_hud_base_Pings_SRP_6',                # vision cleared
    'button': 'Play_sfx_hud_base_Pings_button',              # wheel tick
}

# The bundled emotes (--emotes), pinned by League id: slug -> id, in the order the app's emote pool lists them. To add one,
# find its id with --emote-gallery, append 'slug': id here (slug: ^[a-z0-9_]{1,40}$, unique) and run --emotes.
EMOTE_SET: dict[str, int] = {
    'facepalm': 4341,
    'unworthy': 3236,
    'unworthy_cn': 3239,
    'poro_snax': 1445,
    'sad_kitten': 1457,
    'cheeky_poro': 1499,
    'angry_kitty': 1501,
    'gg_heart': 3124,
    'bee_happy': 3153,
    'bee_mad': 3154,
    'bee_sad': 3155,
    'snoozy_poro': 3173,
    'wahaha': 3177,
    'omg_love_it': 3207,
    'poro_ride': 3214,
    'dont_make_me_laugh': 3358,
    'woah_dizzy': 4334,
    'haha_hilarious': 4443,
    'gasp': 4670,
    'super_approved': 4860,
    'pain': 4948,
    'laughing_out_loud': 4952,
    'hats_off': 3156,
    'call_me': 3338,
    'think_about_it': 3339,
    'unimpressed': 3414,
    'did_you_just': 3448,
    'nice_try': 1030,
    'nice': 1459,
    'despair': 1467,
    'does_not_compute': 1468,
    'come_at_me': 1480,
    'how_could_you': 1487,
    'scout_approved': 1492,
    'maybe_next_time': 3141,
    'okay': 3159,
    'good_job_buddy': 3166,
    'teamwork': 3167,
    'i_will_destroy_you': 3215,
    'not_today': 3581,
    'oh': 3709,
    'come_again': 3962,
    'magpie_oopsie': 4091,
    'such_foolishness': 4730,
}
# The default emote wheel, top slot then clockwise, and the centre (click) emote.
DEFAULT_EMOTE_WHEEL: list[str] = ['unworthy_cn', 'poro_snax', 'sad_kitten', 'cheeky_poro', 'angry_kitty', 'gg_heart',
                                  'bee_happy', 'bee_mad']
DEFAULT_CLICK_EMOTE = 'facepalm'
# Names for the catalog where the client's are not enough: slug -> (name, nameZh). The client calls both Unworthy emotes
# "Unworthy" / "弱爆", and the app's settings list emotes by name.
NAME_OVERRIDES: dict[str, tuple[str, str]] = {
    'unworthy_cn': ('Unworthy (Chinese text)', '弱爆（文字版）'),
}

# output png name -> League .tex in Global.wad.client (the other textures came from Obsidian DDS exports, see README)
WAD_TEXTURES = {
    'pingwheel_baitrender': 'ASSETS/Shared/Particles/PingUpdate/PingWheel_Bait.tex',
    'vision_cleared': 'ASSETS/Shared/Particles/PingUpdate/Need/Vision_Cleared.tex',
    'pingwheel_visionclearedrender': 'ASSETS/Shared/Particles/PingUpdate/Need/PingWheel_VisionClearedRender.tex',
}

# ---- xxHash64 (WAD path hashes) ----
M64 = (1 << 64) - 1
P1, P2, P3, P4, P5 = 11400714785074694791, 14029467366897019727, 1609587929392839161, 9650029242287828579, 2870177450012600261


def _rotl(x, r):
    return ((x << r) | (x >> (64 - r))) & M64


def _round(acc, inp):
    return (_rotl((acc + inp * P2) & M64, 31) * P1) & M64


def _merge(acc, val):
    return (((acc ^ _round(0, val)) * P1) + P4) & M64


def xxh64(data: bytes, seed: int = 0) -> int:
    n, i = len(data), 0

    def u64(k):
        return int.from_bytes(data[k:k + 8], 'little')

    if n >= 32:
        v1, v2, v3, v4 = (seed + P1 + P2) & M64, (seed + P2) & M64, seed, (seed - P1) & M64
        while i + 32 <= n:
            v1, v2, v3, v4 = _round(v1, u64(i)), _round(v2, u64(i + 8)), _round(v3, u64(i + 16)), _round(v4, u64(i + 24))
            i += 32
        h = (_rotl(v1, 1) + _rotl(v2, 7) + _rotl(v3, 12) + _rotl(v4, 18)) & M64
        for v in (v1, v2, v3, v4):
            h = _merge(h, v)
    else:
        h = (seed + P5) & M64
    h = (h + n) & M64
    while i + 8 <= n:
        h = ((_rotl(h ^ _round(0, u64(i)), 27) * P1) + P4) & M64
        i += 8
    if i + 4 <= n:
        h = ((_rotl(h ^ ((int.from_bytes(data[i:i + 4], 'little') * P1) & M64), 23) * P2) + P3) & M64
        i += 4
    while i < n:
        h = (_rotl(h ^ ((data[i] * P5) & M64), 11) * P1) & M64
        i += 1
    h ^= h >> 33
    h = (h * P2) & M64
    h ^= h >> 29
    h = (h * P3) & M64
    h ^= h >> 32
    return h


# ---- WAD v3 ----
def wad_read(wad: Path, wanted: list[str]) -> dict[str, bytes]:
    by_hash = {xxh64(p.lower().encode()): p for p in wanted}
    out: dict[str, bytes] = {}
    with open(wad, 'rb') as f:
        magic, major, _minor = struct.unpack('<2sBB', f.read(4))
        if magic != b'RW' or major < 3:
            raise SystemExit(f'{wad}: unsupported WAD version {major}')
        f.read(256 + 8)  # signature + checksum
        (count,) = struct.unpack('<I', f.read(4))
        entries = [struct.unpack('<QIIIBBHQ', f.read(32)) for _ in range(count)]
        for path_hash, offset, csize, _size, type_byte, _dup, _first, _checksum in entries:
            if path_hash not in by_hash:
                continue
            f.seek(offset)
            raw = f.read(csize)
            kind = type_byte & 0xF
            if kind == 0:
                data = raw
            elif kind in (3, 4):
                start = raw.find(b'\x28\xb5\x2f\xfd')  # zstd frame magic; type 4 may start with raw bytes
                data = (raw[:start] + zstd.decompress(raw[start:])) if start > 0 else zstd.decompress(raw)
            else:
                raise SystemExit(f'{by_hash[path_hash]}: unsupported WAD entry type {kind}')
            out[by_hash[path_hash]] = data
    missing = sorted(set(wanted) - set(out))
    if missing:
        raise SystemExit(f'not found in {wad.name}: {missing}')
    return out


# ---- Wwise banks ----
def fnv1_32(s: str) -> int:
    h = 2166136261
    for c in s.lower().encode():
        h = ((h * 16777619) & 0xFFFFFFFF) ^ c
    return h


def bnk_sections(data: bytes):
    i = 0
    while i + 8 <= len(data):
        tag, n = struct.unpack_from('<4sI', data, i)
        yield tag, data[i + 8:i + 8 + n]
        i += 8 + n


def parse_hirc(data: bytes) -> dict[int, tuple[int, bytes]]:
    objs: dict[int, tuple[int, bytes]] = {}
    for tag, body in bnk_sections(data):
        if tag != b'HIRC':
            continue
        (n,) = struct.unpack_from('<I', body)
        j = 4
        for _ in range(n):
            obj_type, size, oid = struct.unpack_from('<BII', body, j)
            objs[oid] = (obj_type, body[j + 9:j + 5 + size])
            j += 5 + size
    return objs


def parse_media(data: bytes) -> dict[int, bytes]:
    index: list[tuple[int, int, int]] = []
    blob = b''
    for tag, body in bnk_sections(data):
        if tag == b'DIDX':
            index = [struct.unpack_from('<III', body, k) for k in range(0, len(body), 12)]
        elif tag == b'DATA':
            blob = body
    return {wid: blob[off:off + size] for wid, off, size in index}


SOUND_OBJ, ACTION, EVENT, RANSEQ, SWITCH, ACTOR_MIXER, LAYER, AUDIO_DEVICE = 2, 3, 4, 5, 6, 7, 9, 14


def event_media(objs: dict[int, tuple[int, bytes]], event_name: str) -> list[int]:
    """Walks event -> action -> containers -> sounds. Returns embedded media ids, one per layer."""

    def ids_in(body: bytes) -> set[int]:
        return {struct.unpack_from('<I', body, k)[0] for k in range(len(body) - 3)}

    def walk(oid: int, seen: set[int]) -> list[int]:
        if oid in seen or oid not in objs:
            return []
        seen.add(oid)
        obj_type, body = objs[oid]
        if obj_type == SOUND_OBJ:
            return [struct.unpack_from('<I', body, 5)[0]]  # pluginId u32, streamType u8, sourceId u32
        if obj_type == ACTION:
            return walk(struct.unpack_from('<I', body, 2)[0], seen)  # actionType u16, target u32
        if obj_type in (EVENT, RANSEQ, SWITCH, LAYER):
            found: list[int] = []
            for ref in sorted(ids_in(body)):
                if ref in objs and objs[ref][0] not in (ACTOR_MIXER, AUDIO_DEVICE):
                    found += walk(ref, seen)
            return found
        return []

    eid = fnv1_32(event_name)
    if eid not in objs:
        raise SystemExit(f'event {event_name} not found in {EVENTS_BANK}')
    return list(dict.fromkeys(walk(eid, set())))


def decode_and_mix(media: dict[int, bytes], ids: list[int], out: Path, vgmstream: str, tmp: Path) -> None:
    wavs = []
    for wid in ids:
        if wid not in media:
            raise SystemExit(f'media {wid} is not embedded in {AUDIO_BANK}')
        wem, wav = tmp / f'{wid}.wem', tmp / f'{wid}.wav'
        wem.write_bytes(media[wid])
        subprocess.run([vgmstream, '-o', str(wav), str(wem)], check=True, capture_output=True)
        wavs.append(wav)
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
    for w in wavs:
        cmd += ['-i', str(w)]
    if len(wavs) > 1:  # layer containers play their children together; limit to avoid clipping
        cmd += ['-filter_complex', f'amix=inputs={len(wavs)}:normalize=0:duration=longest,alimiter=limit=0.89:level=false']
    cmd.append(str(out))
    subprocess.run(cmd, check=True)


def convert_textures(dds_dir: Path) -> None:
    from PIL import Image

    TEXTURE_OUT.mkdir(parents=True, exist_ok=True)
    for dds in sorted(dds_dir.glob('*.dds')):
        Image.open(dds).convert('RGBA').save(TEXTURE_OUT / f'{dds.stem}.png')
        print('texture', dds.stem)


def tex_to_png(data: bytes, out: Path | None = None):
    """League TEX (DXT1 or DXT5, mipmaps stored smallest first) -> RGBA PIL image, also saved as PNG when out is given.
    Decodes by wrapping the full-size level in a DDS header."""
    import io
    from PIL import Image

    magic, w, h, _unk, fmt, _res, _flags = struct.unpack_from('<4sHHBBBB', data)
    if magic != b'TEX\0' or fmt not in (10, 12):
        name = out.name if out else 'TEX'
        raise SystemExit(f'{name}: unsupported TEX (magic {magic!r}, format {fmt}); only DXT1 and DXT5 are handled')
    size = max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * (8 if fmt == 10 else 16)
    fourcc = b'DXT1' if fmt == 10 else b'DXT5'
    dds = (b'DDS ' + struct.pack('<7I', 124, 0x81007, h, w, size, 0, 1) + b'\0' * 44
           + struct.pack('<II4s5I', 32, 4, fourcc, 0, 0, 0, 0, 0) + struct.pack('<5I', 0x1000, 0, 0, 0, 0))
    img = Image.open(io.BytesIO(dds + data[-size:])).convert('RGBA')
    if out is not None:
        img.save(out)
    return img


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--league', type=Path, help='League of Legends install folder (the one containing Game/)')
    ap.add_argument('--vgmstream', default='vgmstream-cli', help='path to vgmstream-cli.exe')
    ap.add_argument('--dds-dir', type=Path, help='folder of .dds textures to convert to PNG')
    ap.add_argument('--wad-textures', action='store_true', help='with --league: extract only the WAD_TEXTURES, no sounds')
    ap.add_argument('--emote-gallery', action='store_true',
                    help='with --league: list every emote in <temp>/lolping-emote-gallery/gallery.html (EMOTE_SET '
                         'pre-ticked; candidates baked with their sounds), no ping sounds')
    ap.add_argument('--emotes', action='store_true',
                    help='with --league: bake EMOTE_SET into assets/emotes/ and generate src/shared/emoteCatalog.ts, '
                         'no ping sounds')
    ap.add_argument('--glow-opacity', type=float,
                    help='with --emotes: draw the emote halos at this opacity instead of emote_bake.GLOW_OPACITY')
    args = ap.parse_args()
    if not args.league and not args.dds_dir:
        ap.error('pass --league and/or --dds-dir')
    if args.wad_textures and not args.league:
        ap.error('--wad-textures needs --league')
    if (args.emote_gallery or args.emotes) and not args.league:
        ap.error('--emote-gallery and --emotes need --league')
    if args.dds_dir:
        convert_textures(args.dds_dir)
    if args.emote_gallery:
        import emote_bake

        sys.stdout.reconfigure(encoding='utf-8')
        out = Path(tempfile.gettempdir()) / 'lolping-emote-gallery'
        preset = {'set': EMOTE_SET, 'wheel': DEFAULT_EMOTE_WHEEL, 'click': DEFAULT_CLICK_EMOTE}
        print('gallery:', emote_bake.build_gallery(args.league, out, args.vgmstream, preset=preset))
        print(f'view it with: py -3.14 -m http.server 8766 --directory "{out}"')
    elif args.emotes:
        import emote_bake

        sys.stdout.reconfigure(encoding='utf-8')
        emote_bake.write_emotes(args.league, args.vgmstream, EMOTE_SET, DEFAULT_EMOTE_WHEEL, DEFAULT_CLICK_EMOTE,
                                EMOTE_OUT, EMOTE_CATALOG, NAME_OVERRIDES, args.glow_opacity)
    elif args.wad_textures:
        files = wad_read(args.league / GLOBAL_WAD_REL, list(WAD_TEXTURES.values()))
        TEXTURE_OUT.mkdir(parents=True, exist_ok=True)
        for name, path in WAD_TEXTURES.items():
            tex_to_png(files[path], TEXTURE_OUT / f'{name}.png')
            print('texture', name)
    elif args.league:
        if shutil.which('ffmpeg') is None:
            raise SystemExit('ffmpeg not found on PATH')
        files = wad_read(args.league / WAD_REL, [EVENTS_BANK, AUDIO_BANK])
        objs, media = parse_hirc(files[EVENTS_BANK]), parse_media(files[AUDIO_BANK])
        SOUND_OUT.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as td:
            for name, event in SOUNDS.items():
                ids = event_media(objs, event)
                decode_and_mix(media, ids, SOUND_OUT / f'{name}.wav', args.vgmstream, Path(td))
                print(f'sound {name:<13} {event} ({len(ids)} layer{"s" if len(ids) != 1 else ""})')


if __name__ == '__main__':
    main()
