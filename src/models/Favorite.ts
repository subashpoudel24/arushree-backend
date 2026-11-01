import { Schema, Types, model } from 'mongoose';

interface IFavorite {
  user: Types.ObjectId;
  product: Types.ObjectId;
}

const favoriteSchema = new Schema<IFavorite>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  },
  { timestamps: true }
);

favoriteSchema.index({ user: 1, product: 1 }, { unique: true });

export const Favorite = model<IFavorite>('Favorite', favoriteSchema);
