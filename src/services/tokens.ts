import { createHash, randomBytes, randomUUID } from 'crypto';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { env, isProduction } from '../config/env.js';
import { ApiError, unauthorized } from '../lib/errors.js';
import { RefreshToken } from '../models/RefreshToken.js';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const SESSION_HINT_COOKIE = 'has_session';
const REFRESH_PATH = '/api/v1/auth';
const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'aarushree', audience: 'aarushree-web' } as const;

// A parallel refresh from a second tab is not treated as token theft within this window.
const REUSE_GRACE_MS = 10_000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const generateToken = () => randomBytes(48).toString('base64url');

export const verifyAccessToken = (token: string) => {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: [JWT_OPTIONS.algorithm],
      issuer: JWT_OPTIONS.issuer,
      audience: JWT_OPTIONS.audience,
    });
    return typeof payload === 'object' ? (payload.sub ?? null) : null;
  } catch {
    return null;
  }
};

const setSessionCookies = (res: Response, userId: string, refreshToken: string) => {
  const accessToken = jwt.sign({}, env.JWT_ACCESS_SECRET, {
    ...JWT_OPTIONS,
    subject: userId,
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
  const base = { httpOnly: true, secure: isProduction, sameSite: 'lax' as const };
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base,
    path: '/',
    maxAge: env.ACCESS_TOKEN_TTL_MINUTES * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    path: REFRESH_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  res.cookie(SESSION_HINT_COOKIE, '1', {
    ...base,
    path: '/',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
};

export const clearSessionCookies = (res: Response) => {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
  res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
};

const storeRefreshToken = async (userId: Types.ObjectId | string, familyId: string) => {
  const token = generateToken();
  await RefreshToken.create({
    user: userId,
    tokenHash: hashToken(token),
    familyId,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
  });
  return token;
};

export const startSession = async (res: Response, userId: string) => {
  const token = await storeRefreshToken(userId, randomUUID());
  setSessionCookies(res, userId, token);
};

export const revokeAllSessions = (userId: Types.ObjectId | string) =>
  RefreshToken.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date() });

// Rotation: each refresh token works once. Reusing an old one revokes the whole
// login family, because it means the token may have been stolen.
export const rotateSession = async (res: Response, presented: string | undefined) => {
  if (!presented) throw unauthorized();
  const tokenHash = hashToken(presented);

  const current = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { revokedAt: new Date(), rotatedAt: new Date() }
  );

  if (!current) {
    const known = await RefreshToken.findOne({ tokenHash });
    // Only rotation creates a replacement token. Tokens revoked by logout or a
    // password change have none, so they fail below and never reach the grace check.
    if (known?.rotatedAt) {
      const stillActive = await RefreshToken.exists({ familyId: known.familyId, revokedAt: null });
      if (stillActive && Date.now() - known.rotatedAt.getTime() < REUSE_GRACE_MS) {
        throw new ApiError(409, 'refresh_in_progress', 'Session refresh already in progress.');
      }
      await RefreshToken.updateMany(
        { familyId: known.familyId, revokedAt: null },
        { revokedAt: new Date() }
      );
    }
    throw unauthorized('Your session expired. Please sign in again.');
  }

  const next = await storeRefreshToken(current.user, current.familyId);
  setSessionCookies(res, current.user.toString(), next);
  return current.user.toString();
};

export const endSession = async (presented: string | undefined) => {
  if (!presented) return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(presented), revokedAt: null },
    { revokedAt: new Date() }
  );
};
