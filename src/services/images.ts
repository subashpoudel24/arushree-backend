import { v2 as cloudinary } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { Setting } from '../models/Admin.js';
import { Category } from '../models/Category.js';
import { Blog, Testimonial } from '../models/Content.js';
import { Order } from '../models/Commerce.js';
import { Media } from '../models/Media.js';
import { Product } from '../models/Product.js';
import { User } from '../models/User.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const isConfigured = !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export const isImageStorageConfigured = () => isConfigured;

// Development only: without Cloudinary, keep uploads in the website's public folder
// so image screens can be tried locally. Production always requires Cloudinary.
const useLocalStorage = !isConfigured && env.NODE_ENV === 'development';
const LOCAL_FOLDER = resolve(process.cwd(), '..', 'frontend', 'public', 'uploads', 'dev');
const LOCAL_PREFIX = 'local-dev/';

const imageExtension = (buffer: Buffer) => (buffer[0] === 0xff ? 'jpg' : buffer[0] === 0x89 ? 'png' : 'webp');

const saveLocally = async (buffer: Buffer): Promise<StoredImage> => {
  await mkdir(LOCAL_FOLDER, { recursive: true });
  const format = imageExtension(buffer);
  const name = `${randomUUID()}.${format}`;
  await writeFile(join(LOCAL_FOLDER, name), buffer);
  return { url: `/uploads/dev/${name}`, publicId: `${LOCAL_PREFIX}${name}`, format, bytes: buffer.length };
};

export interface StoredImage {
  url: string;
  publicId: string;
  width?: number;
  height?: number;
  format?: string;
  bytes: number;
}

// Replaced in tests so they never touch the real Cloudinary account.
export const imageStorage = {
  upload(buffer: Buffer, folder: string): Promise<StoredImage> {
    if (useLocalStorage) return saveLocally(buffer);
    if (!isConfigured) {
      throw new ApiError(503, 'image_storage_unavailable', 'Image storage is not set up yet.');
    }
    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream({ folder: `aarushree/${folder}`, resource_type: 'image' }, (err, result) => {
          if (err || !result) return reject(err ?? new Error('Empty Cloudinary response'));
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
          });
        })
        .end(buffer);
    });
  },
  async destroy(publicId: string): Promise<void> {
    if (publicId.startsWith(LOCAL_PREFIX)) {
      // basename-style check: an id can never reach outside the uploads folder.
      const name = publicId.slice(LOCAL_PREFIX.length);
      if (/^[\w-]+\.(jpg|png|webp)$/.test(name)) await rm(join(LOCAL_FOLDER, name), { force: true });
      return;
    }
    if (!isConfigured) return;
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  },
};

// Trust the file's actual bytes, never its name or the type the browser claims.
export const isAllowedImage = (buffer: Buffer) => {
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp =
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
};

// Every collection that can hold an image must be checked here.
const isImageInUse = async (publicId: string) => {
  const uses = await Promise.all([
    Product.exists({ 'images.publicId': publicId }),
    Category.exists({ 'image.publicId': publicId }),
    User.exists({ avatarPublicId: publicId }),
    Order.exists({ 'items.imagePublicId': publicId }), // Past orders keep their photos.
    Blog.exists({ $or: [{ 'image.publicId': publicId }, { 'authorImage.publicId': publicId }] }),
    Testimonial.exists({ 'authorImage.publicId': publicId }),
    Setting.exists({
      $or: [
        { 'value.logo.publicId': publicId },
        { 'value.banners.desktopImage.publicId': publicId },
        { 'value.banners.mobileImage.publicId': publicId },
        { 'value.highlights.image.publicId': publicId },
      ],
    }),
  ]);
  return uses.some(Boolean);
};

// Removes files nothing refers to any more. A failed delete is logged, not fatal:
// the admin's save has already succeeded and the file can be cleaned up later.
export const releaseImages = async (publicIds: (string | undefined)[]) => {
  for (const publicId of new Set(publicIds.filter((id): id is string => !!id))) {
    try {
      if (await isImageInUse(publicId)) continue;
      await imageStorage.destroy(publicId);
      await Media.deleteOne({ publicId });
    } catch (err) {
      logger.error({ err, publicId }, 'Could not delete image');
    }
  }
};

export const deleteMedia = async (publicId: string) => {
  if (await isImageInUse(publicId)) {
    throw new ApiError(409, 'image_in_use', 'This image is in use. Remove it from those items first.');
  }
  await imageStorage.destroy(publicId);
  await Media.deleteOne({ publicId });
};
