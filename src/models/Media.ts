import { Schema, Types, model } from 'mongoose';

interface IMedia {
  url: string;
  publicId: string;
  filename: string;
  bytes: number;
  width?: number;
  height?: number;
  format?: string;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

const mediaSchema = new Schema<IMedia>(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true, unique: true },
    filename: { type: String, required: true },
    bytes: { type: Number, required: true },
    width: { type: Number },
    height: { type: Number },
    format: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

mediaSchema.index({ createdAt: -1 });

export const Media = model<IMedia>('Media', mediaSchema);
