/** Dimensions from a JPEG frame header, before a decoder allocates pixels. */
export function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at++] !== 0xff) return null;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const size = (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0);
    if (size < 2 || at + size > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) return null;
      const h = bytes[at + 3] * 256 + bytes[at + 4], w = bytes[at + 5] * 256 + bytes[at + 6];
      return w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 32_000_000 ? { w, h } : null;
    }
    at += size;
  }
  return null;
}
