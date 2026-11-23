import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processImage } from '../../src/features/uploads/uploads.service';

function photo(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#3366aa' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'secret-exif' } })
    .toBuffer();
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

  it('accepts PNG input', async () => {
    const png = await sharp({ create: { width: 50, height: 40, channels: 4, background: '#ff000080' } }).png().toBuffer();
    const out = await processImage(png, 'editor');
    expect([out.width, out.height]).toEqual([50, 40]);
  });

  it('rejects SVG even though sharp can read it', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(processImage(svg, 'editor')).rejects.toThrow(/Unsupported image format/);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(processImage(Buffer.from('not an image'), 'avatar')).rejects.toThrow(/not a supported image/);
  });
});
