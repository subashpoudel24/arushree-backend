import { Types } from 'mongoose';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';

export const refreshProductRating = async (productId: Types.ObjectId) => {
  const [summary] = await Review.aggregate<{ average: number; count: number }>([
    { $match: { product: productId, status: 'published' } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  await Product.updateOne(
    { _id: productId },
    {
      ratingAverage: summary ? Math.round(summary.average * 10) / 10 : 0,
      ratingCount: summary?.count ?? 0,
    }
  );
};
