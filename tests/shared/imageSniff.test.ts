import { describe, expect, it } from 'vitest';
import { gifExtent, gifSize, imageSize, isAnimatedWebp, sniffImage, webpSize } from '../../src/shared/imageSniff';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const bytes = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());

/** RIFF header plus one chunk header; the chunk size and file size are filler, only the layout matters. */
const webpHead = (fourcc: string): number[][] => [ascii('RIFF'), le32(1000), ascii('WEBP'), ascii(fourcc), le32(900)];

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13]);
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 16]);
const WEBP_LOSSY = (w: number, h: number) =>
  bytes(...webpHead('VP8 '), [0x30, 0x01, 0x00], [0x9d, 0x01, 0x2a], le16(w), le16(h));
const WEBP_LOSSLESS = (w: number, h: number) =>
  bytes(...webpHead('VP8L'), [0x2f], le32((w - 1) | ((h - 1) << 14)));
/** `flags` is the VP8X flags byte: 0x10 is alpha, 0x02 is animation. */
const WEBP_EXTENDED = (w: number, h: number, flags = 0x10) =>
  bytes(...webpHead('VP8X'), [flags, 0, 0, 0], le24(w - 1), le24(h - 1));
const GIF = (magic: string, w: number, h: number) => bytes(ascii(magic), le16(w), le16(h), [0xf7, 0, 0]);

describe('sniffImage', () => {
  it('recognises the four formats by their magic bytes', () => {
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(JPEG)).toBe('jpeg');
    expect(sniffImage(GIF('GIF87a', 1, 1))).toBe('gif');
    expect(sniffImage(GIF('GIF89a', 1, 1))).toBe('gif');
    expect(sniffImage(WEBP_LOSSY(10, 10))).toBe('webp');
  });

  it('returns null for anything else', () => {
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(bytes(ascii('hello world, not an image')))).toBeNull();
    expect(sniffImage(bytes(ascii('RIFF'), le32(10), ascii('WAVE')))).toBeNull(); // RIFF, but not WebP
    expect(sniffImage(bytes([0xff, 0xd8]))).toBeNull(); // JPEG needs all three bytes
    expect(sniffImage(bytes(ascii('GIF90a')))).toBeNull();
    expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG needs the whole signature
  });
});

describe('webpSize', () => {
  it('reads a lossy (VP8) header', () => {
    expect(webpSize(WEBP_LOSSY(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it('ignores the scale bits of a VP8 size', () => {
    expect(webpSize(WEBP_LOSSY(0x4000 | 100, 0x8000 | 50))).toEqual({ width: 100, height: 50 });
  });

  it('reads a lossless (VP8L) header', () => {
    expect(webpSize(WEBP_LOSSLESS(320, 240))).toEqual({ width: 320, height: 240 });
    expect(webpSize(WEBP_LOSSLESS(16384, 1))).toEqual({ width: 16384, height: 1 });
  });

  it('reads an extended (VP8X) header, the kind animations use', () => {
    expect(webpSize(WEBP_EXTENDED(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(webpSize(WEBP_EXTENDED(70000, 3))).toEqual({ width: 70000, height: 3 });
  });

  it('returns null for a truncated header', () => {
    for (const full of [WEBP_LOSSY(10, 10), WEBP_LOSSLESS(10, 10), WEBP_EXTENDED(10, 10)]) {
      expect(webpSize(full.slice(0, full.length - 1))).toBeNull();
      expect(webpSize(full.slice(0, 20))).toBeNull();
      expect(webpSize(full.slice(0, 11))).toBeNull();
    }
    expect(webpSize(new Uint8Array())).toBeNull();
  });

  it('returns null for something that is not a WebP, or has no known chunk', () => {
    expect(webpSize(PNG)).toBeNull();
    expect(webpSize(bytes(...webpHead('ALPH'), new Array<number>(20).fill(0)))).toBeNull();
    expect(webpSize(bytes(...webpHead('VP8 '), [0, 0, 0], [1, 2, 3], le16(10), le16(10)))).toBeNull(); // no start code
    expect(webpSize(bytes(...webpHead('VP8L'), [0x00], le32(0)))).toBeNull(); // no VP8L signature
  });
});

describe('gifSize', () => {
  it('reads the little-endian logical screen size', () => {
    expect(gifSize(GIF('GIF89a', 320, 240))).toEqual({ width: 320, height: 240 });
    expect(gifSize(GIF('GIF87a', 1000, 513))).toEqual({ width: 1000, height: 513 });
  });

  it('returns null for a truncated header or a different format', () => {
    expect(gifSize(GIF('GIF89a', 10, 10).slice(0, 9))).toBeNull();
    expect(gifSize(PNG)).toBeNull();
    expect(gifSize(new Uint8Array())).toBeNull();
  });
});

describe('isAnimatedWebp', () => {
  it('is true when the VP8X animation flag is set', () => {
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0x02))).toBe(true);
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0x12))).toBe(true); // animated, with alpha
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0xff))).toBe(true);
  });

  it('is false for a static extended WebP, with or without alpha, metadata or an ICC profile', () => {
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0x00))).toBe(false);
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0x10))).toBe(false); // alpha
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0x2c))).toBe(false); // ICC, EXIF, XMP
    expect(isAnimatedWebp(WEBP_EXTENDED(160, 120, 0xfd))).toBe(false); // everything but animation
  });

  it('is false for simple lossy and lossless WebPs, which cannot animate', () => {
    expect(isAnimatedWebp(WEBP_LOSSY(160, 120))).toBe(false);
    expect(isAnimatedWebp(WEBP_LOSSLESS(160, 120))).toBe(false);
  });

  it('is false for a truncated header, other formats and nothing', () => {
    const animated = WEBP_EXTENDED(160, 120, 0x02);
    expect(isAnimatedWebp(animated.slice(0, 20))).toBe(false); // the flags byte is the 21st
    expect(isAnimatedWebp(animated.slice(0, 21))).toBe(true);
    expect(isAnimatedWebp(PNG)).toBe(false);
    expect(isAnimatedWebp(GIF('GIF89a', 10, 10))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array())).toBe(false);
  });
});

/** A PNG signature, then the IHDR chunk (length, type, width and height as big-endian 32 bits, depth, colour type...). */
const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const PNG_SIZED = (w: number, h: number) =>
  bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii('IHDR'), be32(w), be32(h), [8, 6, 0, 0, 0]);
/** A JPEG segment: marker, then a length that counts itself and the payload. */
const seg = (marker: number, payload: number[]): number[] => [0xff, marker, ...be16(payload.length + 2), ...payload];
/** A start-of-frame segment: 8-bit samples, then height, width and three components. */
const sof = (marker: number, w: number, h: number): number[] =>
  seg(marker, [8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const SOI = [0xff, 0xd8];
const JPEG_SIZED = (w: number, h: number, marker = 0xc0, before: number[][] = [seg(0xe0, ascii('JFIF\0').concat([1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xdb, new Array<number>(65).fill(1))]) =>
  bytes(SOI, ...before, sof(marker, w, h), seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), [1, 2, 3]);

describe('imageSize', () => {
  it('reads a PNG from its IHDR, all 32 bits of it', () => {
    expect(imageSize(PNG_SIZED(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(PNG_SIZED(30000, 30000))).toEqual({ width: 30000, height: 30000 });
    expect(imageSize(PNG_SIZED(0x8000_0000, 1))).toEqual({ width: 0x8000_0000, height: 1 }); // no sign trouble
  });

  it('reads a PNG only when the first chunk is a complete IHDR', () => {
    expect(imageSize(PNG)).toBeNull(); // signature and a length, no chunk
    expect(imageSize(PNG_SIZED(10, 10).slice(0, 23))).toBeNull();
    expect(imageSize(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), ascii('IDAT'), be32(10), be32(10)))).toBeNull();
    expect(imageSize(PNG_SIZED(0, 10))).toBeNull();
    expect(imageSize(PNG_SIZED(10, 0))).toBeNull();
  });

  it('reads a GIF and a WebP of any kind', () => {
    expect(imageSize(GIF('GIF89a', 320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(WEBP_LOSSY(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(WEBP_LOSSLESS(320, 240))).toEqual({ width: 320, height: 240 });
    expect(imageSize(WEBP_EXTENDED(30000, 20000))).toEqual({ width: 30000, height: 20000 });
  });

  it('reads a JPEG from its start-of-frame, baseline or progressive', () => {
    expect(imageSize(JPEG_SIZED(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(JPEG_SIZED(30000, 20000, 0xc2))).toEqual({ width: 30000, height: 20000 }); // progressive
    expect(imageSize(JPEG_SIZED(65535, 65535, 0xc1))).toEqual({ width: 65535, height: 65535 }); // extended sequential
    expect(imageSize(JPEG_SIZED(100, 50, 0xc9))).toEqual({ width: 100, height: 50 }); // arithmetic coded
  });

  it('skips over other segments, including a thumbnail with a frame of its own', () => {
    const thumb = seg(0xe1, [...ascii('Exif\0\0'), ...sof(0xc0, 4000, 3000)]); // a SOF inside an APP1 payload is not the image
    expect(imageSize(JPEG_SIZED(640, 480, 0xc0, [thumb, seg(0xc4, new Array<number>(20).fill(0))]))).toEqual({ width: 640, height: 480 });
    // A define-huffman-table (C4), define-arithmetic (CC) and JPG (C8) marker have the same high bits as a SOF but are not one.
    expect(imageSize(bytes(SOI, seg(0xc4, [1, 2, 3, 4, 5, 6, 7, 8, 9]), seg(0xcc, [1, 2, 3, 4, 5, 6, 7, 8, 9]), seg(0xc8, [1, 2, 3, 4, 5, 6, 7, 8, 9])))).toBeNull();
  });

  it('tolerates fill bytes and stray bytes between segments, as JPEG decoders do', () => {
    const body = bytes(SOI, [0xff, 0xff, 0xff], seg(0xe0, [1, 2, 3, 4]), [0x00, 0x00], [0xff, 0x00], seg(0xdb, [1, 2, 3]), [0xff, 0x01], [0xff, 0xd0], sof(0xc0, 77, 33));
    expect(imageSize(body)).toEqual({ width: 77, height: 33 });
  });

  it('returns null for a JPEG with no frame header before its scan, a truncated one or an empty one', () => {
    expect(imageSize(JPEG)).toBeNull(); // FF D8 FF E0, length 16, nothing more
    expect(imageSize(bytes(SOI, seg(0xda, [1, 2, 3])))).toBeNull();
    expect(imageSize(bytes(SOI, [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01]))).toBeNull(); // cut off inside the SOF
    expect(imageSize(bytes(SOI, [0xff, 0xe0, 0x00, 0x01]))).toBeNull(); // a length too small to be a length
    expect(imageSize(bytes(SOI, [0xff, 0xe0, 0xff, 0xff, 1, 2, 3]))).toBeNull(); // a length that runs off the end
    expect(imageSize(JPEG_SIZED(0, 100))).toBeNull(); // a height of 0 is defined later by a DNL marker
    expect(imageSize(JPEG_SIZED(100, 0))).toBeNull();
    expect(imageSize(bytes(SOI))).toBeNull();
  });

  it('returns null for anything that is not an image', () => {
    expect(imageSize(new Uint8Array())).toBeNull();
    expect(imageSize(bytes(ascii('just some text, renamed .png')))).toBeNull();
  });
});

/** One frame of a GIF: its image descriptor rectangle, a local colour table of 2^(lct + 1) entries when lct is given, and some data. */
interface Frame { left?: number; top?: number; w: number; h: number; lct?: number; data?: number[][] }
/**
 * A GIF built block by block: header, logical screen, a global colour table of 2^(gct + 1) entries when gct is given, then for
 * each frame a graphic control extension, the image descriptor, its colour table and LZW sub-blocks, then the trailer.
 */
const GIF_BLOCKS = (sw: number, sh: number, frames: Frame[], opts: { gct?: number; trailer?: boolean; comment?: number[] } = {}): Uint8Array => {
  const table = (n: number | undefined): number[] => (n === undefined ? [] : new Array<number>(3 * 2 ** (n + 1)).fill(0x2c));
  const subBlocks = (blocks: number[][]): number[] => [...blocks.flatMap((b) => [b.length, ...b]), 0];
  return bytes(
    ascii('GIF89a'), le16(sw), le16(sh), [opts.gct === undefined ? 0 : 0x80 | opts.gct, 0, 0], table(opts.gct),
    opts.comment ? [0x21, 0xfe, ...subBlocks([opts.comment, opts.comment])] : [],
    ...frames.flatMap((f) => [
      [0x21, 0xf9, ...subBlocks([[0, 0, 0, 0]])],
      [0x2c, ...le16(f.left ?? 0), ...le16(f.top ?? 0), ...le16(f.w), ...le16(f.h), f.lct === undefined ? 0 : 0x80 | f.lct],
      table(f.lct),
      [2, ...subBlocks(f.data ?? [[0x2c, 0x21, 0x3b, 0x2c, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0]])], // bytes that look like blocks, but are data
    ]),
    opts.trailer === false ? [] : [0x3b],
  );
};

describe('gifExtent', () => {
  it('is the logical screen for a GIF whose frames fit in it', () => {
    expect(gifExtent(GIF_BLOCKS(320, 240, [{ w: 320, h: 240 }]))).toEqual({ width: 320, height: 240 });
    expect(gifExtent(GIF_BLOCKS(320, 240, [{ w: 100, h: 100, left: 20, top: 40 }, { w: 320, h: 240 }]))).toEqual({ width: 320, height: 240 });
    expect(gifExtent(GIF_BLOCKS(320, 240, []))).toEqual({ width: 320, height: 240 });
    expect(gifExtent(GIF('GIF89a', 320, 240))).toEqual(gifSize(GIF('GIF89a', 320, 240))); // just a header
  });

  it('is the reach of a frame that is larger than the screen, which is what decoders draw', () => {
    expect(gifExtent(GIF_BLOCKS(1, 1, [{ w: 100, h: 100 }]))).toEqual({ width: 100, height: 100 });
    expect(gifExtent(GIF_BLOCKS(1, 1, [{ w: 9000, h: 9000 }]))).toEqual({ width: 9000, height: 9000 });
    expect(gifExtent(GIF_BLOCKS(1, 1, [{ w: 30000, h: 30000 }]))).toEqual({ width: 30000, height: 30000 });
    expect(gifExtent(GIF_BLOCKS(120, 80, [{ w: 50, h: 10, left: 100, top: 0 }]))).toEqual({ width: 150, height: 80 }); // far edge, not size
    expect(gifExtent(GIF_BLOCKS(120, 80, [{ w: 10, h: 10 }, { w: 10, h: 10, left: 65000, top: 60000 }]))).toEqual({ width: 65010, height: 60010 });
  });

  it('takes the largest reach over every frame, in each direction on its own', () => {
    const frames: Frame[] = [{ w: 10, h: 500 }, { w: 400, h: 10 }, { w: 5, h: 5, left: 20, top: 20 }];
    expect(gifExtent(GIF_BLOCKS(50, 50, frames))).toEqual({ width: 400, height: 500 });
  });

  it('measures a frame when the logical screen is 0 x 0', () => {
    expect(gifExtent(GIF_BLOCKS(0, 0, [{ w: 64, h: 48 }]))).toEqual({ width: 64, height: 48 });
    expect(gifExtent(GIF_BLOCKS(0, 0, []))).toBeNull();
    expect(gifExtent(GIF_BLOCKS(0, 0, [{ w: 0, h: 0 }]))).toBeNull();
  });

  it('skips colour tables, extensions and data by their lengths, whatever the data looks like', () => {
    for (const gct of [undefined, 0, 3, 7]) {
      for (const lct of [undefined, 0, 7]) {
        const frames: Frame[] = [{ w: 20, h: 20, lct }, { w: 300, h: 200, lct, data: [[0x2c, 0x2c, 0x2c], new Array<number>(255).fill(0x3b)] }];
        const gif = GIF_BLOCKS(10, 10, frames, { gct, comment: [0x2c, 0x21, 0x3b] });
        expect(gifExtent(gif), `gct ${gct} lct ${lct}`).toEqual({ width: 300, height: 200 });
      }
    }
  });

  it('stops at the trailer, ignoring whatever follows it', () => {
    const gif = GIF_BLOCKS(10, 10, [{ w: 20, h: 20 }]);
    const after = bytes(Array.from(gif), [0x2c, ...le16(0), ...le16(0), ...le16(9000), ...le16(9000), 0, 2, 1, 7, 0]);
    expect(gifExtent(after)).toEqual({ width: 20, height: 20 });
  });

  it('handles a truncated GIF without throwing, keeping what it had read', () => {
    const gif = GIF_BLOCKS(10, 10, [{ w: 200, h: 100, lct: 2 }, { w: 7000, h: 6000 }], { gct: 3, comment: [1, 2, 3] });
    for (let n = 0; n <= gif.length; n++) {
      const size = gifExtent(gif.slice(0, n));
      if (n < 10) expect(size, `length ${n}`).toBeNull();
      else {
        expect(size, `length ${n}`).not.toBeNull();
        expect(size?.width).toBeGreaterThanOrEqual(10);
        expect(size?.height).toBeGreaterThanOrEqual(10);
      }
    }
    expect(gifExtent(gif.slice(0, gif.length - 1))).toEqual({ width: 7000, height: 6000 }); // only the trailer is missing
  });

  it('handles damaged and random data without throwing or looping', () => {
    let seed = 12345;
    const random = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
    for (let round = 0; round < 200; round++) {
      const junk = Array.from({ length: 1 + (round % 60) * 7 }, random);
      const size = gifExtent(bytes(ascii(round % 2 ? 'GIF87a' : 'GIF89a'), le16(1 + random()), le16(1 + random()), junk));
      expect(size === null || (size.width > 0 && size.height > 0)).toBe(true);
    }
    expect(gifExtent(bytes(ascii('GIF89a'), le16(4), le16(4), [0, 0, 0], new Array<number>(5000).fill(0x21)))).toEqual({ width: 4, height: 4 });
    expect(gifExtent(bytes(ascii('GIF89a'), le16(4), le16(4), [0, 0, 0], [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], new Array<number>(5000).fill(0xff)))).toEqual({ width: 4, height: 4 });
  });

  it('returns null for anything that is not a GIF', () => {
    expect(gifExtent(PNG)).toBeNull();
    expect(gifExtent(new Uint8Array())).toBeNull();
    expect(gifExtent(GIF('GIF89a', 10, 10).slice(0, 9))).toBeNull();
  });

  it('is what imageSize reports for a GIF', () => {
    expect(imageSize(GIF_BLOCKS(1, 1, [{ w: 9000, h: 9000 }]))).toEqual({ width: 9000, height: 9000 });
    expect(imageSize(GIF_BLOCKS(0, 0, [{ w: 64, h: 48 }]))).toEqual({ width: 64, height: 48 });
    expect(imageSize(GIF('GIF89a', 320, 240))).toEqual({ width: 320, height: 240 });
  });
});
