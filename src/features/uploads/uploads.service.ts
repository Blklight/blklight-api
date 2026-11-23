import sharp, { type Metadata } from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createId } from '@paralleldrive/cuid2';
import { db } from '../../db';
import { env } from '../../config/env';
import { ValidationError } from '../../utils/errors';
import { uploads, type UploadPurpose } from './uploads.schema';

// One image at a time and no libvips cache: keeps memory flat on small machines.
sharp.concurrency(1);
sharp.cache(false);

const MAX_INPUT_PIXELS = 40_000_000;
/** Each frame of an animated image is decoded and re-encoded: cap the CPU per upload. */
export const MAX_FRAMES = 200;
/** Images decoded at once. A 40 MP photo takes ~160 MB raw, so this bounds memory on small machines. */
const MAX_PARALLEL = 2;

let running = 0;
const waiting: Array<() => void> = [];

/**
 * Run `task` once fewer than MAX_PARALLEL tasks are running; later callers wait in FIFO order.
 * shortcut: the queue is unbounded (per-user rate limit caps it); add a max length if uploads
 * ever outgrow that.
 */
export async function withImageSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running < MAX_PARALLEL) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve)); // slot handed over below
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

// AWS SDK reads AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION and
// AWS_ENDPOINT_URL_S3 from the environment (the names `fly storage create` sets).
const s3 = new S3Client({ forcePathStyle: env.S3_FORCE_PATH_STYLE });

const avatarSide = (meta: Metadata) => Math.min(512, meta.width ?? 512, meta.height ?? 512);

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Validate an uploaded image by its real content and re-encode it as WebP,
 * resized for its purpose, auto-rotated, with all metadata (EXIF/GPS) dropped.
 * @param input - Raw uploaded bytes
 * @param purpose - editor (max 1920px wide) or avatar (square crop, at most 512px)
 * @returns WebP bytes and final dimensions
 */
export async function processImage(input: Buffer, purpose: UploadPurpose): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ValidationError('File is not a supported image');
  }

  // heif covers AVIF (av1) and HEIC (hevc); prebuilt sharp only decodes AVIF. SVG is refused (scripts).
  const supported =
    ['jpeg', 'png', 'webp', 'gif'].includes(meta.format ?? '') ||
    (meta.format === 'heif' && meta.compression === 'av1');
  if (!supported) {
    throw new ValidationError('Unsupported image format. Use JPEG, PNG, WebP, AVIF or GIF.');
  }
  if ((meta.width ?? 0) * (meta.pageHeight ?? meta.height ?? 0) > MAX_INPUT_PIXELS) {
    throw new ValidationError('Image dimensions are too large');
  }

  const animated = purpose === 'editor' && (meta.pages ?? 1) > 1;
  if (animated && meta.pages! > MAX_FRAMES) {
    throw new ValidationError(`Animated images can have at most ${MAX_FRAMES} frames`);
  }

  try {
    let image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated });
    if (!animated) image = image.rotate();

    image =
      purpose === 'avatar'
        ? // Square crop, never upscaled: a 460x300 photo becomes 300x300, not a blurry 512x512.
          image.resize(avatarSide(meta), avatarSide(meta), { fit: 'cover', position: 'attention' }).webp({ quality: 82 })
        : image.resize({ width: 1920, withoutEnlargement: true }).webp({ quality: 80, effort: 4 });

    const { data, info } = await image.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: animated ? (info.pageHeight ?? info.height) : info.height };
  } catch {
    throw new ValidationError('Could not process image');
  }
}

/**
 * Optimize an image, store it in the bucket and record it.
 * @param userId - Uploader
 * @param purpose - What the image is for
 * @param input - Raw uploaded bytes
 * @returns Public URL and stats of the stored WebP
 */
export async function storeImage(userId: string, purpose: UploadPurpose, input: Buffer) {
  const image = await withImageSlot(() => processImage(input, purpose));
  const key = `${purpose}/${userId}/${createId()}.webp`;

  await s3.send(new PutObjectCommand({
    Bucket: env.BUCKET_NAME,
    Key: key,
    Body: image.data,
    ContentType: 'image/webp',
    // Keys are unique per upload, so the object never changes.
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  await db.insert(uploads).values({
    id: createId(),
    userId,
    key,
    purpose,
    bytes: image.data.length,
    width: image.width,
    height: image.height,
  });

  return {
    url: `${env.UPLOADS_PUBLIC_BASE_URL!.replace(/\/$/, '')}/${key}`,
    width: image.width,
    height: image.height,
    bytes: image.data.length,
  };
}
