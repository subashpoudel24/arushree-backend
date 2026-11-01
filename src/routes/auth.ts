import bcrypt from 'bcryptjs';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ApiError, forbidden, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { mailer, passwordResetEmail } from '../lib/mailer.js';
import { requireAuth } from '../middleware/auth.js';
import { accountLimiters, issueCsrfToken, limiters } from '../middleware/security.js';
import { PasswordResetToken } from '../models/PasswordResetToken.js';
import { User, toPublicUser } from '../models/User.js';
import { mergeGuestCart } from '../services/cart.js';
import { googleVerifier } from '../services/google.js';
import {
  REFRESH_COOKIE,
  SESSION_HINT_COOKIE,
  clearSessionCookies,
  endSession,
  generateToken,
  hashToken,
  revokeAllSessions,
  rotateSession,
  startSession,
} from '../services/tokens.js';

export const BCRYPT_ROUNDS = 12;
const RESET_TTL_MS = 60 * 60 * 1000;
// Compared when an email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const email = z.email('Please enter a valid email address.').trim().toLowerCase();
export const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .refine((value) => Buffer.byteLength(value) <= 72, 'Password is too long.');

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(100),
  email,
  password: newPassword,
});
const loginSchema = z.object({ email, password: z.string().min(1, 'Please enter your password.').max(200) });
const forgotSchema = z.object({ email });
const resetSchema = z.object({ token: z.string().min(20).max(200), password: newPassword });
const googleSchema = z.object({ credential: z.string().min(20).max(5000) });

export const authRouter = Router();

const sessionResponse = async (req: Request, res: Response, user: Parameters<typeof toPublicUser>[0], status = 200) => {
  await startSession(res, user.id);
  await mergeGuestCart(req, res, user.id);
  res.status(status).json({ user: toPublicUser(user) });
};

authRouter.get('/csrf', (_req, res) => {
  res.json({ csrfToken: issueCsrfToken(res) });
});

authRouter.post('/register', limiters.register, async (req, res) => {
  const body = registerSchema.parse(req.body);
  if (await User.exists({ email: body.email })) {
    throw new ApiError(409, 'email_in_use', 'An account with this email already exists.');
  }
  const user = await User.create({
    name: body.name,
    email: body.email,
    passwordHash: await bcrypt.hash(body.password, BCRYPT_ROUNDS),
  });
  await sessionResponse(req, res, user, 201);
});

authRouter.post('/login', limiters.login, accountLimiters.login, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const user = await User.findOne({ email: body.email }).select('+passwordHash');
  const matches = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !matches) {
    throw new ApiError(401, 'invalid_credentials', 'Incorrect email or password.');
  }
  if (user.status === 'blocked') throw forbidden('This account has been blocked.');
  await sessionResponse(req, res, user);
});

authRouter.post('/google', limiters.login, async (req, res) => {
  const { credential } = googleSchema.parse(req.body);
  const profile = await googleVerifier.verify(credential);
  if (!profile || !profile.emailVerified) {
    throw new ApiError(401, 'google_failed', 'Google sign-in failed. Please try again.');
  }
  const profileEmail = profile.email.toLowerCase();
  let user = await User.findOne({ email: profileEmail }).select('+passwordHash +googleId');
  if (!user) {
    user = await User.create({
      name: profile.name,
      email: profileEmail,
      googleId: profile.sub,
      avatarUrl: profile.picture,
      emailVerified: true,
    });
  } else {
    if (user.status === 'blocked') throw forbidden('This account has been blocked.');
    if (user.googleId && user.googleId !== profile.sub) {
      throw new ApiError(401, 'google_failed', 'Google sign-in failed. Please try again.');
    }
    // Nobody ever proved they owned this email, so a stranger may have registered it
    // first. Remove their password and sessions before giving the real owner access.
    if (!user.emailVerified) {
      user.passwordHash = undefined;
      await revokeAllSessions(user.id);
    }
    user.googleId = profile.sub;
    user.emailVerified = true;
    await user.save();
  }
  await sessionResponse(req, res, user);
});

authRouter.post('/refresh', limiters.refresh, async (req: Request, res: Response) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  // A signed-out visitor has nothing to clear. Clearing anyway could wipe the cookies
  // from a login that finishes while this response is on its way back.
  if (!presented) {
    // The refresh cookie has gone, so a leftover hint would keep demanding a refresh.
    if (req.cookies?.[SESSION_HINT_COOKIE]) res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });
    throw unauthorized();
  }
  try {
    const userId = await rotateSession(res, presented);
    const user = await User.findById(userId);
    if (!user || user.status === 'blocked') {
      await revokeAllSessions(userId);
      throw unauthorized();
    }
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) clearSessionCookies(res);
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await endSession(req.cookies?.[REFRESH_COOKIE]);
  clearSessionCookies(res);
  res.status(204).end();
});

authRouter.post('/forgot-password', limiters.passwordReset, accountLimiters.passwordReset, async (req, res) => {
  const body = forgotSchema.parse(req.body);
  const user = await User.findOne({ email: body.email });
  if (user && user.status === 'active') {
    const token = generateToken();
    await PasswordResetToken.deleteMany({ user: user.id });
    await PasswordResetToken.create({
      user: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });
    const link = `${env.FRONTEND_URL}/reset-password/${token}`;
    // Not awaited: waiting on SMTP would reveal through timing that the account exists.
    void mailer
      .send(passwordResetEmail(user.email, user.name, link))
      .catch((err) => logger.error({ err }, 'Could not send password reset email'));
  }
  res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
});

authRouter.post('/reset-password', limiters.passwordReset, async (req, res) => {
  const body = resetSchema.parse(req.body);
  // findOneAndDelete makes the token single-use even with parallel requests.
  const reset = await PasswordResetToken.findOneAndDelete({
    tokenHash: hashToken(body.token),
    expiresAt: { $gt: new Date() },
  });
  const user = reset && (await User.findById(reset.user));
  if (!user) {
    throw new ApiError(400, 'invalid_reset_token', 'This reset link is invalid or has expired.');
  }
  user.passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  user.emailVerified = true; // Using the link proves they own the mailbox.
  await user.save();
  await revokeAllSessions(user.id);
  clearSessionCookies(res);
  res.json({ message: 'Your password has been changed. Please sign in.' });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: toPublicUser(req.user!) });
});
