// Creates the first Super Admin, or promotes an existing account with that email.
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../lib/db.js';
import { User } from '../models/User.js';
import { BCRYPT_ROUNDS, newPassword } from '../routes/auth.js';

const input = z
  .object({
    ADMIN_NAME: z.string().trim().min(2).default('Super Admin'),
    ADMIN_EMAIL: z.email().toLowerCase(),
    ADMIN_PASSWORD: newPassword,
  })
  .parse(process.env);

await connectDatabase(env.MONGODB_URI);

const passwordHash = await bcrypt.hash(input.ADMIN_PASSWORD, BCRYPT_ROUNDS);
await User.findOneAndUpdate(
  { email: input.ADMIN_EMAIL },
  { name: input.ADMIN_NAME, passwordHash, role: 'super_admin', status: 'active', emailVerified: true },
  { upsert: true, setDefaultsOnInsert: true }
);
console.log(`Super Admin ready: ${input.ADMIN_EMAIL}. Remove ADMIN_PASSWORD from .env now.`);

await disconnectDatabase();
process.exit(0);
