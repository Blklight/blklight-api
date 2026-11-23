import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processImage, withImageSlot, MAX_FRAMES } from '../../src/features/uploads/uploads.service';

function photo(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#3366aa' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-exif' } })
    .toBuffer();
}

/** Minimal animated GIF: `frames` 1x1 frames (sharp cannot write multi-frame GIFs from scratch). */
function animatedGif(frames: number) {
  const header = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
  // Alternate black/white pixels (LZW 0x44 0x01 = index 0, 0x4c 0x01 = index 1) so the encoder cannot merge frames.
  const frame = (white: boolean) =>
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, white ? 0x4c : 0x44, 0x01, 0]);
  return Buffer.concat([header, ...Array.from({ length: frames }, (_, i) => frame(i % 2 === 1)), Buffer.from([0x3b])]);
}

describe('processImage', () => {
  it('shrinks a large editor photo to 1920px WebP and drops EXIF', async () => {
    const input = await photo(4000, 3000);
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processImage(input, 'editor');
    const meta = await sharp(out.data).metadata();

    expect(meta.format).toBe('webp');
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1440);
    expect(meta.exif).toBeUndefined();
  });

  it('never enlarges a small editor image', async () => {
    const out = await processImage(await photo(800, 600), 'editor');
    expect([out.width, out.height]).toEqual([800, 600]);
  });

  it('crops an avatar to exactly 512x512', async () => {
    const out = await processImage(await photo(1200, 700), 'avatar');
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([512, 512, 'webp']);
  });

  it('crops a small avatar to a square without enlarging it', async () => {
    const out = await processImage(await photo(460, 300), 'avatar');
    expect([out.width, out.height]).toEqual([300, 300]);
  });

  it('accepts PNG input', async () => {
    const png = await sharp({ create: { width: 50, height: 40, channels: 4, background: '#ff000080' } }).png().toBuffer();
    const out = await processImage(png, 'editor');
    expect([out.width, out.height]).toEqual([50, 40]);
  });

  it('rejects SVG even though sharp can read it', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(processImage(svg, 'editor')).rejects.toThrow(/Unsupported image format/);
  });

  it('keeps a short animation animated', async () => {
    const out = await processImage(animatedGif(3), 'editor');
    expect((await sharp(out.data).metadata()).pages).toBe(3);
  });

  it(`rejects animations over ${MAX_FRAMES} frames`, async () => {
    await expect(processImage(animatedGif(MAX_FRAMES + 1), 'editor')).rejects.toThrow(/at most/);
  });

  it('still accepts a long animation as an avatar (only the first frame is used)', async () => {
    const out = await processImage(animatedGif(MAX_FRAMES + 1), 'avatar');
    expect([out.width, out.height]).toEqual([1, 1]);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(processImage(Buffer.from('not an image'), 'avatar')).rejects.toThrow(/not a supported image/);
  });
});

describe('withImageSlot', () => {
  it('runs at most 2 tasks at once and starts the rest in order', async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const task = (id: number) => () => {
      started.push(id);
      active++;
      peak = Math.max(peak, active);
      return new Promise<number>((resolve) => releases.push(() => { active--; resolve(id); }));
    };

    const all = Promise.all([1, 2, 3, 4].map((id) => withImageSlot(task(id))));
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2]);

    releases.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2, 3]);

    while (releases.length) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await all).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it('frees the slot when a task fails', async () => {
    await expect(withImageSlot(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withImageSlot(async () => 'ok')).resolves.toBe('ok');
  });
});
