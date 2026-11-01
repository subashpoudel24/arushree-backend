import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { escapeRegex, paged, pagination, slugSchema } from '../lib/validation.js';
import { requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import { Category, SECTIONS } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { refreshProductRating } from '../services/ratings.js';

const CATEGORY_FIELDS = 'name slug section image displayOrder';
const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  popular: { ratingCount: -1, ratingAverage: -1 },
} as const;

const listQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  category: z.union([slugSchema, z.array(slugSchema).max(20)]).optional(),
  section: z.enum(SECTIONS).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  featured: z.enum(['true']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
});

const slugParams = z.object({ slug: slugSchema });
const reviewBody = z.object({
  rating: z.number().int().min(1, 'Please choose a rating.').max(5),
  text: z.string().trim().min(3, 'Please write a short review.').max(2000),
});

const findPublished = async (slug: string) => {
  const product = await Product.findOne({ slug, status: 'published' }).populate('categories', CATEGORY_FIELDS);
  if (!product) throw new ApiError(404, 'not_found', 'This product does not exist.');
  return product;
};

export const catalogRouter = Router();

catalogRouter.get('/categories', async (_req, res) => {
  const items = await Category.find({ active: true }).select(CATEGORY_FIELDS).sort({ displayOrder: 1, name: 1 });
  res.json({ items });
});

catalogRouter.get('/products', async (req, res) => {
  const query = listQuery.parse(req.query);
  const filter: Record<string, unknown> = { status: 'published' };

  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  if (query.featured) filter.featured = true;
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {
      ...(query.minPrice !== undefined && { $gte: query.minPrice }),
      ...(query.maxPrice !== undefined && { $lte: query.maxPrice }),
    };
  }
  if (query.category || query.section) {
    const categories = await Category.find({
      active: true,
      ...(query.category && { slug: { $in: [query.category].flat() } }),
      ...(query.section && { section: query.section }),
    }).select('_id');
    filter.categories = { $in: categories.map((category) => category._id) };
  }

  const [items, total] = await Promise.all([
    Product.find(filter)
      .select('-description -specifications')
      .populate('categories', CATEGORY_FIELDS)
      .sort(SORTS[query.sort])
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Product.countDocuments(filter),
  ]);
  res.json(paged(items, total, query.page, query.limit));
});

catalogRouter.get('/products/:slug', async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  res.json({ product: await findPublished(slug) });
});

catalogRouter.get('/products/:slug/related', async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  const product = await findPublished(slug);
  const items = await Product.find({
    _id: { $ne: product._id },
    status: 'published',
    categories: { $in: product.categories.map((category) => category._id) },
  })
    .select('-description -specifications')
    .sort({ ratingCount: -1, createdAt: -1 })
    .limit(4);
  res.json({ items });
});

catalogRouter.get('/products/:slug/reviews', async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  const { page, limit } = z.object(pagination).parse(req.query);
  const product = await findPublished(slug);
  const filter = { product: product._id, status: 'published' as const };
  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .populate('user', 'name') // Reviewer's name only, never their email.
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Review.countDocuments(filter),
  ]);
  const items = reviews.map((review) => ({
    id: review.id as string,
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt,
    author: (review.user as unknown as { name?: string } | null)?.name ?? 'Customer',
  }));
  res.json(paged(items, total, page, limit));
});

catalogRouter.post('/products/:slug/reviews', limiters.login, requireAuth, async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  const body = reviewBody.parse(req.body);
  const product = await findPublished(slug);
  try {
    await Review.create({ product: product._id, user: req.user!._id, ...body });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new ApiError(409, 'already_reviewed', 'You have already reviewed this product.');
    }
    throw err;
  }
  await refreshProductRating(product._id);
  res.status(201).json({ message: 'Thank you for your review.' });
});
