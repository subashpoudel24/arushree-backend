import { Schema, Types, model } from 'mongoose';

interface IReview {
  product: Types.ObjectId;
  user: Types.ObjectId;
  rating: number;
  text: string;
  status: 'published' | 'hidden';
  createdAt: Date;
}

const reviewSchema = new Schema<IReview>(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, required: true, trim: true },
    status: { type: String, enum: ['published', 'hidden'], default: 'published' },
  },
  { timestamps: true }
);

reviewSchema.index({ product: 1, user: 1 }, { unique: true });
reviewSchema.index({ product: 1, status: 1, createdAt: -1 });

export const Review = model<IReview>('Review', reviewSchema);
