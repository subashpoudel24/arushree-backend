import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFound = (_req: Request, _res: Response, next: NextFunction) =>
  next(new ApiError(404, 'not_found', 'This resource does not exist.'));

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: err.issues[0]?.message ?? 'Please check the form and try again.',
        details: err.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  // Two requests raced past an "already exists" check; the unique index caught it.
  if ((err as { code?: number }).code === 11000) {
    res.status(409).json({ error: { code: 'duplicate', message: 'This already exists.' } });
    return;
  }
  // Body parser failures such as malformed JSON or an oversized body.
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'bad_request', message: 'The request could not be read.' } });
    return;
  }
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
};
