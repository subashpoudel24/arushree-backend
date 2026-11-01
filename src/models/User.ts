import { HydratedDocument, Schema, model } from 'mongoose';

export const ROLES = ['customer', 'editor', 'manager', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['editor', 'manager', 'super_admin'];

export interface IUser {
  name: string;
  email: string;
  passwordHash?: string;
  googleId?: string;
  phone?: string;
  avatarUrl?: string;
  avatarPublicId?: string;
  role: Role;
  status: 'active' | 'blocked';
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    googleId: { type: String, select: false, unique: true, sparse: true },
    phone: { type: String, trim: true },
    avatarUrl: { type: String },
    avatarPublicId: { type: String, select: false },
    role: { type: String, enum: ROLES, default: 'customer', index: true },
    status: { type: String, enum: ['active', 'blocked'], default: 'active' },
    emailVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const User = model<IUser>('User', userSchema);

// The only shape of a user that may leave the API.
export const toPublicUser = (user: UserDocument) => ({
  id: user.id as string,
  name: user.name,
  email: user.email,
  phone: user.phone ?? null,
  avatarUrl: user.avatarUrl ?? null,
  role: user.role,
  emailVerified: user.emailVerified,
  createdAt: user.createdAt,
});
