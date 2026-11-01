import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env, isProduction } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const signCsrf = (nonce: string) =>
  createHmac('sha256', env.CSRF_SECRET).update(nonce).digest('hex');

const isValidCsrfToken = (token: string) => {
  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) return false;
  const expected = Buffer.from(signCsrf(nonce));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const issueCsrfToken = (res: Response) => {
  const nonce = randomBytes(24).toString('hex');
  const token = `${nonce}.${signCsrf(nonce)}`;
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // The frontend echoes this value back in a header.
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
  return token;
};

// Signed double-submit cookie.
export const csrfProtection = (req: Request, _res: Response, next: NextFunction) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!cookie || !header || cookie !== header || !isValidCsrfToken(header)) {
    return next(new ApiError(403, 'csrf_invalid', 'Your session expired. Please refresh and try again.'));
  }
  next();
};

const hasOperatorKey = (value: unknown, depth = 0): boolean => {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((item) => hasOperatorKey(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, item]) =>
        key.startsWith('$') || key.includes('.') || hasOperatorKey(item, depth + 1)
    );
  }
  return false;
};

// Rejects MongoDB operators in user input before they can reach a query.
export const rejectMongoOperators = (req: Request, _res: Response, next: NextFunction) => {
  if ([req.body, req.query, req.params].some((part) => hasOperatorKey(part))) {
    return next(new ApiError(400, 'invalid_input', 'The request contains invalid fields.'));
  }
  next();
};

// The website's own server fetches these for every visitor from one IP address,
// so counting them per IP would soon block the whole site.
const isPublicCatalogRead = (req: Request) =>
  req.method === 'GET' && /^\/api\/v1\/(products|categories|content|blogs|testimonials)(\/|$)/.test(req.path);

const limiter = (limit: number, windowMinutes: number, exempt?: (req: Request) => boolean) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => env.NODE_ENV === 'test' || !!exempt?.(req),
    handler: (_req, _res, next) =>
      next(new ApiError(429, 'rate_limited', 'Too many attempts. Please wait and try again.')),
  });

// IP limits can be dodged by faking proxy headers, so guessing a password is also
// limited per account. Only failures count, so real customers are not locked out
// by their own successful logins, and the lock lifts on its own.
export const createAccountLimiter = (limit: number, windowMinutes: number, failuresOnly: boolean) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: failuresOnly,
    keyGenerator: (req) => {
      const email = req.body?.email;
      return createHmac('sha256', env.CSRF_SECRET)
        .update(typeof email === 'string' ? email.trim().toLowerCase() : 'invalid')
        .digest('hex');
    },
    handler: (_req, _res, next) =>
      next(new ApiError(429, 'rate_limited', 'Too many attempts for this account. Please wait and try again.')),
  });

const whenNotTesting = (handler: RequestHandler): RequestHandler =>
  env.NODE_ENV === 'test' ? (_req, _res, next) => next() : handler;

export const accountLimiters = {
  login: whenNotTesting(createAccountLimiter(10, 15, true)),
  passwordReset: whenNotTesting(createAccountLimiter(3, 60, false)),
};

export const limiters = {
  login: limiter(10, 15),
  register: limiter(10, 60),
  passwordReset: limiter(5, 60),
  refresh: limiter(120, 15),
  checkout: limiter(30, 15),
  track: limiter(20, 15),
  contact: limiter(5, 60),
  general: limiter(600, 15, isPublicCatalogRead),
};
