#!/usr/bin/env python3
"""Reads League of Legends summoner-emote effect files and bakes emotes into animated WebP (+ sound).

Requirements: Python 3.14+, Pillow, NumPy; for sounds also ffmpeg on PATH and vgmstream-cli.

Commands (the candidate gallery itself is extract_assets.py --emote-gallery):
  py -3.14 tools/extract-assets/emote_bake.py dump --league "C:/Riot Games/League of Legends" --emote 4341
  py -3.14 tools/extract-assets/emote_bake.py specials --league "C:/Riot Games/League of Legends"
  py -3.14 tools/extract-assets/emote_bake.py sounds --league "C:/Riot Games/League of Legends"
  py -3.14 tools/extract-assets/emote_bake.py bake --league "C:/Riot Games/League of Legends" --emote 4341 --emote 3236 \
      --out %TEMP%/lolping-emote-bake --vgmstream tools/extract-assets/.cache/vgmstream/vgmstream-cli.exe
  (bake writes a gallery.html of just those emotes; serve the folder over HTTP to view it; --glow-opacity 0.3 draws
  the halos at that opacity instead of GLOW_OPACITY)

Effect file format (PROP v3 bin, see read_bin): one VfxSystemDefinitionData per emote with ~6 emitters
(VfxEmitterDefinitionData in complexEmitterDefinitionData). The standard layout is IntroAdd (additive flash), IntroAlpha
or Intro (eroding reveal), Mid (the still), outro (eroding exit), MidGlow (the _Glow.tex behind) and Parent: an invisible
particle (birthColor alpha 0) whose childParticleSetDefinition spawns a "family" template system from the linked
Loadouts/SummonerEmotes.<hash>.bin (light rays, sparkles, rings, spin; e.g. EM_Template_SadBored_child_01). Values are
Value* objects: constantValue, or dynamics {times, values} keyed on normalised age, optionally multiplied per component by
a random draw through probabilityTables {keyTimes, keyValues}. Birth values are evaluated at the emitter's age when the
particle is born, over-life values at the particle's normalised age; the result is birth value x over-life value.

Fields the renderer uses (VfxEmitterDefinitionData unless noted):
  emission   disabled, timeBeforeFirstEmission, lifetime, rate, isSingleParticle, particleLifetime, particleLinger,
             childParticleSetDefinition.childrenIdentifiers[].effect (child system, placed at the parent particle;
             the child's own transform is ignored, its emission stops when the parent particle dies)
  position   EmitterPosition, SpawnShape (VfxShapeLegacy emitOffset / emitRotationAngles / emitRotationAxes, the
             unnamed 0xee39916f shape's emitOffset, VfxShapeSphere/Box/Cylinder approximately), birthVelocity (rotated
             with the legacy shape), velocity (over life, added), birthDrag, worldAcceleration, birthAcceleration
  size       birthScale0 x scale0, isUniformScale; billboard quads are 2*scale wide (scale = half extent)
  rotation   birthRotation0 + ROTATION0_SCALE * integral(rotation0 over seconds) + birthRotationalVelocity0 * age;
             the x component is the in-plane roll of a billboard; isRotationEnabled is implied
  colour     birthColor x Color (RGBA), blendMode (1 alpha, 4 additive), alphaRef, pass (draw order); the MidGlow
             halo's alpha is further scaled by GLOW_OPACITY
  texture    texture, texDiv + numFrames + isRandomStartFrame + startFrame + frameRate (atlas frames)
  erosion    alphaErosionDefinition: erosionDriveCurve (over life), erosionFeatherIn (or Out), erosionMapName,
             erosionMapChannelMixer (default: alpha); alpha *= smoothstep(0, f, map - (drive*(1+f) - f))
  primitive  none (camera-facing billboard) and VfxPrimitiveRay (see Baker._ray_quad); other primitives are skipped
System: complexEmitterDefinitionData, soundOnCreateDefault of the root system (the emote's own sound; the family
template system's Play_sfx_Goodies_Emotes_Template_* is not played).

Assumptions checked against the game at the spike gate (constants below): orthographic camera facing the emote (world
Y = screen up, depth dropped, no League camera tilt), PX_PER_UNIT, ROTATION0_SCALE (empirical: makes the 147 "spin"
intros, which are born at 180 degrees, land upright when Mid takes over, and keeps MidGlow's wobble in step with
IntroAlpha's), the erosion formula, the ray orientation and length, that a child system ignores its own transform
(0, 80, 0) while the root system's transform applies (relative to EMOTE_CENTRE_Y), and GLOW_OPACITY (the one correction
the gate asked for).
Every frame's alpha is feathered to 0 over EDGE_FEATHER_PX at the canvas border, so glows fade out instead of being cut off.
Skipped (reported per emote by render() and audit()): uvMode (unknown), erosionSliceWidth (always >= 1 on emotes), and every field not
listed above or in NO_VISIBLE_EFFECT. unfaithful() keeps the skips that may change the look.
"""
import argparse
import hashlib
import html
import json
import math
import os
import random
import re
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_assets import GLOBAL_WAD_REL, WAD_REL, fnv1_32, parse_hirc, parse_media, event_media, tex_to_png, wad_read, xxh64  # noqa: E402

CACHE = Path(__file__).resolve().parent / '.cache'
CLIENT_WAD_REL = Path('Plugins/rcp-be-lol-game-data/default-assets.wad')
EMOTES_JSON = 'plugins/rcp-be-lol-game-data/global/default/v1/summoner-emotes.json'
ZH_NAMES_FILE = 'summoner-emotes.zh_cn.json'
ZH_NAMES_URL = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/zh_cn/v1/summoner-emotes.json'

# Emote sounds live in Common.wad.client (Maps/Shipping); the media is streamed from the .wpk.
EMOTE_BANKS = [('assets/sounds/wwise2016/sfx/shared/misc_emotes_sfx_events.bnk',
                'assets/sounds/wwise2016/sfx/shared/misc_emotes_sfx_audio.bnk',
                'assets/sounds/wwise2016/sfx/shared/misc_emotes_sfx_audio.wpk'),
               ('assets/sounds/wwise2016/sfx/shared/misc_emotes_ew_sfx_events.bnk',
                'assets/sounds/wwise2016/sfx/shared/misc_emotes_ew_sfx_audio.bnk',
                'assets/sounds/wwise2016/sfx/shared/misc_emotes_ew_sfx_audio.wpk')]
# A few emotes speak (Play_vo_Emotes_*, e.g. Rammus's "Okay"): those banks are per language, in Common.<locale>.wad.client.
# The locale is fixed so that every install regenerates the same files; without it those emotes fall back as below.
EMOTE_VO_LOCALE = 'en_US'
EMOTE_VO_BANKS = [tuple(f'assets/sounds/wwise2016/vo/{EMOTE_VO_LOCALE.lower()}/shared/misc_emotes_vo_{n}'
                        for n in ('events.bnk', 'audio.bnk', 'audio.wpk'))]
# An emote plays its own sound (choose_sound). Only when it has none does it fall back to its family template's
# Play_sfx_Goodies_Emotes_Template_<Family> event, which the game plays for every emote alongside its own; no single shared
# emote sound exists.
DEFAULT_EMOTE_SOUND = None

# Effects outside these shared-texture combos are the "specials" (spec 5.1).
FAMILIES = {
    'standard': frozenset({'em_template_erode_bubbles_01.tex', 'em_template_z_erosion_01.tex'}),
    'anger-confused-a': frozenset({'em_template_erode_bubbles_01.tex', 'em_template_z_erosion_01.tex',
                                   'em_template_erode_angerconfused_02.tex', 'em_template_erode_angerconfused_03.tex'}),
    'anger-confused-b': frozenset({'em_template_erode_bubbles_01.tex', 'em_template_z_erosion_01.tex',
                                   'em_template_erode_angerconfused_01.tex', 'em_template_erode_angerconfused_02.tex'}),
}

FPS, DURATION, CANVAS = 30, 3.0, 320
SUBSTEPS = 4                       # simulation steps per frame
PX_PER_UNIT = CANVAS * 0.6 / 140   # a standard emote (birthScale0 70, i.e. 140 units wide) fills 60% of the canvas
ROTATION0_SCALE = 20.0             # rotation0 rate units -> degrees per second (empirical, see docstring)
# The canvas centre is this far above the effect's anchor: the root system's transform y in 1,732 of 2,402 emote
# effects (609 use 80; the 45 Worlds 2017 emotes use -215 and place Mid at +300, i.e. at 85 too). See root_origin.
EMOTE_CENTRE_Y = 85.0
# The MidGlow halo (the emote's <name>_Glow.tex: a flat colour, alpha = its silhouette plus a soft disc) is drawn at this
# fraction of the opacity the data gives it. The gallery review found its size right but the halo too opaque, and the data
# offers no cause: every MidGlow's Color peaks at alpha 1 (2,310 of 2,310), none but 2 has a birthColor, it blends like
# Mid (blendMode 1 in 2,307), and alpha blending never takes the "brightest channel" path used for additive light.
# Not derived from the data; chosen by eye in the gallery review (0.5 first, then 0.1).
GLOW_OPACITY = 0.1
WEBP_QUALITY = 80
# Lossy-alpha quality (100 is lossless) of every WebP written: the bundled emotes (--emotes), the galleries and their posters.
# Lower is smaller but bands the soft haze (50 did, clearest on a light tile); 90 was chosen in a side-by-side review.
WEBP_ALPHA_QUALITY = 90
EDGE_FEATHER_PX = 40               # alpha fades (smoothstep) from 0 at the canvas edge to 1 this many px in, so glows aren't cut off
POSTER_TIME = 1.2                  # the still for galleries: the standard layout holds Mid from ~0.6 s to ~2 s


# ---- names ----
def fnv1a32(name: str) -> int:
    h = 0x811C9DC5
    for c in name.lower().encode():
        h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
    return h


def load_names(cache: Path, files=('hashes.binfields.txt', 'hashes.bintypes.txt', 'hashes.binentries.txt')) -> dict[int, str]:
    names: dict[int, str] = {}
    for f in files:
        p = cache / f
        if not p.exists():
            continue
        with open(p, encoding='utf-8') as fh:
            for line in fh:
                h, _, name = line.rstrip('\n').partition(' ')
                if name:
                    names[int(h, 16)] = name
    return names


# ---- bin (PROP v3) ----
NONE, BOOL, I8, U8, I16, U16, I32, U32, I64, U64, F32, VEC2, VEC3, VEC4, MTX44, RGBA, STRING, HASH, FILE = range(19)
LIST, LIST2, POINTER, EMBED, LINK, OPTION, MAP, FLAG = range(0x80, 0x88)
_PRIM = {BOOL: '<?', I8: '<b', U8: '<B', I16: '<h', U16: '<H', I32: '<i', U32: '<I', I64: '<q', U64: '<Q', F32: '<f',
         VEC2: '<2f', VEC3: '<3f', VEC4: '<4f', MTX44: '<16f', RGBA: '<4B', HASH: '<I', FILE: '<Q', LINK: '<I', FLAG: '<B'}


@dataclass
class BinObj:
    cls: int                                                 # class (type) hash
    fields: dict[int, object] = field(default_factory=dict)  # field-name hash -> value

    def get(self, name: str, default=None):
        return self.fields.get(fnv1a32(name), default)


@dataclass
class BinFile:
    linked: list[str]
    entries: dict[int, BinObj]                               # entry path hash -> object
    strings: list[str] = field(default_factory=list)         # every string value, in file order


class _Reader:
    def __init__(self, data: bytes):
        self.d, self.p = data, 0

    def u(self, fmt: str):
        v = struct.unpack_from(fmt, self.d, self.p)
        self.p += struct.calcsize(fmt)
        return v[0] if len(v) == 1 else v

    def string(self) -> str:
        n = self.u('<H')
        s = self.d[self.p:self.p + n].decode('utf-8', 'replace')
        self.p += n
        return s

    def value(self, t: int, strings: list[str]):
        if t in _PRIM:
            v = self.u(_PRIM[t])
            return bool(v) if t in (BOOL, FLAG) else v
        if t == NONE:
            return None
        if t == STRING:
            s = self.string()
            strings.append(s)
            return s
        if t in (LIST, LIST2):
            et = self.u('<B')
            self.p += 4                                      # byte size
            return [self.value(et, strings) for _ in range(self.u('<I'))]
        if t in (POINTER, EMBED):
            cls = self.u('<I')
            if cls == 0:
                return None
            self.p += 4                                      # byte size
            return BinObj(cls, self.fields(self.u('<H'), strings))
        if t == OPTION:
            et, count = self.u('<B'), self.u('<B')
            return self.value(et, strings) if count else None
        if t == MAP:
            kt, vt = self.u('<B'), self.u('<B')
            self.p += 4                                      # byte size
            count = self.u('<I')
            out = {}
            for _ in range(count):
                k = self.value(kt, strings)
                out[k] = self.value(vt, strings)
            return out
        raise ValueError(f'unknown bin type {t:#x} at {self.p}')

    def fields(self, count: int, strings: list[str]) -> dict[int, object]:
        out = {}
        for _ in range(count):
            name, t = self.u('<I'), self.u('<B')
            out[name] = self.value(t, strings)
        return out


def read_bin(data: bytes) -> BinFile:
    """PROP (or PTCH + PROP) version 2/3: linked files, entry types, then entries of typed fields."""
    r = _Reader(data)
    magic = data[:4]
    if magic == b'PTCH':
        r.p = 12                                             # 'PTCH' + u64, then 'PROP'
        magic = data[12:16]
    if magic != b'PROP':
        raise ValueError(f'not a PROP bin ({magic!r})')
    r.p += 4
    version = r.u('<I')
    if version < 2:
        raise ValueError(f'unsupported bin version {version}')
    linked = [r.string() for _ in range(r.u('<I'))]
    types = [r.u('<I') for _ in range(r.u('<I'))]
    entries: dict[int, BinObj] = {}
    strings: list[str] = []
    for cls in types:
        size = r.u('<I')
        end = r.p + size
        key, nfields = r.u('<I'), r.u('<H')
        entries[key] = BinObj(cls, r.fields(nfields, strings))
        r.p = end
    return BinFile(linked, entries, strings)


def to_json(v, names: dict[int, str]):
    """Bin values -> JSON-able data with hash names resolved where known."""
    def nm(h: int) -> str:
        return names.get(h, f'{h:#010x}')

    if isinstance(v, BinObj):
        return {'__class': nm(v.cls), **{nm(k): to_json(x, names) for k, x in v.fields.items()}}
    if isinstance(v, list):
        return [to_json(x, names) for x in v]
    if isinstance(v, tuple):
        return [round(x, 4) if isinstance(x, float) else x for x in v]
    if isinstance(v, dict):
        return {str(nm(k) if isinstance(k, int) else k): to_json(x, names) for k, x in v.items()}
    if isinstance(v, float):
        return round(v, 4)
    return v


def bin_json(b: BinFile, names: dict[int, str]) -> dict:
    return {'linked': b.linked, 'entries': {names.get(k, f'{k:#010x}'): to_json(o, names) for k, o in b.entries.items()}}


# ---- WAD access ----
def wad_scan(wad: Path, keep, max_size: int = 1 << 20) -> dict[int, bytes]:
    """Reads every entry (up to max_size) whose decompressed bytes satisfy keep(data). Returns path hash -> data."""
    from compression import zstd

    out: dict[int, bytes] = {}
    with open(wad, 'rb') as f:
        f.read(4 + 264)
        (count,) = struct.unpack('<I', f.read(4))
        entries = [struct.unpack('<QIIIBBHQ', f.read(32)) for _ in range(count)]
        for path_hash, offset, csize, size, type_byte, _dup, _first, _checksum in entries:
            kind = type_byte & 0xF
            if size > max_size or kind not in (0, 3, 4):
                continue
            f.seek(offset)
            raw = f.read(csize)
            if kind == 0:
                data = raw
            else:
                start = raw.find(b'\x28\xb5\x2f\xfd')
                data = (raw[:start] + zstd.decompress(raw[start:])) if start > 0 else zstd.decompress(raw)
            if keep(data):
                out[path_hash] = data
    return out


def wad_read_some(wad: Path, wanted: list[str]) -> dict[str, bytes]:
    """Like wad_read, but missing entries are left out instead of being fatal."""
    with open(wad, 'rb') as f:
        f.read(4 + 264)
        (count,) = struct.unpack('<I', f.read(4))
        present = {struct.unpack('<QIIIBBHQ', f.read(32))[0] for _ in range(count)}
    have = [p for p in dict.fromkeys(wanted) if xxh64(p.lower().encode()) in present]
    return wad_read(wad, have) if have else {}


_effect_bins: dict[int, bytes] | None = None


def effect_bins(global_wad: Path) -> dict[int, bytes]:
    """All emote effect bins in Global.wad.client (scanned once per run, ~12 s)."""
    global _effect_bins
    if _effect_bins is None:
        _effect_bins = wad_scan(global_wad, lambda d: d[:4] in (b'PROP', b'PTCH') and b'SummonerEmotes/Particles' in d)
    return _effect_bins


def _norm(name: str) -> str:
    return ''.join(c for c in name.lower() if c.isalnum())


_vfx_index: tuple[dict, dict] | None = None


def _effect_index(global_wad: Path) -> tuple[dict[str, list[BinFile]], dict[str, list[BinFile]]]:
    """Effect bins by every *_vfx.tex / *_glow.tex path they name (lower case), and by '<normalised stem>_vfx|_glow'."""
    global _vfx_index
    if _vfx_index is None:
        by_path: dict[str, list[BinFile]] = {}
        by_stem: dict[str, list[BinFile]] = {}
        for d in sorted(effect_bins(global_wad).values(), key=len):
            b = read_bin(d)
            for s in {s.lower() for s in b.strings}:
                for suffix in ('_vfx.tex', '_glow.tex'):
                    if s.endswith(suffix):
                        by_path.setdefault(s, []).append(b)
                        by_stem.setdefault(_norm(s.rsplit('/', 1)[-1].removesuffix(suffix)) + suffix, []).append(b)
        _vfx_index = by_path, by_stem
    return _vfx_index


def find_effect(global_wad: Path, emote_base: str) -> BinFile:
    """The effect bin whose strings name f'{emote_base}_vfx.tex' (emote_base as from emote_base(), lower case).
    Fallbacks, in order: f'{emote_base}_glow.tex' (animated emotes have no plain _VFX.tex), then either name matched
    ignoring case, '_' and folders (e.g. tahmkench_grin vs Tahm_Kench_Grin_VFX.tex)."""
    by_path, by_stem = _effect_index(global_wad)
    full = f'{emote_base}_vfx.tex'.lower()
    stem = _norm(emote_base.rsplit('/', 1)[-1])
    hits = (by_path.get(full) or by_path.get(f'{emote_base}_glow.tex'.lower())
            or by_stem.get(stem + '_vfx.tex') or by_stem.get(stem + '_glow.tex') or [])
    if not hits:
        raise LookupError(f'no effect bin names {full}')
    if len(hits) > 1:
        print(f'note: {len(hits)} effect bins name {full}; using the smallest', file=sys.stderr)
    return hits[0]


def linked_bins(global_wad: Path, b: BinFile) -> list[BinFile]:
    files = wad_read_some(global_wad, b.linked)
    return [read_bin(files[p]) for p in b.linked if p in files]


def effect_textures(global_wad: Path, bins: list[BinFile]):
    """Every .tex the bins name, decoded to RGBA PIL images, keyed by lower-case path. Undecodable ones are left out."""
    paths = sorted({s for b in bins for s in b.strings if s.lower().endswith('.tex')})
    files = wad_read_some(global_wad, paths)
    out = {}
    for p, data in files.items():
        try:
            out[p.lower()] = tex_to_png(data)
        except SystemExit as e:
            print(f'note: {e}', file=sys.stderr)
    return out


# ---- emote list ----
def load_emotes(league: Path) -> list[dict]:
    """The client's emote list. It is cached in CACHE as summoner-emotes.json and extracted again whenever the client WAD
    (default-assets.wad) differs in size or modification time from when it was cached, i.e. after a client patch."""
    wad = league / CLIENT_WAD_REL
    if not wad.is_file():
        raise SystemExit(f'client WAD not found: {wad} (is --league the folder that contains Game/ and Plugins/?)')
    st = wad.stat()
    key = f'{st.st_size} {st.st_mtime_ns}'
    cached, key_file = CACHE / 'summoner-emotes.json', CACHE / 'summoner-emotes.json.key'
    if not (cached.is_file() and key_file.is_file() and key_file.read_text(encoding='utf-8') == key):
        data = wad_read(wad, [EMOTES_JSON])[EMOTES_JSON]
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(data)
        key_file.write_text(key, encoding='utf-8')
    return json.loads(cached.read_text(encoding='utf-8'))


def load_zh_names(required: bool = False) -> dict[int, str]:
    """League id -> Chinese name, from CACHE/summoner-emotes.zh_cn.json. That file is downloaded by hand (ZH_NAMES_URL).
    Without it, required=True stops the run (the catalog must not get English names for nameZh); otherwise it warns and
    returns {}, and callers show the English names."""
    p = CACHE / ZH_NAMES_FILE
    if not p.is_file():
        how = f'download {ZH_NAMES_URL} and save it as {p}'
        if required:
            raise SystemExit(f'Chinese emote names not found: {how}')
        print(f'WARNING: no Chinese emote names, showing English names instead; to get them {how}', file=sys.stderr)
        return {}
    return {e['id']: e['name'] for e in json.loads(p.read_text(encoding='utf-8'))}


def emote_base(emote: dict) -> str:
    """The inventory icon path, lower case, without '/lol-game-data/assets/' and '_inventory[.<variant>].png'."""
    icon = emote['inventoryIcon'].lower().removeprefix('/lol-game-data/assets/')
    head, sep, _tail = icon.rpartition('_inventory')
    return head if sep and icon.endswith('.png') else icon


def emote_by_id(league: Path, eid: int) -> dict:
    for e in load_emotes(league):
        if e['id'] == eid:
            return e
    raise SystemExit(f'no emote with id {eid}')


# ---- value evaluation ----
def _lerp_keys(times: list[float], values: list, x: float):
    if x <= times[0] or len(times) == 1:
        return values[0]
    for i in range(1, len(times)):
        if x <= times[i]:
            t0, t1 = times[i - 1], times[i]
            f = (x - t0) / (t1 - t0) if t1 > t0 else 1.0
            a, b = values[i - 1], values[i]
            if isinstance(a, tuple):
                return tuple(p + (q - p) * f for p, q in zip(a, b))
            return a + (b - a) * f
    return values[-1]


def _table(t: BinObj | None, r: float) -> float:
    if t is None or not t.get('keyTimes'):
        return 1.0
    return _lerp_keys(t.get('keyTimes'), t.get('keyValues'), r)


def val(o, x: float = 0.0, rnd: list[float] | None = None, default=None):
    """Evaluates a Value* object (constantValue or dynamics) at normalised time x.
    rnd holds this particle's random draws for the dynamics' probability tables (one per component)."""
    if o is None:
        return default
    if not isinstance(o, BinObj):
        return o
    dyn = o.get('dynamics')
    if dyn is not None and dyn.get('values'):
        v = _lerp_keys(dyn.get('times') or [0.0], dyn.get('values'), x)
        tables = dyn.get('probabilityTables')
        if tables and rnd is not None:
            if isinstance(v, tuple):
                v = tuple(c * _table(tables[i] if i < len(tables) else None, rnd[i]) for i, c in enumerate(v))
            else:
                v = v * _table(tables[0], rnd[0])
        return v
    c = o.get('constantValue')
    return default if c is None else c


def _rot(v, axis, deg):
    """Rodrigues rotation of vector v about a unit axis by deg degrees."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    n = math.sqrt(sum(x * x for x in axis)) or 1.0
    k = [x / n for x in axis]
    dot = sum(p * q for p, q in zip(k, v))
    cross = (k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0])
    return tuple(v[i] * c + cross[i] * s + k[i] * dot * (1 - c) for i in range(3))


def _add(a, b):
    return tuple(p + q for p, q in zip(a, b))


def _mul(a, b):
    return tuple(p * q for p, q in zip(a, b))


# ---- renderer ----
HANDLED = {
    'disabled', 'timeBeforeFirstEmission', 'lifetime', 'rate', 'isSingleParticle', 'particleLifetime', 'particleLinger',
    'childParticleSetDefinition', 'EmitterPosition', 'SpawnShape', 'birthVelocity', 'velocity', 'birthDrag',
    'worldAcceleration', 'birthAcceleration', 'birthScale0', 'scale0', 'isUniformScale', 'birthRotation0', 'rotation0',
    'isRotationEnabled', 'birthRotationalVelocity0', 'birthColor', 'Color', 'blendMode', 'alphaRef', 'pass', 'texture',
    'texDiv', 'numFrames', 'isRandomStartFrame', 'startFrame', 'frameRate', 'alphaErosionDefinition', 'primitive',
}
# Present on emote emitters but assumed to change nothing visible in a baked, unattached, camera-facing emote.
NO_VISIBLE_EFFECT = {
    'emitterName',                 # label
    'bindWeight',                  # 1.0 everywhere: particles follow the (unmoving) emitter
    'importance',                  # LOD culling priority
    'FlexShapeDefinition',         # scales by the bound object's size; an emote has none (factor 1)
    'isLocalOrientation',          # false on the rays; the system is not rotated
    'Linger',                      # behaviour after the system is killed early
    'miscRenderFlags', 'depthBiasFactors', 'disableBackfaceCull', 'isGroundLayer',  # depth / culling
    'meshRenderFlags',             # only for mesh primitives, which are skipped (and reported) anyway
    'colorLookUpTypeX', 'colorLookUpTypeY', 'colorLookUpScales', 'colorLookUpOffsets',  # only with particleColorTexture
}
# Skipped fields that leave the look unchanged: uvMode (Facepalm's image is continuous across the Mid -> outro hand-off,
# where only Mid has it) and erosionSliceWidth (always >= 1 on emotes). Any other skip may change the look.
HARMLESS_SKIPS = ('.uvMode', '.alphaErosionDefinition.erosionSliceWidth')


def unfaithful(skipped: list[str]) -> list[str]:
    """The skipped properties (as render() and audit() report them) that may make the bake look different from the game."""
    return [s for s in skipped if not s.endswith(HARMLESS_SKIPS)]


EROSION_HANDLED = {'erosionDriveCurve', 'erosionFeatherIn', 'erosionFeatherOut', 'erosionMapName', 'erosionMapChannelMixer',
                   'erosionMapAddressMode'}
SHAPE_HANDLED = {'emitOffset', 'emitRotationAngles', 'emitRotationAxes', 'radius', 'Size', 'height', 'flags'}
RAY, SHAPE_SPHERE, SHAPE_BOX, SHAPE_CYLINDER = (fnv1a32(n) for n in ('VfxPrimitiveRay', 'VfxShapeSphere', 'VfxShapeBox',
                                                                     'VfxShapeCylinder'))
_NAMES: dict[int, str] = {fnv1a32(n): n for n in HANDLED | NO_VISIBLE_EFFECT | EROSION_HANDLED | SHAPE_HANDLED}
_names_loaded = False


def _name(h: int) -> str:
    """Field/class name for reports; unknown hashes are looked up in the CommunityDragon lists when present."""
    global _names_loaded
    if h not in _NAMES and not _names_loaded:
        _NAMES.update(load_names(CACHE, ('hashes.binfields.txt', 'hashes.bintypes.txt')))
        _names_loaded = True
    return _NAMES.get(h, f'{h:#010x}')


class _Tex:
    """Premultiplied float RGBA texture with a box-filtered mip chain, plus the straight copy for erosion lookups."""

    def __init__(self, img):
        import numpy as np

        a = np.asarray(img.convert('RGBA'), dtype=np.float32) / 255.0
        self.straight = a
        p = a.copy()
        p[..., :3] *= p[..., 3:4]
        self.mips = [p]
        while min(p.shape[:2]) >= 2 and len(self.mips) < 8:
            h, w = p.shape[0] // 2 * 2, p.shape[1] // 2 * 2
            p = (p[0:h:2, 0:w:2] + p[1:h:2, 0:w:2] + p[0:h:2, 1:w:2] + p[1:h:2, 1:w:2]) * 0.25
            self.mips.append(p)


def _sample(np, arr, u, v, rect=(0.0, 0.0, 1.0, 1.0)):
    """Bilinear, clamped to rect (u0, v0, u1, v1) in normalised texture space. Returns (N, C)."""
    h, w = arr.shape[:2]
    u0, v0, u1, v1 = rect
    x = (u0 + u * (u1 - u0)) * w - 0.5
    y = (v0 + v * (v1 - v0)) * h - 0.5
    xa, xb = u0 * w, u1 * w - 1
    ya, yb = v0 * h, v1 * h - 1
    x = np.clip(x, xa, xb)
    y = np.clip(y, ya, yb)
    x0 = np.floor(x)
    y0 = np.floor(y)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    x0 = x0.astype(np.int32)
    y0 = y0.astype(np.int32)
    x1 = np.minimum(x0 + 1, int(xb))
    y1 = np.minimum(y0 + 1, int(yb))
    top = arr[y0, x0] * (1 - fx) + arr[y0, x1] * fx
    bot = arr[y1, x0] * (1 - fx) + arr[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def is_halo(e: BinObj) -> bool:
    """The standard layout's MidGlow: the emote's own <name>_Glow.tex drawn behind it (see GLOW_OPACITY)."""
    return ((e.get('emitterName') or '').startswith('MidGlow')
            and (e.get('texture') or '').lower().endswith('_glow.tex'))


def root_origin(sysdef: BinObj) -> tuple:
    """Where the root system's origin sits relative to the canvas centre: its transform's translation (the last row
    of the 4x4) less (0, EMOTE_CENTRE_Y, 0). Zero for the standard layout."""
    t = sysdef.get('transform')
    if not t:
        return (0.0, 0.0, 0.0)
    return (t[12], t[13] - EMOTE_CENTRE_Y, t[14])


def is_system(o: BinObj) -> bool:
    return o.get('complexEmitterDefinitionData') is not None or o.get('simpleEmitterDefinitionData') is not None


def child_key(c: BinObj) -> int | None:
    """The system a VfxChildIdentifier points at (an objectPath / entry hash)."""
    if c.get('effect') is not None:
        return c.get('effect')
    if c.get('effectKey') is not None:
        return c.get('effectKey')
    if c.get('effectName'):
        return fnv1a32(c.get('effectName'))
    return None


def children_of(sysdef: BinObj) -> list[int]:
    keys = []
    for e in sysdef.get('complexEmitterDefinitionData') or []:
        if e.get('disabled'):
            continue
        for c in (e.get('childParticleSetDefinition') or BinObj(0)).get('childrenIdentifiers') or []:
            keys.append(child_key(c))
    return keys


def systems_by_key(bins: list[BinFile]) -> dict[int, BinObj]:
    out = {}
    for b in bins:
        for key, o in b.entries.items():
            if is_system(o):
                for k in {key, o.get('objectPath'), fnv1a32(o.get('particlePath') or '')} - {None}:
                    out.setdefault(k, o)
    return out


def root_system(effect: BinFile, linked: list[BinFile]) -> BinObj:
    """The effect's system that no other system spawns as a child."""
    systems = systems_by_key([effect, *linked])
    spawned = {id(systems[k]) for o in systems.values() for k in children_of(o) if k in systems}
    roots = [o for o in effect.entries.values() if is_system(o) and id(o) not in spawned]
    if not roots:
        raise ValueError('effect has no root particle system')
    return roots[0]


def emote_sound(effect: BinFile) -> str | None:
    """The sound event the effect names for itself: its root system's soundOnCreateDefault (e.g. Play_sfx_Emotes_4341)."""
    return root_system(effect, []).get('soundOnCreateDefault') or None


def sound_name_candidates(emote: dict, effect: BinFile) -> list[str]:
    """Event names an emote's own sound could have when its effect names none: Play_sfx_Emotes_ or Play_vo_Emotes_ with
    its id, or with the words of its particle name or icon path (EM_ prefix and numbers dropped; joined with _, run
    together, or capitalised), optionally followed by _vox. E.g. Gasp! (particle EM_Gasp) -> Play_sfx_Emotes_Gasp."""
    stems = [str(emote['id'])]
    for src in (root_system(effect, []).get('particleName') or '', emote_base(emote).rsplit('/', 1)[-1]):
        words = [w for w in re.split(r'[^A-Za-z0-9]+', src) if w and not w.isdigit() and w.lower() != 'em']
        if words:
            stems += ['_'.join(words), ''.join(words), ''.join(w.capitalize() for w in words)]
    return list(dict.fromkeys(f'{pre}{stem}{suf}' for pre in ('Play_sfx_Emotes_', 'Play_vo_Emotes_')
                              for stem in stems for suf in ('', '_vox')))


SOUND_OWN, SOUND_FAMILY, SOUND_NONE = 'own', 'family', 'none'


def family_sounds(effect: BinFile, linked: list[BinFile]) -> list[str]:
    """The soundOnCreateDefault of each system the root spawns: its family template's
    Play_sfx_Goodies_Emotes_Template_<Family> event, which the game plays for every emote alongside its own."""
    systems = systems_by_key([effect, *linked])
    return [systems[k].get('soundOnCreateDefault') for k in children_of(root_system(effect, linked))
            if k in systems and systems[k].get('soundOnCreateDefault')]


def choose_sound(emote: dict, effect: BinFile, family: list[str], sounds: 'EmoteSounds') -> tuple[str | None, str]:
    """(event, source) for an emote. Its own sound comes first: the event its effect names, else a bank event named
    after it (sound_name_candidates). Only without one does it take its family's (family_sounds). Events missing from
    the banks don't count."""
    own = emote_sound(effect)
    for event in ([own] if own else []) + sound_name_candidates(emote, effect):
        if sounds.has(event):
            return event, SOUND_OWN
    for event in family:
        if sounds.has(event):
            return event, SOUND_FAMILY
    return None, SOUND_NONE


@dataclass
class _Emitter:
    sys_index: int
    index: int
    sys_name: str
    obj: BinObj

    def g(self, name, default=None):
        return self.obj.get(name, default)


@dataclass
class _SysInst:
    sysdef: BinObj
    order: int
    origin_of: object                   # callable -> origin (x, y, z) of this instance at the current time
    t_start: float
    t_kill: float = math.inf            # when the parent particle died (emission stops, particles linger)
    emit_acc: dict = field(default_factory=dict)


@dataclass
class _Particle:
    em: _Emitter
    inst: _SysInst
    seq: int
    born: float
    life: float
    die: float
    pos: tuple
    vel: tuple
    acc: tuple
    drag: tuple
    scale: tuple
    color: tuple
    rot: tuple                          # birth rotation (deg)
    spin: float                         # birthRotationalVelocity0.x (deg/s)
    roll: float = 0.0                   # integrated rotation0 + spin (deg)
    frame: int = 0
    rnd: dict = field(default_factory=dict)


class Baker:
    def __init__(self, effect: BinFile, linked: list[BinFile], textures: dict, seed: int,
                 glow_opacity: float | None = None):
        self.glow_opacity = GLOW_OPACITY if glow_opacity is None else glow_opacity
        self.systems = systems_by_key([effect, *linked])
        self.root = root_system(effect, linked)
        self.rng = random.Random(seed)
        self.tex = {k: _Tex(v) for k, v in textures.items()}
        self.skipped: list[str] = []
        self.emitters: dict[int, list[_Emitter]] = {}
        self.particles: list[_Particle] = []
        self.instances: list[_SysInst] = []
        self.seq = 0

    def skip(self, what: str) -> None:
        if what not in self.skipped:
            self.skipped.append(what)

    def _emitters_of(self, sysdef: BinObj, order: int) -> list[_Emitter]:
        key = id(sysdef)
        if key not in self.emitters:
            name = sysdef.get('particleName') or '?'
            self.emitters[key] = [_Emitter(order, i, name, e)
                                  for i, e in enumerate(sysdef.get('complexEmitterDefinitionData') or [])]
            self._audit_system(sysdef)
        return self.emitters[key]

    def audit(self) -> list[str]:
        """Records the skipped fields of every system the root can spawn, whether or not it spawns within DURATION."""
        todo, seen = [self.root], set()
        while todo:
            sysdef = todo.pop(0)
            if id(sysdef) in seen:
                continue
            seen.add(id(sysdef))
            self._audit_system(sysdef)
            for e in sysdef.get('complexEmitterDefinitionData') or []:
                if e.get('disabled'):
                    continue
                for c in (e.get('childParticleSetDefinition') or BinObj(0)).get('childrenIdentifiers') or []:
                    child = self.systems.get(child_key(c))
                    if child is None:
                        self.skip(f'{sysdef.get("particleName") or "?"}/{e.get("emitterName")}: child effect '
                                  f'{child_key(c)} not found')
                    else:
                        todo.append(child)
        return self.skipped

    def _audit_system(self, sysdef: BinObj) -> None:
        name = sysdef.get('particleName') or '?'
        for i, e in enumerate(sysdef.get('complexEmitterDefinitionData') or []):
            self._audit(_Emitter(0, i, name, e))
        if sysdef.get('simpleEmitterDefinitionData'):
            self.skip(f'{name}: simpleEmitterDefinitionData')

    def _audit(self, em: _Emitter) -> None:
        """Records every field of a drawn emitter that the renderer does not interpret."""
        e, label = em.obj, f'{em.sys_name}/{em.g("emitterName")}'
        if e.get('disabled'):
            return
        for h in e.fields:
            n = _name(h)
            if n not in HANDLED and n not in NO_VISIBLE_EFFECT:
                self.skip(f'{label}.{n}')
        prim = e.get('primitive')
        drawn = prim is None or prim.cls == RAY
        if not drawn:
            self.skip(f'{label}.primitive={_name(prim.cls)} (emitter not drawn)')
        bm = e.get('blendMode')
        if bm not in (1, 4):
            self.skip(f'{label}.blendMode={bm} (drawn as alpha blend)')
        ero = e.get('alphaErosionDefinition')
        if ero is not None:
            for h in ero.fields:
                if _name(h) not in EROSION_HANDLED:
                    self.skip(f'{label}.alphaErosionDefinition.{_name(h)}')
        shape = e.get('SpawnShape')
        if shape is not None:
            for h in shape.fields:
                if _name(h) not in SHAPE_HANDLED:
                    self.skip(f'{label}.SpawnShape.{_name(h)}')
        tex = e.get('texture')
        if tex and tex.lower() not in self.tex and drawn:
            self.skip(f'{label}.texture {tex} (missing or undecodable; emitter not drawn)')
        if ero is not None and ero.get('erosionMapName') and ero.get('erosionMapName').lower() not in self.tex:
            self.skip(f'{label}.erosionMapName {ero.get("erosionMapName")} (missing; erosion ignored)')

    # -- simulation --
    def spawn_system(self, sysdef: BinObj, t: float, origin_of) -> _SysInst:
        inst = _SysInst(sysdef, len(self.instances), origin_of, t)
        self.instances.append(inst)
        self._emitters_of(sysdef, inst.order)
        return inst

    def _rand(self, n: int) -> list[float]:
        return [self.rng.random() for _ in range(n)]

    def _birth(self, em: _Emitter, inst: _SysInst, t: float) -> None:
        e = em.obj
        t0 = inst.t_start + (e.get('timeBeforeFirstEmission') or 0.0)
        elife = e.get('lifetime')
        ex = min(1.0, (t - t0) / elife) if elife else 0.0
        rnd = {}

        def bv(name, default, n):
            rnd[name] = self._rand(n)
            return val(e.get(name), ex, rnd[name], default)

        life = bv('particleLifetime', 1.0, 1)
        scale = bv('birthScale0', (1.0, 1.0, 1.0), 3)
        color = bv('birthColor', (1.0, 1.0, 1.0, 1.0), 4)
        rot = bv('birthRotation0', (0.0, 0.0, 0.0), 3)
        spin = bv('birthRotationalVelocity0', (0.0, 0.0, 0.0), 3)[0]
        vel = bv('birthVelocity', (0.0, 0.0, 0.0), 3)
        drag = bv('birthDrag', (0.0, 0.0, 0.0), 3)
        acc = _add(bv('birthAcceleration', (0.0, 0.0, 0.0), 3), val(e.get('worldAcceleration'), 0.0, None, (0.0, 0.0, 0.0)))
        pos = bv('EmitterPosition', (0.0, 0.0, 0.0), 3)
        shape = e.get('SpawnShape')
        if shape is not None:
            off = shape.get('emitOffset')
            if isinstance(off, BinObj):
                off = val(off, ex, self._rand(3), (0.0, 0.0, 0.0))
            off = tuple(off) if off is not None else (0.0, 0.0, 0.0)
            if shape.cls == SHAPE_SPHERE and shape.get('radius'):
                z, a = 2 * self.rng.random() - 1, 2 * math.pi * self.rng.random()
                s = math.sqrt(1 - z * z) * shape.get('radius')
                off = _add(off, (s * math.cos(a), shape.get('radius') * z, s * math.sin(a)))
            elif shape.cls == SHAPE_BOX and shape.get('Size'):
                off = _add(off, tuple((self.rng.random() - 0.5) * c for c in shape.get('Size')))
            elif shape.cls == SHAPE_CYLINDER and shape.get('radius'):
                a, r = 2 * math.pi * self.rng.random(), shape.get('radius') * math.sqrt(self.rng.random())
                off = _add(off, (r * math.cos(a), (self.rng.random() - 0.5) * (shape.get('height') or 0.0), r * math.sin(a)))
            for ang, axis in zip(shape.get('emitRotationAngles') or [], shape.get('emitRotationAxes') or []):
                deg = val(ang, ex, self._rand(1), 0.0)
                off, vel = _rot(off, axis, deg), _rot(vel, axis, deg)
            pos = _add(pos, off)
        frames = max(1, e.get('numFrames') or 1)
        frame = (e.get('startFrame') or 0) % frames
        if e.get('isRandomStartFrame'):
            frame = self.rng.randrange(frames)
        for name, n in (('Color', 4), ('scale0', 3), ('erosion', 1)):   # over-life probability tables
            rnd[name] = self._rand(n)
        die = t + life
        if inst.t_kill < math.inf:
            die = min(die, inst.t_kill + (e.get('particleLinger') or 0.0))
        p = _Particle(em, inst, self.seq, t, life, die, pos, vel, acc, drag, scale, color, rot, spin, rot[0], frame, rnd)
        self.seq += 1
        self.particles.append(p)
        csd = e.get('childParticleSetDefinition')
        if csd is not None:
            for c in csd.get('childrenIdentifiers') or []:
                child = self.systems.get(child_key(c))
                if child is None:
                    self.skip(f'{em.sys_name}/{e.get("emitterName")}: child effect {child_key(c)} not found')
                    continue
                self.spawn_system(child, t, lambda p=p: self.world_pos(p)).t_kill = die

    def world_pos(self, p: _Particle) -> tuple:
        return _add(p.inst.origin_of(), p.pos)

    def emit(self, t: float, dt: float) -> None:
        for inst in list(self.instances):
            for em in self.emitters[id(inst.sysdef)]:
                e = em.obj
                if e.get('disabled'):
                    continue
                t0 = inst.t_start + (e.get('timeBeforeFirstEmission') or 0.0)
                elife = e.get('lifetime')
                t_end = min(t0 + elife if elife is not None else math.inf, inst.t_kill)
                key = id(em)
                if e.get('isSingleParticle'):
                    if key not in inst.emit_acc and t0 <= t + 1e-9 and t0 < inst.t_kill:
                        inst.emit_acc[key] = 1
                        self._birth(em, inst, t)
                    continue
                if not (t0 <= t + 1e-9 < t_end):
                    continue
                ex = min(1.0, (t - t0) / elife) if elife else 0.0
                acc = inst.emit_acc.get(key, 1.0)          # the first particle leaves at once
                rate = val(e.get('rate'), ex, None, 0.0)
                n = int(acc)
                for _ in range(n):
                    self._birth(em, inst, t)
                inst.emit_acc[key] = acc - n + rate * dt

    def step(self, t: float, dt: float) -> None:
        """Advances every live particle from t to t + dt."""
        for p in self.particles:
            if not (p.born <= t < p.die):
                continue
            e = p.em.obj
            age = (t - p.born) / p.life if p.life > 0 else 1.0
            ax, ay, az = p.acc
            vx, vy, vz = p.vel
            dx, dy, dz = p.drag
            p.vel = (vx + (ax - dx * vx) * dt, vy + (ay - dy * vy) * dt, vz + (az - dz * vz) * dt)
            ov = val(e.get('velocity'), age, None, (0.0, 0.0, 0.0))
            p.pos = tuple(p.pos[i] + (p.vel[i] + ov[i]) * dt for i in range(3))
            r0 = val(e.get('rotation0'), age, None, (0.0, 0.0, 0.0))
            p.roll += (ROTATION0_SCALE * r0[0] + p.spin) * dt

    # -- drawing --
    def draw(self, canvas, t: float) -> None:
        import numpy as np

        live = [p for p in self.particles if p.born <= t < p.die]
        live.sort(key=lambda p: (p.em.g('pass') or 0, p.em.sys_index, p.em.index, p.seq))
        for p in live:
            e = p.em.obj
            prim = e.get('primitive')
            if prim is not None and prim.cls != RAY:
                continue
            tex_path = (e.get('texture') or '').lower()
            tex = self.tex.get(tex_path)
            if tex is None:
                continue
            age = min(1.0, (t - p.born) / p.life) if p.life > 0 else 1.0
            col = _mul(p.color, val(e.get('Color'), age, p.rnd['Color'], (1.0, 1.0, 1.0, 1.0)))
            alpha = max(0.0, min(1.0, col[3])) * (self.glow_opacity if is_halo(e) else 1.0)
            if alpha <= 1 / 512:
                continue
            scale = _mul(p.scale, val(e.get('scale0'), age, p.rnd['scale0'], (1.0, 1.0, 1.0)))
            if e.get('isUniformScale'):
                scale = (scale[0], scale[0], scale[0])
            wx, wy, _wz = self.world_pos(p)
            cx, cy = CANVAS / 2 + wx * PX_PER_UNIT, CANVAS / 2 - wy * PX_PER_UNIT
            if prim is not None:
                quad = self._ray_quad(p, scale, cx, cy)
            else:
                hx, hy = scale[0] * PX_PER_UNIT, scale[1] * PX_PER_UNIT
                a = math.radians(p.roll)
                ex_, ey_ = (math.cos(a), -math.sin(a)), (-math.sin(a), -math.cos(a))  # canvas y points down
                eu = (2 * hx * ex_[0], 2 * hx * ex_[1])
                ev = (-2 * hy * ey_[0], -2 * hy * ey_[1])
                o = (cx - hx * ex_[0] + hy * ey_[0], cy - hx * ex_[1] + hy * ey_[1])
                quad = (o, eu, ev)
            if quad is None:
                continue
            ero = e.get('alphaErosionDefinition')
            erosion = None
            if ero is not None:
                emap = self.tex.get((ero.get('erosionMapName') or '').lower())
                if emap is not None:
                    drive = val(ero.get('erosionDriveCurve'), age, p.rnd['erosion'], 0.0)
                    feather = ero.get('erosionFeatherIn') or ero.get('erosionFeatherOut') or 0.1
                    mixer = val(ero.get('erosionMapChannelMixer'), 0.0, None, (0.0, 0.0, 0.0, 1.0))
                    erosion = (emap, drive, feather, mixer)
            frames = max(1, e.get('numFrames') or 1)
            frame = (p.frame + int((t - p.born) * (e.get('frameRate') or 0.0))) % frames
            self._blit(np, canvas, tex, frame, quad, col, alpha, e, erosion)

    def _ray_quad(self, p: _Particle, scale, cx, cy):
        """VfxPrimitiveRay: a strip from the particle outwards, scale.y long and scale.x wide, texture bottom at the base.
        Direction: screen-up rolled by the x rotation (as a billboard's roll), then turned about the vertical axis by the
        y rotation, which foreshortens it sideways and mirrors it at 180 degrees. (The emote templates draw y from
        [0, -45] and [-135, -180]: facing the camera or mirrored, never edge-on.)"""
        a, yaw = math.radians(p.roll), math.radians(p.rot[1])
        dx, dy = -math.sin(a) * math.cos(yaw), math.cos(a)
        dl = math.hypot(dx, dy)
        if dl < 1e-4:
            return None
        ux, uy = dx / dl, -dy / dl                                # canvas direction (y down)
        length = scale[1] * PX_PER_UNIT * dl
        hw = scale[0] * PX_PER_UNIT / 2
        if length < 0.5 or hw < 0.25:
            return None
        nx, ny = -uy, ux
        tip = (cx + ux * length, cy + uy * length)
        o = (tip[0] - nx * hw, tip[1] - ny * hw)
        return o, (2 * hw * nx, 2 * hw * ny), (-length * ux, -length * uy)

    def _blit(self, np, canvas, tex: _Tex, frame: int, quad, col, alpha, e: BinObj, erosion) -> None:
        blend, alpha_ref = e.get('blendMode'), e.get('alphaRef') or 0
        (ox, oy), (ux, uy), (vx, vy) = quad
        xs = [ox, ox + ux, ox + vx, ox + ux + vx]
        ys = [oy, oy + uy, oy + vy, oy + uy + vy]
        x0, x1 = max(0, int(math.floor(min(xs)))), min(CANVAS, int(math.ceil(max(xs))))
        y0, y1 = max(0, int(math.floor(min(ys)))), min(CANVAS, int(math.ceil(max(ys))))
        if x0 >= x1 or y0 >= y1:
            return
        det = ux * vy - uy * vx
        if abs(det) < 1e-6:
            return
        gy, gx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        px, py = gx.ravel() + 0.5 - ox, gy.ravel() + 0.5 - oy
        u = (px * vy - py * vx) / det
        v = (py * ux - px * uy) / det
        inside = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
        if not inside.any():
            return
        idx = np.nonzero(inside)[0]
        u, v = u[idx], v[idx]
        cols_rows = e.get('texDiv') or (1.0, 1.0)
        cols, rows = max(1, int(cols_rows[0])), max(1, int(cols_rows[1]))
        fc, fr = frame % cols, (frame // cols) % rows
        rect = (fc / cols, fr / rows, (fc + 1) / cols, (fr + 1) / rows)
        # mip level from the on-screen footprint of one texel
        th, tw = tex.mips[0].shape[:2]
        fu = (tw / cols) / max(1e-3, math.hypot(ux, uy))
        fv = (th / rows) / max(1e-3, math.hypot(vx, vy))
        level = int(max(0, min(len(tex.mips) - 1, math.floor(math.log2(max(1e-6, math.sqrt(fu * fv)))))))
        src = _sample(np, tex.mips[level], u, v, rect)          # premultiplied
        a = src[:, 3] * alpha
        if erosion is not None:
            emap, drive, feather, mixer = erosion
            m = _sample(np, emap.straight, u, v) @ np.asarray(mixer, dtype=np.float32)
            thr = drive * (1 + feather) - feather
            k = np.clip((m - thr) / feather, 0.0, 1.0)
            k = k * k * (3 - 2 * k)
            a = a * k
        else:
            k = None
        if alpha_ref:
            a = np.where(src[:, 3] * 255 < alpha_ref, 0.0, a)
        tint = np.asarray([max(0.0, c) for c in col[:3]], dtype=np.float32)
        rgb = src[:, :3] * tint * alpha
        if k is not None:
            rgb = rgb * k[:, None]
        if alpha_ref:
            rgb = np.where((src[:, 3] * 255 < alpha_ref)[:, None], 0.0, rgb)
        ys_, xs_ = (idx // (x1 - x0)) + y0, (idx % (x1 - x0)) + x0
        dst = canvas[ys_, xs_]
        if blend == 4:                                          # additive light: alpha follows its brightness
            out_rgb = dst[:, :3] + rgb
            out_a = np.maximum(dst[:, 3], 0) + rgb.max(axis=1)
        else:
            out_rgb = rgb + dst[:, :3] * (1 - a)[:, None]
            out_a = a + dst[:, 3] * (1 - a)
        canvas[ys_, xs_, :3] = out_rgb
        canvas[ys_, xs_, 3] = out_a

    def run(self):
        """Yields one straight-alpha RGBA uint8 frame per 1/FPS s."""
        import numpy as np

        origin = root_origin(self.root)
        self.spawn_system(self.root, 0.0, lambda: origin)
        dt = 1.0 / (FPS * SUBSTEPS)
        nframes = int(round(DURATION * FPS))
        edge = np.minimum(np.arange(CANVAS), np.arange(CANVAS)[::-1]) + 0.5      # px distance to the nearest edge, per axis
        edge = np.minimum(edge[:, None], edge[None, :])
        feather = (lambda k: k * k * (3 - 2 * k))(np.clip(edge / EDGE_FEATHER_PX, 0.0, 1.0)).astype(np.float32)
        step = 0
        self.emit(0.0, dt)
        for i in range(nframes):
            canvas = np.zeros((CANVAS, CANVAS, 4), dtype=np.float32)
            self.draw(canvas, i / FPS)
            rgb = np.clip(canvas[..., :3], 0, None)
            a = np.clip(np.maximum(canvas[..., 3], rgb.max(axis=2)), 0, 1)
            a = np.where(a < 1.5 / 255, 0.0, a)                  # drop invisible haze (smaller files)
            straight = np.where(a[..., None] > 0, rgb / np.maximum(a[..., None], 1e-6), 0)
            out = np.dstack([np.clip(straight, 0, 1), a * feather])   # straight colour kept, so premultiplied fades too
            yield (out * 255 + 0.5).astype(np.uint8)
            for _ in range(SUBSTEPS):
                self.step(step * dt, dt)
                step += 1
                self.emit(step * dt, dt)


def render(effect: BinFile, linked: list[BinFile], textures: dict, seed: int | None = None,
           glow_opacity: float | None = None) -> tuple[list, list[str]]:
    """Renders the effect (3 s, 30 fps, 320 x 320; the halo at glow_opacity, default GLOW_OPACITY). Returns the RGBA
    frames (PIL images) and the skipped properties of every system the effect can spawn."""
    from PIL import Image

    root_name = next((o.get('particlePath') for o in effect.entries.values() if o.get('particlePath')), 'emote')
    b = Baker(effect, linked, textures, fnv1a32(root_name) if seed is None else seed, glow_opacity)
    b.audit()
    return [Image.fromarray(f, 'RGBA') for f in b.run()], b.skipped


def write_webp(frames: list, out: Path, alpha_quality: int = WEBP_ALPHA_QUALITY) -> None:
    """The frames as an animated WebP that plays once (lossy, quality WEBP_QUALITY, lossy alpha at alpha_quality)."""
    durations = [round((i + 1) * 1000 / FPS) - round(i * 1000 / FPS) for i in range(len(frames))]
    out.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(out, format='WEBP', save_all=True, append_images=frames[1:], duration=durations, loop=1,
                   quality=WEBP_QUALITY, alpha_quality=alpha_quality, lossless=False, method=4)


def write_poster(frames: list, out: Path) -> None:
    """The frame at POSTER_TIME as a still WebP, for galleries."""
    frames[min(len(frames) - 1, round(POSTER_TIME * FPS))].save(out, format='WEBP', quality=WEBP_QUALITY,
                                                                alpha_quality=WEBP_ALPHA_QUALITY, method=4)


# ---- sound ----
def _wpk_entries(wpk: bytes) -> dict[int, bytes]:
    magic, _version, n = struct.unpack_from('<4sII', wpk)
    if magic != b'r3d2':
        raise SystemExit('not a WPK file')
    out = {}
    for off in struct.unpack_from(f'<{n}I', wpk, 12):
        if not off:
            continue
        data_off, size, name_len = struct.unpack_from('<III', wpk, off)
        name = wpk[off + 12:off + 12 + name_len * 2].decode('utf-16-le')
        out[int(name.split('.')[0])] = wpk[data_off:data_off + size]
    return out


class EmoteSounds:
    def __init__(self, league: Path):
        self.objs: dict[int, tuple[int, bytes]] = {}
        self.media: dict[int, bytes] = {}
        vo_wad = league / WAD_REL.with_name(f'Common.{EMOTE_VO_LOCALE}.wad.client')
        for wad, banks in ((league / WAD_REL, EMOTE_BANKS), (vo_wad, EMOTE_VO_BANKS)):
            if not wad.is_file():
                print(f'WARNING: {wad} not found: the emote sounds in it are unavailable, and the emotes that use them '
                      'fall back to their family sound or none', file=sys.stderr)
                continue
            files = wad_read_some(wad, [p for bank in banks for p in bank])
            for events, audio, wpk in banks:
                if events in files:
                    self.objs.update(parse_hirc(files[events]))
                if audio in files:
                    self.media.update(parse_media(files[audio]))
                if wpk in files:
                    self.media.update(_wpk_entries(files[wpk]))

    def has(self, event: str) -> bool:
        return self.objs.get(fnv1_32(event), (0,))[0] == 4    # a Wwise event

    def render(self, events: list[str], out: Path, vgmstream: str) -> list[str]:
        """Decodes every layer of the events with vgmstream and mixes them (all starting at 0) into an Opus .ogg.
        Returns the events that were found."""
        found = [ev for ev in events if self.has(ev)]
        if not found:
            return []
        with tempfile.TemporaryDirectory() as td:
            wavs = []
            for ev in found:
                for wid in event_media(self.objs, ev):
                    if wid not in self.media:
                        print(f'note: media {wid} of {ev} not found', file=sys.stderr)
                        continue
                    wem, wav = Path(td) / f'{wid}.wem', Path(td) / f'{wid}.wav'
                    wem.write_bytes(self.media[wid])
                    subprocess.run([vgmstream, '-o', str(wav), str(wem)], check=True, capture_output=True)
                    wavs.append(wav)
            if not wavs:
                return []
            cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
            for w in wavs:
                cmd += ['-i', str(w)]
            if len(wavs) > 1:
                cmd += ['-filter_complex',
                        f'amix=inputs={len(wavs)}:normalize=0:duration=longest,alimiter=limit=0.89:level=false']
            cmd += ['-c:a', 'libopus', '-b:a', '96k', '-map_metadata', '-1', '-fflags', '+bitexact', str(out)]
            subprocess.run(cmd, check=True)
        return found


def render_sound(label: str, emote: dict, effect: BinFile, family: list[str], sounds: EmoteSounds, out: Path,
                 vgmstream: str) -> tuple[str | None, str]:
    """Chooses the emote's sound (choose_sound) and renders it to out, which is removed when there is none. Returns
    (event, source). An own sound that can't be rendered (its media is missing or undecodable) is reported with a WARNING
    and replaced by the family template's, as is an effect-named event that is in no loaded bank (say, the voice WAD
    is missing); a sound that can't be rendered at all leaves the emote without one, also with a WARNING."""
    out.unlink(missing_ok=True)
    event, source = choose_sound(emote, effect, family, sounds)
    named = emote_sound(effect)
    if named and not sounds.has(named):
        print(f'WARNING: {label}: its sound {named} is in no loaded bank, so it gets {event or "no sound"} ({source})',
              file=sys.stderr)

    def rendered(ev: str) -> bool:
        try:
            return bool(sounds.render([ev], out, vgmstream))
        except subprocess.CalledProcessError as e:
            print(f'WARNING: {label}: {ev} failed to decode or encode: {e}', file=sys.stderr)
            return False

    tries = [(event, source)] if event else []
    if source == SOUND_OWN:
        tries += [(ev, SOUND_FAMILY) for ev in family if sounds.has(ev)]
    for k, (ev, src) in enumerate(tries):
        if rendered(ev):
            if k:
                print(f'WARNING: {label}: its own sound {event} could not be rendered, so it gets the family sound {ev}',
                      file=sys.stderr)
            return ev, src
        out.unlink(missing_ok=True)
    if tries:
        print(f'WARNING: {label}: none of {[ev for ev, _ in tries]} could be rendered, so it has no sound', file=sys.stderr)
    return None, SOUND_NONE


# ---- commands ----
def effect_family(effect: BinFile) -> str:
    shared = frozenset(s.lower().rsplit('/', 1)[-1] for s in effect.strings
                       if s.lower().startswith('assets/shared/particles/emotes/') and s.lower().endswith('.tex'))
    for name, combo in FAMILIES.items():
        if shared == combo:
            return name
    return 'special: ' + (', '.join(sorted(shared)) or 'no shared textures')


STANDARD_LAYOUTS = ({'IntroAdd', 'IntroAlpha', 'Mid', 'outro', 'Parent', 'MidGlow'},
                    {'IntroAdd', 'Intro', 'Mid', 'outro', 'Parent', 'MidGlow'})


def layout_special(effect: BinFile) -> str | None:
    """Why the root system's emitters differ from the standard six, or None."""
    names = [e.get('emitterName') for e in root_system(effect, []).get('complexEmitterDefinitionData') or []]
    if set(names) in STANDARD_LAYOUTS and len(names) == 6:
        return None
    prims = sorted({_name(e.get('primitive').cls) for e in root_system(effect, []).get('complexEmitterDefinitionData') or []
                    if e.get('primitive') is not None})
    return f'special: {len(names)} emitters' + (f' ({", ".join(prims)})' if prims else '')


def special_reason(effect: BinFile) -> str | None:
    """Why the effect is special (shared textures outside the three families, or not the standard six emitters)."""
    fam = effect_family(effect)
    reasons = [r for r in (fam if fam.startswith('special') else None, layout_special(effect)) if r]
    return '; '.join(r.removeprefix('special: ') for r in reasons) or None


def cmd_specials(league: Path) -> None:
    gw = league / GLOBAL_WAD_REL
    zh = load_zh_names()
    specials, missing = [], []
    for e in load_emotes(league):
        try:
            effect = find_effect(gw, emote_base(e))
        except LookupError:
            missing.append(e)
            continue
        reason = special_reason(effect)
        if reason:
            specials.append((e, reason))
    print(f'{len(specials)} emotes with a special effect (shared textures outside the three families, '
          'or not the standard six emitters):')
    for e, fam in specials:
        print(f'  {e["id"]:>5}  {e["name"]}  ({zh.get(e["id"], "")})  {fam}')
    print(f'{len(missing)} emotes without an effect naming their _VFX.tex or _Glow.tex:')
    for e in missing:
        print(f'  {e["id"]:>5}  {e["name"]}  ({zh.get(e["id"], "")})')


def cmd_sounds(league: Path, emote_ids: list[int]) -> None:
    """Scans every Wwise bank in Global.wad.client and Common.wad.client for the emote events."""
    events = ['Play_sfx_Emotes_' + str(i) for i in emote_ids] + ['Play_sfx_Emotes_Unworthy']
    events += [f'Play_sfx_Goodies_Emotes_Template_{f}' for f in ('SadBored', 'TrollMeme', 'HappyExcited',
                                                                  'AngerConfused', 'LoveCute', 'Prestige')]
    events += ['Play_sfx_Emotes', 'Play_sfx_Emotes_Default', 'Play_sfx_Emotes_Template']
    ids = {fnv1_32(e): e for e in events}
    names = {xxh64(p.encode()): p for bank in EMOTE_BANKS for p in bank}
    for rel in (GLOBAL_WAD_REL, WAD_REL):
        banks = wad_scan(league / rel, lambda d: d[:4] == b'BKHD')
        print(f'{rel}: {len(banks)} banks')
        for h, d in banks.items():
            objs = parse_hirc(d)
            hit = [ids[i] for i in ids if objs.get(i, (0,))[0] == 4]
            if hit:
                print(f'  {names.get(h, hex(h))}: {", ".join(hit)}')
    print('DEFAULT_EMOTE_SOUND =', DEFAULT_EMOTE_SOUND)


def audit(effect: BinFile, linked: list[BinFile], textures: dict) -> list[str]:
    """render()'s skipped properties, without rendering."""
    return Baker(effect, linked, textures, 0).audit()


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '_', ascii_name.lower()).strip('_')


def emote_slugs(emotes: list[dict]) -> dict[int, str]:
    """A stable slug (^[a-z0-9_]{1,40}$) per emote id: its English name, plus _<id> when names collide."""
    base = {e['id']: slugify(e['name'])[:40].rstrip('_') or f'emote_{e["id"]}' for e in emotes}
    count = Counter(base.values())
    out = {}
    for eid, s in base.items():
        if count[s] > 1:
            tail = f'_{eid}'
            s = s[:40 - len(tail)].rstrip('_') + tail
        out[eid] = s
    if len(set(out.values())) != len(out):
        raise ValueError('emote slugs are not unique')
    return out


# ---- gallery ----
# The gallery lists every emote with an effect. It bakes (animation + sound) the EMOTE_SET picks, the reaction-word
# matches and the faithful, non-esports specials; the rest show their still icon until picked.
# Reaction words: whole English words (plus GALLERY_SUFFIXES) or anywhere in the Chinese name.
GALLERY_KEYWORDS = ('gg', 'thank', 'sorry', 'laugh', 'lol', 'cry', 'sad', 'angry', 'mad', 'facepalm', 'thumbs', 'love',
                    'heart', 'wow', 'confused', 'sleep', 'bee', 'poro')
GALLERY_KEYWORDS_ZH = ('哭', '笑', '谢', '赞', '气', '爱', '弱', '晕')
GALLERY_SUFFIXES = ('', 's', 'y', 'ing', 'ed', 'ly', 'ful')
GALLERY_CAP = 120                    # reaction-word matches baked in the gallery
ESPORTS_PREFIX = 'assets/loadouts/summoneremotes/esports/'   # team and event emotes: hidden in the gallery by default
# Esports team and tournament emotes that match only through a team or event name (MAD Lions, "LCS: SR - GG", ...).
TEAM_TAG = re.compile(r'\b(MSI|Worlds)\b|^[A-Z]{2,6}: |\bLions\b|\bUnicorns\b')


def keyword_hits(name: str, name_zh: str) -> list[str]:
    words = set(re.findall(r'[a-z0-9]+', name.lower()))
    hits = [k for k in GALLERY_KEYWORDS if words & {k + s for s in GALLERY_SUFFIXES}]
    return hits + [k for k in GALLERY_KEYWORDS_ZH if k in name_zh]


def keyword_candidates(emotes: list[dict], zh: dict[int, str], has_effect) -> list[tuple[int, list[str]]]:
    """Keyword matches (id order), at most GALLERY_CAP. When there are more, they are taken round-robin over the
    keywords, so that every keyword stays represented. Returns (id, keyword hits)."""
    matches = [(e['id'], keyword_hits(e['name'], zh.get(e['id'], ''))) for e in sorted(emotes, key=lambda e: e['id'])
               if has_effect(e['id']) and not TEAM_TAG.search(e['name'])]
    hits = {eid: h for eid, h in matches if h}
    picked = []
    queues = [[eid for eid, h in hits.items() if k in h] for k in GALLERY_KEYWORDS + GALLERY_KEYWORDS_ZH]
    while len(picked) < GALLERY_CAP and any(queues):
        for q in queues:
            while q and q[0] in picked:
                q.pop(0)
            if q and len(picked) < GALLERY_CAP:
                picked.append(q.pop(0))
    return [(eid, hits[eid]) for eid in sorted(picked)]


def _bake_job(gw: Path, effect: BinFile, outs: list[tuple[Path, int]], poster: Path | None = None,
              glow_opacity: float | None = None) -> tuple[list[str], list[str]]:
    """Process-pool worker: renders the effect once (halo at glow_opacity) and writes it to each (path, alpha quality)
    in outs, plus a still at poster; with no outs it only audits. Returns (skipped properties, family_sounds)."""
    linked = linked_bins(gw, effect)
    textures = effect_textures(gw, [effect, *linked])
    if not outs:
        return audit(effect, linked, textures), family_sounds(effect, linked)
    frames, skipped = render(effect, linked, textures, glow_opacity=glow_opacity)
    for out, alpha_quality in outs:
        write_webp(frames, out, alpha_quality)
    if poster is not None:
        write_poster(frames, poster)
    return skipped, family_sounds(effect, linked)


def _pool():
    from concurrent.futures import ProcessPoolExecutor
    return ProcessPoolExecutor(max_workers=min(12, os.cpu_count() or 1))


def resolve_tools(vgmstream: str) -> str:
    """The vgmstream-cli path, after checking that it and ffmpeg exist."""
    found = shutil.which(vgmstream) or (str(Path(vgmstream).resolve()) if Path(vgmstream).is_file() else None)
    if found is None:
        raise SystemExit(f'vgmstream-cli not found: {vgmstream}')
    if shutil.which('ffmpeg') is None:
        raise SystemExit('ffmpeg not found on PATH')
    return found


def is_esports(emote: dict) -> bool:
    return emote_base(emote).startswith(ESPORTS_PREFIX)


def still_paths(emote: dict, effect: BinFile) -> list[str]:
    """Textures for an emote's still icon, best first (lower case): <base>_selector.tex, the selector named like the
    effect's own _VFX (or _Glow) texture, then that texture itself."""
    names = [s.lower() for s in effect.strings]
    art = next((s for s in names if s.endswith('_vfx.tex')), None)
    art = art or next((s for s in names if s.endswith('_glow.tex')), None)
    out = [f'{emote_base(emote)}_selector.tex']
    if art:
        out += [art.rsplit('_', 1)[0] + '_selector.tex', art]
    return list(dict.fromkeys(out))


def _stills_job(gw: Path, items: list[tuple[str, list[str]]], out_dir: Path) -> list[str]:
    """Process-pool worker: for each (file name, still_paths) writes out_dir/<file name> (PNG) from the first decodable
    texture. Returns the names written."""
    files = wad_read_some(gw, [p for _, paths in items for p in paths])
    done = []
    for name, paths in items:
        for p in paths:
            if p not in files:
                continue
            try:
                img = tex_to_png(files[p])
            except SystemExit:
                continue
            img.save(out_dir / name)
            done.append(name)
            break
    return done


def load_effects(league: Path) -> tuple[list[dict], dict[int, BinFile]]:
    """The client's emote list and the effect of every emote that has one."""
    gw = league / GLOBAL_WAD_REL
    emotes = load_emotes(league)
    effects = {}
    for e in emotes:
        try:
            effects[e['id']] = find_effect(gw, emote_base(e))
        except LookupError:
            pass
    return emotes, effects


def build_gallery(league: Path, out_dir: Path, vgmstream: str | None, ids: list[int] | None = None,
                  preset: dict | None = None, glow_opacity: float | None = None) -> Path:
    """Writes gallery.html and gallery.json into out_dir, listing every emote that has an effect (or just ids, all
    baked). It bakes the preset's emotes (extract_assets' EMOTE_SET, shown first and pre-ticked, with its wheel and
    centre), the reaction-word matches and the faithful non-esports specials: <id>.webp, <id>.poster.webp and <id>.ogg
    (choose_sound). Every listed emote gets <id>.icon.png. Media of emotes no longer baked are removed. preset is
    {'set': {slug: id}, 'wheel': [slug], 'click': slug}. Sounds are not decoded when vgmstream is None. The halos are
    drawn at glow_opacity (default GLOW_OPACITY)."""
    gw = league / GLOBAL_WAD_REL
    vgmstream = resolve_tools(vgmstream) if vgmstream else None
    emotes, effects = load_effects(league)
    by_id = {e['id']: e for e in emotes}
    zh = load_zh_names()
    slugs = emote_slugs(emotes)
    picked = dict(preset['set']) if preset and ids is None else {}
    slugs |= {eid: slug for slug, eid in picked.items()}
    missing = [eid for eid in list(ids or []) + list(picked.values()) if eid not in effects]
    if missing:
        raise SystemExit(f'no effect found for {missing}')
    listed = sorted(effects) if ids is None else list(dict.fromkeys(ids))
    keywords = dict(keyword_candidates(emotes, zh, effects.__contains__)) if ids is None else {}
    pinned = list(dict.fromkeys(picked.values())) if ids is None else listed     # always shown, even when esports
    out_dir.mkdir(parents=True, exist_ok=True)
    sounds = EmoteSounds(league)

    def bake_job(eid):
        return pool.submit(_bake_job, gw, effects[eid], [(out_dir / f'{eid}.webp', WEBP_ALPHA_QUALITY)],
                           out_dir / f'{eid}.poster.webp', glow_opacity)

    with _pool() as pool:
        jobs = {eid: bake_job(eid) for eid in dict.fromkeys(pinned + list(keywords))}   # the long jobs first
        audits = {eid: pool.submit(_bake_job, gw, effects[eid], []) for eid in listed if eid not in jobs}
        items = [(f'{eid}.icon.png', still_paths(by_id[eid], effects[eid])) for eid in listed]
        stills = [pool.submit(_stills_job, gw, items[k:k + 100], out_dir) for k in range(0, len(items), 100)]
        print(f'listing {len(listed)} emotes: baking {len(jobs)}, auditing {len(audits)} ...')
        results = {eid: f.result() for eid, f in audits.items()}
        if ids is None:                                              # the faithful, non-esports specials
            extra = [eid for eid in listed if eid in results and special_reason(effects[eid])
                     and not unfaithful(results[eid][0]) and not is_esports(by_id[eid])]
            jobs |= {eid: bake_job(eid) for eid in extra}
            print(f'baking {len(extra)} faithful non-esports specials too')
        for k, eid in enumerate(jobs, 1):
            results[eid] = jobs[eid].result()
            if k % 20 == 0 or k == len(jobs):
                print(f'  baked {k}/{len(jobs)}')
        icons = {name for f in stills for name in f.result()}
    cards = []
    for eid in list(jobs) + [eid for eid in listed if eid not in jobs]:
        e, (skipped, family) = by_id[eid], results[eid]
        event, source = choose_sound(e, effects[eid], family, sounds)
        baked = None
        if eid in jobs:
            webp, ogg = out_dir / f'{eid}.webp', out_dir / f'{eid}.ogg'
            if vgmstream:
                event, source = render_sound(f'{eid} {e["name"]}', e, effects[eid], family, sounds, ogg, vgmstream)
            else:
                ogg.unlink(missing_ok=True)
            has = ogg.is_file()
            baked = {'webp': webp.name, 'poster': f'{eid}.poster.webp', 'bytes': webp.stat().st_size,
                     'sha256': hashlib.sha256(webp.read_bytes()).hexdigest(), 'sound': ogg.name if has else None,
                     'soundBytes': ogg.stat().st_size if has else 0}
        group = ('Requested' if ids is not None else 'In EMOTE_SET (pool order)') if eid in pinned else (
            'Baked: animation and sound' if baked else 'Not baked yet: still icon')
        cards.append({'id': eid, 'baked': baked, 'name': e['name'], 'nameZh': zh.get(eid) or e['name'],
                      'slug': slugs[eid], 'pinned': eid in pinned, 'group': group, 'esports': is_esports(e),
                      'special': special_reason(effects[eid]), 'keywords': keywords.get(eid, []), 'soundEvent': event,
                      'soundSource': source, 'hasSound': source != SOUND_NONE,
                      'icon': f'{eid}.icon.png' if f'{eid}.icon.png' in icons else None, 'skipped': skipped,
                      'unfaithful': unfaithful(skipped)})
    keep = {c['id'] for c in cards if c['baked']}
    for f in out_dir.iterdir():                                      # media of emotes no longer baked
        m = re.fullmatch(r'(\d+)\.(webp|poster\.webp|ogg)', f.name)
        if m and int(m.group(1)) not in keep:
            f.unlink()
    (out_dir / 'gallery.json').write_text(json.dumps(cards, ensure_ascii=False, indent=1), encoding='utf-8')
    wheel = [picked[s] for s in preset['wheel'] if s in picked] if picked else []
    centre = picked.get(preset['click']) if picked else None
    page = write_gallery(out_dir, cards, {'picks': pinned if picked else [], 'wheel': wheel, 'centre': centre},
                         GLOW_OPACITY if glow_opacity is None else glow_opacity)
    print(gallery_stats(cards).replace('&middot;', '|'))
    return page


def _kb(n: float) -> str:
    return f'{n / 1024:.0f} KB'


def gallery_stats(cards: list[dict]) -> str:
    baked = [c['baked'] for c in cards if c['baked']]
    sizes = sorted(b['bytes'] for b in baked) or [0]
    return (f'{len(cards)} emotes listed ({sum(c["esports"] and not c["pinned"] for c in cards)} esports, hidden by '
            f'default) &middot; {len(baked)} baked &middot; {sum(bool(c["special"]) for c in cards)} special &middot; '
            f'{sum(bool(c["unfaithful"]) for c in cards)} not faithful &middot; baked WebP min {_kb(sizes[0])}, median '
            f'{_kb(statistics.median(sizes))}, max {_kb(sizes[-1])}, total {sum(sizes) / 1e6:.1f} MB &middot; '
            f'{sum(1 for b in baked if b["sound"])} baked sounds, {sum(b["soundBytes"] for b in baked) / 1e6:.1f} MB')


def write_gallery(out_dir: Path, cards: list[dict], preset: dict, glow_opacity: float = GLOW_OPACITY) -> Path:
    """gallery.html next to the media it shows (relative paths; serve the folder over HTTP). The cards are rendered
    in chunks by the page's script from the embedded data. preset ({'picks', 'wheel', 'centre'}, League ids) is ticked
    on first load, and again whenever it changes."""
    data = [{**{k: c[k] for k in ('id', 'name', 'nameZh', 'slug', 'pinned', 'group', 'esports', 'special', 'keywords',
                                  'soundEvent', 'soundSource', 'icon', 'unfaithful', 'baked')},
             'skippedCount': len(c['skipped']), 'skipped': c['skipped'] if c['baked'] else None} for c in cards]
    preset = {'picks': [str(i) for i in preset['picks']], 'wheel': ', '.join(str(i) for i in preset['wheel']),
              'centre': str(preset['centre'] or '')}
    preset['key'] = f"{','.join(preset['picks'])}|{preset['wheel']}|{preset['centre']}"
    page = (GALLERY_HTML.replace('@@STATS@@', gallery_stats(cards))
            .replace('@@DATA@@', script_json(data)).replace('@@PRESET@@', script_json(preset))
            .replace('@@DURATION_MS@@', str(int(DURATION * 1000))).replace('@@GLOW_OPACITY@@', f'{glow_opacity:g}'))
    path = out_dir / 'gallery.html'
    path.write_text(page, encoding='utf-8')
    return path


def script_json(v) -> str:
    """JSON that is safe inside a <script> element."""
    return json.dumps(v, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')


GALLERY_HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Emote Gallery</title>
<style>
:root { --bg: #f4f4f6; --fg: #1d1f24; --muted: #666a73; --card: #ffffff; --line: #d9dbe0; --accent: #2563eb;
  --bad: #b42318; --bad-bg: #fde8e6; --sp: #7a4cc2; --tile: #101114; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #15171b; --fg: #e8e9ec; --muted: #9a9ea8;
  --card: #1e2127; --line: #30343c; --accent: #6b9bff; --bad: #ff8a80; --bad-bg: #3a1d1b; --sp: #c3a3ff; } }
:root[data-theme="dark"] { --bg: #15171b; --fg: #e8e9ec; --muted: #9a9ea8; --card: #1e2127; --line: #30343c;
  --accent: #6b9bff; --bad: #ff8a80; --bad-bg: #3a1d1b; --sp: #c3a3ff; }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px 16px 200px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1400px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
.lead, .stats { color: var(--muted); margin: 0 0 8px; max-width: 960px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin: 12px 0; }
.toolbar input[type=search] { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); width: min(320px, 100%); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.grid h2.section { grid-column: 1 / -1; font-size: 16px; margin: 16px 0 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: flex;
  flex-direction: column; gap: 4px; min-width: 0; }
.card.picked { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent) inset; }
.tile { display: grid; place-items: center; width: 100%; aspect-ratio: 1; padding: 0; border: 0; border-radius: 8px;
  background: var(--tile); cursor: pointer; }
.tile.still { cursor: default; }
.tile img { width: 75%; height: 75%; object-fit: contain; }
.tile.still img { width: 55%; height: 55%; }
.names { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; }
.en { font-weight: 600; }
.zh { font-size: 15px; }
.meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
code { font-size: 12px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.tag.bad { color: var(--bad); background: var(--bad-bg); border-color: var(--bad); font-weight: 600; }
.tag.sp { color: var(--sp); border-color: var(--sp); }
.tag.dim { opacity: 0.6; }
.tag.fam { color: #b45309; border-color: #b45309; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); cursor: pointer; }
.nosound { color: var(--muted); font-size: 12px; }
.pick { margin-left: auto; cursor: pointer; }
details { font-size: 12px; color: var(--muted); }
details p { margin: 4px 0; overflow-wrap: anywhere; }
details ul { padding-left: 16px; margin: 4px 0; overflow-wrap: anywhere; }
details li.bad { color: var(--bad); }
#sentinel { height: 1px; }
.bar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--card); border-top: 1px solid var(--line);
  padding: 10px 16px; }
.bar .inner { max-width: 1400px; margin: 0 auto; display: grid; gap: 6px; }
.bar label { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.bar input[type=text] { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); color: var(--fg); flex: 1; min-width: 160px; }
.hint { color: var(--muted); font-size: 12px; }
.warn { color: var(--bad); }
</style></head>
<body><main>
<h1>Emote gallery</h1>
<p class="lead">Every emote with an effect file. The emotes in extract_assets.py's EMOTE_SET come first and start ticked,
with its default wheel and centre. Baked ones show a 320&times;320 animated WebP (3 s, 30 fps, played once) with the emote's
sound; click the tile or Play to replay (each play uses a fresh object URL). The rest show their still icon. The halo behind
an emote is drawn at @@GLOW_OPACITY@@&times; its opacity. <span class="tag bad">not faithful</span> means the baker skips
something that changes the look; <span class="tag sp">special</span> means an animated or non-template effect;
<span class="tag fam">family sound</span> means the emote has no sound of its own and plays its family template's.
To add emotes: tick them, copy the ids, and append <code>'slug': id</code> to EMOTE_SET (see the tool's README).</p>
<p class="stats">@@STATS@@</p>
<div class="toolbar">
  <input type="search" id="q" placeholder="Search name, 中文 or id">
  <label><input type="checkbox" id="bakedOnly"> Baked only</label>
  <label><input type="checkbox" id="specialOnly"> Animated/special only</label>
  <label><input type="checkbox" id="showEsports"> Show esports emotes</label>
  <label><input type="checkbox" id="hideBad"> Hide not faithful</label>
  <label><input type="checkbox" id="pickedOnly"> Picked only</label>
  <label>Tile <select id="tileBg"><option value="#101114">dark</option><option value="#6b705c">mid</option>
    <option value="#f2f2f2">light</option></select></label>
  <span class="hint" id="shown"></span>
</div>
<div class="grid" id="grid"></div>
<div id="sentinel"></div>
</main>
<div class="bar"><div class="inner">
  <label>Picked <strong id="pickCount">0</strong>: <input type="text" id="picks" readonly>
    <button type="button" id="copyPicks">Copy picked ids</button><button type="button" id="clearPicks">Clear</button></label>
  <label>Default wheel (8 ids, top then clockwise): <input type="text" id="wheel" placeholder="e.g. 4341, 3236, ...">
    Centre id: <input type="text" id="centre" style="max-width:120px;flex:0 1 120px"></label>
  <label><button type="button" id="copyAll">Copy selection</button><input type="text" id="line" readonly>
    <span class="hint" id="warn"></span></label>
</div></div>
<script type="application/json" id="data">@@DATA@@</script>
<script type="application/json" id="preset">@@PRESET@@</script>
<script>
const DURATION_MS = @@DURATION_MS@@, CHUNK = 120, KEY = 'lolping-emote-gallery';
const DATA = JSON.parse(document.getElementById('data').textContent);
const byId = new Map(DATA.map(d => [String(d.id), d]));
const order = new Map(DATA.map((d, i) => [String(d.id), i]));
for (const d of DATA) d.search = [d.name, d.nameZh, d.id, d.slug].join(' ').toLowerCase();
const $ = id => document.getElementById(id);
const grid = $('grid');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kb = n => Math.round(n / 1024) + ' KB';
const PRESET = JSON.parse(document.getElementById('preset').textContent);
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
if (saved.preset !== PRESET.key) saved = { picks: PRESET.picks, wheel: PRESET.wheel, centre: PRESET.centre };
const picks = new Set((saved.picks || []).map(String).filter(id => byId.has(id)));
$('wheel').value = saved.wheel || '';
$('centre').value = saved.centre || '';
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ preset: PRESET.key, picks: [...picks], wheel: $('wheel').value, centre: $('centre').value })); } catch (e) {}
}
const ids = text => (text.match(/\d+/g) || []);
const orderedPicks = () => [...picks].sort((a, b) => order.get(a) - order.get(b));
function cardHtml(d) {
  const b = d.baked, tags = [];
  if (d.unfaithful.length) tags.push('<span class="tag bad">not faithful</span>');
  if (d.special) tags.push(`<span class="tag sp" title="${esc(d.special)}">special</span>`);
  if (d.esports) tags.push('<span class="tag">esports</span>');
  tags.push(d.soundSource === 'own' ? '<span class="tag">sound</span>' : d.soundSource === 'family'
    ? '<span class="tag fam" title="no sound of its own: plays its family template sound">family sound</span>' : '<span class="tag dim">no sound</span>');
  for (const k of d.keywords) tags.push(`<span class="tag">${esc(k)}</span>`);
  const tile = b ? `<button type="button" class="tile" data-act="play" title="Play"><img src="${esc(b.poster)}" alt="" loading="lazy"></button>`
    : `<div class="tile still">${d.icon ? `<img src="${esc(d.icon)}" alt="" loading="lazy">` : ''}</div>`;
  const size = b ? `WebP ${kb(b.bytes)}${b.sound ? ' &middot; .ogg ' + kb(b.soundBytes) : ''}` : 'not baked';
  const play = b ? '<button type="button" data-act="play">Play</button>'
    + (b.sound ? '<button type="button" data-act="sound">Sound</button>' : '<span class="nosound">no sound</span>') : '';
  const list = (d.skipped || d.unfaithful).map(s => `<li class="${d.unfaithful.includes(s) ? 'bad' : ''}">${esc(s)}</li>`).join('');
  return `<article class="card" data-id="${d.id}">${tile}
<div class="names"><span class="en">${esc(d.name)}</span><span class="zh">${esc(d.nameZh)}</span></div>
<div class="meta">#${d.id} &middot; <code>${esc(d.slug)}</code></div>
<div class="meta">${size} &middot; ${d.skippedCount} skipped</div>
<div class="tags">${tags.join('')}</div>
<div class="row">${play}<label class="pick"><input type="checkbox" data-act="pick"> Pick</label></div>
<div class="row"><button type="button" data-act="wheel">+ Wheel</button><button type="button" data-act="centre">Centre</button></div>
<details><summary>details</summary><p>${d.special ? 'special: ' + esc(d.special) + '<br>' : ''}sound event: ${esc(d.soundEvent || 'none')}</p>
${list ? `<ul>${list}</ul>` : ''}</details></article>`;
}
function visible(d) {
  const q = $('q').value.trim().toLowerCase();
  return !(q && !d.search.includes(q)) && ($('showEsports').checked || !d.esports || d.pinned)
    && !($('bakedOnly').checked && !d.baked) && !($('specialOnly').checked && !d.special)
    && !($('hideBad').checked && d.unfaithful.length) && !($('pickedOnly').checked && !picks.has(String(d.id)));
}
let list = [], shown = 0, lastGroup = null;
function rebuild() {
  list = DATA.filter(visible); shown = 0; lastGroup = null; grid.textContent = '';
  $('shown').textContent = `showing ${list.length} of ${DATA.length}`;
  more();
}
function more() {
  const end = Math.min(list.length, shown + CHUNK);
  let html = '';
  for (; shown < end; shown++) {
    const d = list[shown], g = d.group;
    if (g !== lastGroup) { html += `<h2 class="section">${g}</h2>`; lastGroup = g; }
    html += cardHtml(d);
  }
  grid.insertAdjacentHTML('beforeend', html);
  for (const c of grid.querySelectorAll('.card:not([data-ready])')) {
    c.dataset.ready = '1'; sync(c);
    if (byId.get(c.dataset.id).baked) autoplay.observe(c);
  }
  requestAnimationFrame(() => { if (shown < list.length && $('sentinel').getBoundingClientRect().top < innerHeight + 800) more(); });
}
function sync(c) {
  const on = picks.has(c.dataset.id);
  c.classList.toggle('picked', on);
  c.querySelector('[data-act=pick]').checked = on;
}
function refresh() {
  grid.querySelectorAll('.card').forEach(sync);
  const chosen = orderedPicks();
  $('pickCount').textContent = chosen.length;
  $('picks').value = chosen.join(',');
  const wheel = ids($('wheel').value), centre = ids($('centre').value)[0] || '';
  $('line').value = `pick: ${chosen.join(',')} | wheel: ${wheel.join(',')} | centre: ${centre}`;
  const warn = [];
  if (wheel.length !== 8) warn.push(`wheel has ${wheel.length} of 8`);
  const outside = [...wheel, centre].filter(id => id && !picks.has(id));
  if (outside.length) warn.push(`not picked: ${outside.join(',')}`);
  if (!centre) warn.push('no centre');
  $('warn').textContent = warn.join(' · ');
  $('warn').classList.toggle('warn', warn.length > 0);
  persist();
}
const media = new Map();
async function play(card, withSound) {
  const id = card.dataset.id, d = byId.get(id);
  let m = media.get(id);
  if (!m) { m = { blob: null, url: null, timer: 0 }; media.set(id, m); }
  if (!m.blob) m.blob = await (await fetch(d.baked.webp)).blob();
  const img = card.querySelector('.tile img');
  clearTimeout(m.timer);
  if (m.url) URL.revokeObjectURL(m.url);
  m.url = URL.createObjectURL(m.blob);
  img.src = m.url;
  m.timer = setTimeout(() => { img.src = d.baked.poster; URL.revokeObjectURL(m.url); m.url = null; }, DURATION_MS + 200);
  if (withSound) sound(card);
}
function sound(card) {
  const b = byId.get(card.dataset.id).baked;
  if (b && b.sound) new Audio(b.sound).play().catch(() => {});
}
async function copy(text, button) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  const label = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1200);
}
grid.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]'), card = ev.target.closest('.card');
  if (!el || !card) return;
  const id = card.dataset.id, act = el.dataset.act;
  if (act === 'play') play(card, true);
  else if (act === 'sound') sound(card);
  else if (act === 'pick') { if (el.checked) picks.add(id); else picks.delete(id); refresh(); }
  else if (act === 'wheel') {
    const wheel = ids($('wheel').value);
    if (!wheel.includes(id) && wheel.length < 8) wheel.push(id);
    $('wheel').value = wheel.join(', '); picks.add(id); refresh();
  } else if (act === 'centre') { $('centre').value = id; picks.add(id); refresh(); }
});
let qTimer = 0;
$('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(rebuild, 150); });
for (const id of ['bakedOnly', 'specialOnly', 'showEsports', 'hideBad', 'pickedOnly']) $(id).addEventListener('input', rebuild);
for (const id of ['wheel', 'centre']) $(id).addEventListener('input', refresh);
$('tileBg').addEventListener('input', () => document.documentElement.style.setProperty('--tile', $('tileBg').value));
$('copyPicks').addEventListener('click', ev => copy(orderedPicks().join(','), ev.target));
$('copyAll').addEventListener('click', ev => { refresh(); copy($('line').value, ev.target); });
$('clearPicks').addEventListener('click', () => { if (confirm('Clear all picks?')) { picks.clear(); refresh(); if ($('pickedOnly').checked) rebuild(); } });
const played = new Set();
const autoplay = new IntersectionObserver(entries => {
  for (const en of entries) if (en.isIntersecting) {
    autoplay.unobserve(en.target);
    if (!played.has(en.target.dataset.id)) { played.add(en.target.dataset.id); play(en.target, false); }
  }
}, { threshold: 0.6 });
new IntersectionObserver(es => { if (es.some(e => e.isIntersecting) && shown < list.length) more(); }, { rootMargin: '800px' })
  .observe($('sentinel'));
rebuild();
refresh();
</script>
</body></html>
'''




# ---- the bundled set (extract_assets.py --emotes) ----
SLUG_RE = re.compile(r'[a-z0-9_]{1,40}')
CATALOG_HEADER = '// Generated by tools/extract-assets (--emotes). Do not edit by hand.'


def check_emote_set(emote_set: dict[str, int], wheel: list[str], click: str,
                    name_overrides: dict[str, tuple[str, str]] | None = None) -> None:
    """Slugs match SLUG_RE, League ids are unique, the wheel is 8 distinct slugs of the set and the centre is one too,
    and so is every slug in name_overrides."""
    problems = [f'bad slug {s!r}' for s in emote_set if not SLUG_RE.fullmatch(s)]
    ids = list(emote_set.values())
    problems += [f'League id {i} appears twice' for i in sorted({i for i in ids if ids.count(i) > 1})]
    if len(wheel) != 8 or len(set(wheel)) != 8:
        problems.append('the default wheel needs 8 distinct slugs')
    problems += [f'{s!r} is not in EMOTE_SET' for s in [*wheel, click, *(name_overrides or {})] if s not in emote_set]
    if problems:
        raise SystemExit('EMOTE_SET: ' + '; '.join(problems))


def ts_str(s: str) -> str:
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def write_catalog(path: Path, entries: list[dict], wheel: list[str], click: str,
                  name_overrides: dict[str, tuple[str, str]] | None = None) -> None:
    """src/shared/emoteCatalog.ts: EMOTE_CATALOG (in pool order), DEFAULT_EMOTE_WHEEL and DEFAULT_CLICK_EMOTE. An entry's
    name and nameZh are replaced by name_overrides[slug] = (name, nameZh) where there is one."""
    name_overrides = name_overrides or {}
    lines = [CATALOG_HEADER,
             'export interface CatalogEmote { slug: string; leagueId: number; name: string; nameZh: string; hasSound: boolean }',
             'export const EMOTE_CATALOG: readonly CatalogEmote[] = [']
    for e in entries:
        name, name_zh = name_overrides.get(e['slug'], (e['name'], e['nameZh']))
        lines.append(f"  {{ slug: {ts_str(e['slug'])}, leagueId: {e['leagueId']}, name: {ts_str(name)}, "
                     f"nameZh: {ts_str(name_zh)}, hasSound: {'true' if e['hasSound'] else 'false'} }},")
    lines += ['];', 'export const DEFAULT_EMOTE_WHEEL: readonly string[] = [',
              *[f'  {ts_str(s)},' for s in wheel], '];', f'export const DEFAULT_CLICK_EMOTE = {ts_str(click)};']
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')


def bake_set(league: Path, vgmstream: str, emote_set: dict[str, int], out_dir: Path, zh: dict[int, str],
             glow_opacity: float | None = None) -> list[dict]:
    """Bakes every entry of emote_set (in order) into out_dir: <slug>.webp (alpha quality WEBP_ALPHA_QUALITY), <slug>.png
    (the _selector icon) and <slug>.ogg (render_sound; removed when there is none). zh maps League ids to Chinese names.
    Returns one dict per entry. The halos are drawn at glow_opacity (default GLOW_OPACITY)."""
    gw = league / GLOBAL_WAD_REL
    vgmstream = resolve_tools(vgmstream)
    emotes, effects = load_effects(league)
    by_id = {e['id']: e for e in emotes}
    missing = [i for i in emote_set.values() if i not in effects]
    if missing:
        raise SystemExit(f'no effect found for {missing}')
    out_dir.mkdir(parents=True, exist_ok=True)
    sounds = EmoteSounds(league)
    with _pool() as pool:
        jobs = {slug: pool.submit(_bake_job, gw, effects[eid], [(out_dir / f'{slug}.webp', WEBP_ALPHA_QUALITY)], None,
                                  glow_opacity)
                for slug, eid in emote_set.items()}
        stills = pool.submit(_stills_job, gw, [(f'{slug}.png', still_paths(by_id[eid], effects[eid]))
                                              for slug, eid in emote_set.items()], out_dir)
        results = {slug: f.result() for slug, f in jobs.items()}
        pngs = set(stills.result())
    entries = []
    for slug, eid in emote_set.items():
        skipped, family = results[slug]
        ogg = out_dir / f'{slug}.ogg'
        event, source = render_sound(f'{slug} ({eid})', by_id[eid], effects[eid], family, sounds, ogg, vgmstream)
        has = source != SOUND_NONE
        entries.append({'slug': slug, 'leagueId': eid, 'name': by_id[eid]['name'], 'nameZh': zh[eid],
                        'hasSound': has, 'soundEvent': event, 'soundSource': source,
                        'png': f'{slug}.png' if f'{slug}.png' in pngs else None,
                        'bytes': (out_dir / f'{slug}.webp').stat().st_size,
                        'pngBytes': (out_dir / f'{slug}.png').stat().st_size if f'{slug}.png' in pngs else 0,
                        'oggBytes': ogg.stat().st_size if has else 0, 'skipped': skipped, 'unfaithful': unfaithful(skipped)})
    return entries


def write_emotes(league: Path, vgmstream: str, emote_set: dict[str, int], wheel: list[str], click: str,
                 out_dir: Path, catalog: Path, name_overrides: dict[str, tuple[str, str]] | None = None,
                 glow_opacity: float | None = None) -> list[dict]:
    """--emotes: assets/emotes/<slug>.webp (WEBP_ALPHA_QUALITY), .png and .ogg for every EMOTE_SET entry, any other file
    in out_dir removed, then src/shared/emoteCatalog.ts (with name_overrides applied: slug -> (name, nameZh)). Stops
    before baking when the Chinese names (load_zh_names) lack an entry or two emotes would share a name, and afterwards
    when an entry lacks its .webp or .png."""
    name_overrides = name_overrides or {}
    check_emote_set(emote_set, wheel, click, name_overrides)
    zh = load_zh_names(required=True)
    no_zh = sorted(i for i in emote_set.values() if i not in zh)
    if no_zh:
        raise SystemExit(f'Chinese emote names lack the League ids {no_zh}: download {ZH_NAMES_URL} again and save it as '
                         f'{CACHE / ZH_NAMES_FILE}')
    by_id = {e['id']: e for e in load_emotes(league)}
    unknown = sorted(i for i in emote_set.values() if i not in by_id)
    if unknown:
        raise SystemExit(f'no emotes with the League ids {unknown}')
    names = [name_overrides.get(slug, (by_id[eid]['name'], zh[eid])) for slug, eid in emote_set.items()]
    for lang, field in enumerate(('name', 'nameZh')):
        values = [n[lang] for n in names]
        same = sorted({v for v in values if values.count(v) > 1})
        if same:
            raise SystemExit(f'emotes share the {field} {same}: give each its own in NAME_OVERRIDES')
    entries = bake_set(league, vgmstream, emote_set, out_dir, zh, glow_opacity)
    expected = {f'{e["slug"]}.{ext}' for e in entries for ext in ('webp', 'png', *(['ogg'] if e['hasSound'] else []))}
    for f in sorted(out_dir.iterdir()):
        if f.name not in expected:
            f.unlink()
    lacking = sorted(n for n in expected if not (out_dir / n).is_file())
    if lacking:
        raise SystemExit(f'missing outputs: {lacking}')
    write_catalog(catalog, entries, wheel, click, name_overrides)
    total = sum(f.stat().st_size for f in out_dir.iterdir())
    for e in entries:
        print(f'{e["leagueId"]:>5} {e["slug"]:<22} {e["bytes"] // 1024:>4} KB  sound: {e["soundSource"]:<6}'
              f' {e["soundEvent"] or ""}{"  NOT FAITHFUL" if e["unfaithful"] else ""}')
    print(f'{len(entries)} emotes, {len(expected)} files, {total / 1e6:.1f} MB in {out_dir}; catalog: {catalog}')
    return entries


def cmd_bake(league: Path, emote_ids: list[int], out_dir: Path, vgmstream: str | None,
             glow_opacity: float | None = None) -> None:
    print('gallery:', build_gallery(league, out_dir, vgmstream, emote_ids, glow_opacity=glow_opacity))


def main() -> None:
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    d = sub.add_parser('dump', help="print an emote's effect file and linked templates as JSON")
    d.add_argument('--league', type=Path, required=True)
    d.add_argument('--emote', type=int, required=True)
    s = sub.add_parser('specials', help='list emotes whose effect is outside the three motion families')
    s.add_argument('--league', type=Path, required=True)
    so = sub.add_parser('sounds', help='scan the Wwise banks for emote sound events')
    so.add_argument('--league', type=Path, required=True)
    so.add_argument('--emote', type=int, action='append', default=[])
    b = sub.add_parser('bake', help='bake emotes to WebP (+ .ogg) and write a gallery.html of them')
    b.add_argument('--league', type=Path, required=True)
    b.add_argument('--emote', type=int, action='append', required=True)
    b.add_argument('--out', type=Path, default=Path(tempfile.gettempdir()) / 'lolping-emote-bake')
    b.add_argument('--vgmstream', help='path to vgmstream-cli.exe (sounds are skipped without it)')
    b.add_argument('--glow-opacity', type=float, help=f'halo opacity for this run (default {GLOW_OPACITY:g})')
    args = ap.parse_args()
    if args.cmd == 'dump':
        gw = args.league / GLOBAL_WAD_REL
        names = load_names(CACHE)
        e = emote_by_id(args.league, args.emote)
        eff = find_effect(gw, emote_base(e))
        out = {'emote': {'id': e['id'], 'name': e['name'], 'base': emote_base(e)}, 'effect': bin_json(eff, names),
               'linkedFiles': {p: bin_json(lb, names) for p, lb in zip(eff.linked, linked_bins(gw, eff))}}
        print(json.dumps(out, indent=1, ensure_ascii=False))
    elif args.cmd == 'specials':
        cmd_specials(args.league)
    elif args.cmd == 'sounds':
        cmd_sounds(args.league, args.emote)
    elif args.cmd == 'bake':
        cmd_bake(args.league, args.emote, args.out, args.vgmstream, args.glow_opacity)


if __name__ == '__main__':
    main()
