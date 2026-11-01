import { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ApiError } from '../lib/errors.js';
import { MAX_IMAGE_BYTES, isAllowedImage } from '../services/images.js';

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
}).single('image');

export const imageUpload = (req: Request, res: Response, next: NextFunction) => {
  parser(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller.' : 'The image could not be read.';
      return next(new ApiError(400, 'invalid_image', message));
    }
    if (err) return next(err);
    if (!req.file) return next(new ApiError(400, 'invalid_image', 'Please choose an image.'));
    if (!isAllowedImage(req.file.buffer)) {
      return next(new ApiError(400, 'invalid_image', 'Only JPG, PNG and WebP images are allowed.'));
    }
    next();
  });
};
