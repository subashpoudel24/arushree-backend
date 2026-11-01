import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { objectId } from '../lib/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { Favorite } from '../models/Favorite.js';
import { Product } from '../models/Product.js';

const params = z.object({ productId: objectId });

export const favoritesRouter = Router();
favoritesRouter.use(requireAuth);

favoritesRouter.get('/', async (req, res) => {
  const favorites = await Favorite.find({ user: req.user!._id }).sort({ createdAt: -1 }).select('product');
  const ids = favorites.map((favorite) => favorite.product);
  const products = await Product.find({ _id: { $in: ids }, status: 'published' })
    .select('-description -specifications')
    .populate('categories', 'name slug section');
  const byId = new Map(products.map((product) => [product.id as string, product]));
  res.json({ items: ids.map((id) => byId.get(id.toString())).filter(Boolean) });
});

favoritesRouter.put('/:productId', async (req, res) => {
  const { productId } = params.parse(req.params);
  if (!(await Product.exists({ _id: productId, status: 'published' }))) {
    throw new ApiError(404, 'not_found', 'This product does not exist.');
  }
  // Upsert: pressing the heart twice is harmless.
  await Favorite.updateOne(
    { user: req.user!._id, product: productId },
    { $setOnInsert: { user: req.user!._id, product: productId } },
    { upsert: true }
  );
  res.status(204).end();
});

favoritesRouter.delete('/:productId', async (req, res) => {
  const { productId } = params.parse(req.params);
  await Favorite.deleteOne({ user: req.user!._id, product: productId });
  res.status(204).end();
});
