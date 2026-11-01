import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import { imageUpload } from '../middleware/upload.js';
import { User, toPublicUser } from '../models/User.js';
import { imageStorage, releaseImages } from '../services/images.js';
import { revokeAllSessions, startSession } from '../services/tokens.js';
import { BCRYPT_ROUNDS, newPassword } from './auth.js';

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(100).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s-]{6,19}$/, 'Please enter a valid phone number.')
    .or(z.literal(''))
    .optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword,
});

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.patch('/profile', async (req, res) => {
  const body = profileSchema.parse(req.body);
  const user = req.user!;
  if (body.name !== undefined) user.name = body.name;
  if (body.phone !== undefined) user.phone = body.phone || undefined;
  await user.save();
  res.json({ user: toPublicUser(user) });
});

accountRouter.post('/avatar', limiters.register, imageUpload, async (req, res) => {
  const user = await User.findById(req.user!.id).select('+avatarPublicId');
  if (!user) throw new ApiError(404, 'not_found', 'Account not found.');
  const previous = user.avatarPublicId;
  const stored = await imageStorage.upload(req.file!.buffer, 'avatars');
  user.avatarUrl = stored.url;
  user.avatarPublicId = stored.publicId;
  await user.save();
  await releaseImages([previous]);
  res.json({ user: toPublicUser(user) });
});

accountRouter.post('/change-password', limiters.login, async (req, res) => {
  const body = passwordSchema.parse(req.body);
  const user = await User.findById(req.user!.id).select('+passwordHash');
  if (!user) throw new ApiError(404, 'not_found', 'Account not found.');
  // Google-only accounts have no current password to confirm.
  if (user.passwordHash) {
    const matches = await bcrypt.compare(body.currentPassword ?? '', user.passwordHash);
    if (!matches) {
      throw new ApiError(400, 'invalid_credentials', 'Your current password is incorrect.');
    }
  }
  user.passwordHash = await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS);
  await user.save();
  // Sign out every other device, then keep this one signed in.
  await revokeAllSessions(user.id);
  await startSession(res, user.id);
  res.json({ message: 'Your password has been changed.' });
});
