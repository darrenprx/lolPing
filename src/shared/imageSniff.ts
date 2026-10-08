export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (b: Uint8Array, at: number, sig: readonly number[]): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u24 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** Names an image by its magic bytes, never by its extension or a claimed type. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return 'png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, 0, GIF87) || startsWith(bytes, 0, GIF89)) return 'gif';
  if (startsWith(bytes, 0, RIFF) && startsWith(bytes, 8, WEBP)) return 'webp';
  return null;
}

/** The encoded size from the first chunk's header: lossy (VP8), lossless (VP8L) or extended (VP8X, used by animations). */
export function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(bytes) !== 'webp') return null;
  if (startsWith(bytes, 12, ascii('VP8 '))) {
    // Frame tag (3 bytes), start code, then 14-bit width and height (the top two bits are a scale hint).
    if (bytes.length < 30 || !startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return sized(u16(bytes, 26) & 0x3fff, u16(bytes, 28) & 0x3fff);
  }
  if (startsWith(bytes, 12, ascii('VP8L'))) {
    // Signature byte, then width - 1 and height - 1 as 14 bits each.
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (startsWith(bytes, 12, ascii('VP8X'))) {
    // Flags and reserved bytes, then the canvas width - 1 and height - 1 as 24 bits each.
    if (bytes.length < 30) return null;
    return { width: u24(bytes, 24) + 1, height: u24(bytes, 27) + 1 };
  }
  return null;
}

/** The logical screen size from the header alone. Frames can reach past it: gifExtent is the size a GIF decodes at. */
export function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(bytes) !== 'gif' || bytes.length < 10) return null;
  return sized(u16(bytes, 6), u16(bytes, 8));
}

/** The offset after the data sub-blocks that start at `at`: runs of (length, bytes) up to a zero length. Past the end if cut short. */
function skipSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length) {
    const length = b[at];
    at += 1 + length;
    if (length === 0) break;
  }
  return at;
}

/**
 * The size a GIF decodes at. That is the logical screen, unless a frame reaches past it (a decoder draws the frame whole): then the
 * far edge of the frame, left + width and top + height. Found by walking the blocks and skipping colour tables, extensions and
 * compressed data by their lengths, up to the trailer. Where the data is cut short or damaged the walk stops, and what it found
 * until then counts.
 */
export function gifExtent(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(bytes) !== 'gif' || bytes.length < 10) return null;
  let width = u16(bytes, 6);
  let height = u16(bytes, 8);
  let at = 13; // after the header and the logical screen descriptor
  if (bytes.length > 10 && (bytes[10] & 0x80) !== 0) at += 3 << ((bytes[10] & 7) + 1); // global colour table
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x21) {
      at = skipSubBlocks(bytes, at + 2); // an extension: its label, then data sub-blocks
    } else if (block === 0x2c) {
      if (at + 10 > bytes.length) break;
      width = Math.max(width, u16(bytes, at + 1) + u16(bytes, at + 5));
      height = Math.max(height, u16(bytes, at + 3) + u16(bytes, at + 7));
      const packed = bytes[at + 9];
      at += 10;
      if ((packed & 0x80) !== 0) at += 3 << ((packed & 7) + 1); // local colour table
      at = skipSubBlocks(bytes, at + 1); // the LZW code size, then the compressed data
    } else {
      break; // the trailer, or something that isn't a block
    }
  }
  return sized(width, height);
}

const sized = (width: number, height: number): { width: number; height: number } | null =>
  width > 0 && height > 0 ? { width, height } : null;

/** True for a WebP whose VP8X header says it is an animation (a still must not be one, whatever else it contains). */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  // The flags byte follows the VP8X chunk header: ICC profile, alpha, EXIF and XMP are bits 5 to 2, animation is bit 1.
  return sniffImage(bytes) === 'webp' && startsWith(bytes, 12, ascii('VP8X')) && bytes.length > 20 && (bytes[20] & 0x02) !== 0;
}

const be16 = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** The canvas size from the IHDR chunk, which has to come first. */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || !startsWith(b, 12, ascii('IHDR'))) return null;
  return sized(be32(b, 16), be32(b, 20));
}

/**
 * The size from the first start-of-frame segment (SOF0 to SOF15, which covers baseline, progressive and the rarer kinds).
 * Segments are skipped by their length, so a thumbnail inside an APP1 segment is never mistaken for the image.
 */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // after the SOI marker
  while (i < b.length - 1) {
    if (b[i] !== 0xff) {
      i++; // extraneous bytes between segments, which decoders skip
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2; // a stuffed zero, TEM, RSTn, SOI or EOI: none of them has a length
      continue;
    }
    if (marker === 0xda) return null; // the scan starts: no frame header came first
    if (i + 4 > b.length) return null;
    const length = be16(b, i + 2);
    if (length < 2) return null;
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC). A frame header is precision, height, width, then components.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return length >= 8 && i + 9 <= b.length ? sized(be16(b, i + 7), be16(b, i + 5)) : null;
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The pixel size an image declares in its header, which is how big it becomes once decoded. Null when the header is missing,
 * truncated or says 0, so a caller that refuses large images can refuse what it can't measure too.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  switch (sniffImage(bytes)) {
    case 'png': return pngSize(bytes);
    case 'jpeg': return jpegSize(bytes);
    case 'gif': return gifExtent(bytes);
    case 'webp': return webpSize(bytes);
    default: return null;
  }
}
