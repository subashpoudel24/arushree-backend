import { Schema, Types, model } from 'mongoose';

interface IRefreshToken {
  user: Types.ObjectId;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt?: Date;
  rotatedAt?: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true, expires: 0 },
    revokedAt: { type: Date },
    rotatedAt: { type: Date },
  },
  { timestamps: true }
);

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);
