import { describe, expect, it } from 'vitest';
import { checkAnimation, checkDimensions, checkInput, fitSize, nameFromFile, stillAttempts } from '../../src/renderer/settings/emoteImport';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const withHead = (head: number[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  out.set(head);
  return out;
};
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_HEAD = [...ascii('GIF89a'), 10, 0, 10, 0];

describe('stillAttempts', () => {
  it('tries 160 px then 128 px', () => {
    const q = [0.85, 0.75, 0.65, 0.55, 0.45];
    expect(stillAttempts()).toEqual([...q.map((quality) => ({ side: 160, quality })), ...q.map((quality) => ({ side: 128, quality }))]);
  });
});

describe('fitSize', () => {
  it('fits without upscaling', () => {
    expect(fitSize(320, 160, 160)).toEqual({ width: 160, height: 80 });
    expect(fitSize(100, 50, 160)).toEqual({ width: 100, height: 50 });
    expect(fitSize(90, 300, 128)).toEqual({ width: 38, height: 128 });
    expect(fitSize(4000, 3000, 160)).toEqual({ width: 160, height: 120 });
    expect(fitSize(5000, 1, 128)).toEqual({ width: 128, height: 1 }); // never rounds a side down to nothing
  });
});

describe('checkInput', () => {
  it('checks input', () => {
    expect(checkInput(withHead(PNG_HEAD, 100))).toBeNull();
    expect(checkInput(withHead(GIF_HEAD, 100))).toBeNull();
    expect(checkInput(Uint8Array.from(ascii('just some text, renamed .png')))).toBe('type');
    expect(checkInput(new Uint8Array())).toBe('type');
    expect(checkInput(withHead(PNG_HEAD, 8_388_609))).toBe('size');
    expect(checkInput(withHead(PNG_HEAD, 8_388_608))).toBeNull();
  });
});

const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const png = (w: number, h: number): Uint8Array =>
  Uint8Array.from([...PNG_HEAD, ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
const gif = (w: number, h: number): Uint8Array => Uint8Array.from([...ascii('GIF89a'), ...le16(w), ...le16(h), 0xf7, 0, 0]);
/** A GIF whose logical screen is sw x sh and whose one frame is w x h: a decoder draws the frame, even past the screen. */
const gifFrame = (sw: number, sh: number, w: number, h: number): Uint8Array =>
  Uint8Array.from([...ascii('GIF89a'), ...le16(sw), ...le16(sh), 0, 0, 0, 0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 1, 7, 0, 0x3b]);
const webpX =(w: number, h: number): Uint8Array =>
  Uint8Array.from([...ascii('RIFF'), 100, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const jpeg = (w: number, h: number, marker = 0xc0): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, marker, 0, 11, 8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 0x11, 0, 0xff, 0xda, 0, 2]);

describe('checkDimensions', () => {
  it('lets through an image of at most 8192 px on each side', () => {
    expect(checkDimensions(png(8192, 8192))).toBeNull();
    expect(checkDimensions(png(1, 8192))).toBeNull();
    expect(checkDimensions(gif(8192, 100))).toBeNull();
    expect(checkDimensions(gifFrame(1, 1, 8192, 8192))).toBeNull();
    expect(checkDimensions(gifFrame(0, 0, 64, 48))).toBeNull(); // an empty screen is measured by its frame
    expect(checkDimensions(webpX(100, 8192))).toBeNull();
    expect(checkDimensions(jpeg(8192, 8192))).toBeNull();
    expect(checkDimensions(png(160, 160))).toBeNull();
  });

  it('refuses a larger one as too big (size), before anything is decoded', () => {
    expect(checkDimensions(png(8193, 10))).toBe('size');
    expect(checkDimensions(png(10, 8193))).toBe('size');
    expect(checkDimensions(png(30000, 30000))).toBe('size'); // a few hundred bytes that would decode to gigabytes
    expect(checkDimensions(png(0x7fff_ffff, 0x7fff_ffff))).toBe('size');
    expect(checkDimensions(gif(65535, 10))).toBe('size');
    expect(checkDimensions(gifFrame(1, 1, 9000, 9000))).toBe('size'); // a 1 x 1 screen with a 9000 x 9000 frame: the frame is decoded
    expect(checkDimensions(gifFrame(1, 1, 30000, 30000))).toBe('size');
    expect(checkDimensions(gifFrame(100, 100, 100, 8200))).toBe('size');
    expect(checkDimensions(webpX(8193, 10))).toBe('size');
    expect(checkDimensions(webpX(16384, 16384))).toBe('size');
    expect(checkDimensions(jpeg(8193, 10))).toBe('size');
    expect(checkDimensions(jpeg(10, 9000, 0xc2))).toBe('size'); // progressive
  });

  it('refuses an image whose size can’t be read as not a usable image (type)', () => {
    expect(checkDimensions(Uint8Array.from(PNG_HEAD))).toBe('type'); // a signature and nothing else
    expect(checkDimensions(png(10, 10).slice(0, 20))).toBe('type');
    expect(checkDimensions(png(0, 10))).toBe('type');
    expect(checkDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).toBe('type'); // a JPEG with no frame header
    expect(checkDimensions(Uint8Array.from(ascii('just some text, renamed .png')))).toBe('type');
    expect(checkDimensions(new Uint8Array())).toBe('type');
  });
});

describe('checkAnimation', () => {
  it('refuses animations over 1024 px', () => {
    const gif = withHead(GIF_HEAD, 1000);
    expect(checkAnimation(gif, 1025, 10)).toBe('animSize');
    expect(checkAnimation(gif, 10, 1025)).toBe('animSize');
    expect(checkAnimation(withHead(GIF_HEAD, 5_242_881), 100, 100)).toBe('animSize');
    expect(checkAnimation(withHead(GIF_HEAD, 1_048_576), 1024, 1024)).toBeNull();
    expect(checkAnimation(withHead(GIF_HEAD, 5_242_880), 1024, 1024)).toBeNull();
  });
});

describe('nameFromFile', () => {
  it('is the file name without its extension', () => {
    expect(nameFromFile('party cat.gif')).toBe('party cat');
    expect(nameFromFile('archive.tar.png')).toBe('archive.tar');
    expect(nameFromFile('noext')).toBe('noext');
    expect(nameFromFile('.png')).toBe('.png');
  });
});
