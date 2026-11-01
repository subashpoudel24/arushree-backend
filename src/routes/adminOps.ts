import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { idParams, paged, pagination } from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { Setting } from '../models/Admin.js';
import { Order } from '../models/Commerce.js';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { User } from '../models/User.js';
import { isEsewaConfigured } from '../services/esewa.js';
import { getPaymentSettings } from '../services/permissions.js';
import { refreshProductRating } from '../services/ratings.js';

export const LOW_STOCK_LIMIT = 5;

export const adminOpsRouter = Router();

adminOpsRouter.get('/dashboard', requirePermission('dashboard'), async (req, res) => {
  const query = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
  const to = query.to ? new Date(query.to.getTime() + 86_399_999) : new Date();
  const from = query.from ?? new Date(to.getTime() - 30 * 86_400_000);
  const range = { createdAt: { $gte: from, $lte: to } };
  // Unpaid eSewa attempts and cancellations are not sales.
  const realSale = { ...range, status: { $nin: ['canceled', 'pending_payment'] } };

  const [sales, byStatus, topProducts, lowStock, newCustomers, refundsNeeded] = await Promise.all([
    Order.aggregate<{ total: number; count: number }>([
      { $match: realSale },
      { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; count: number }>([{ $match: range }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.aggregate<{ _id: string; quantity: number; revenue: number }>([
      { $match: realSale },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
      { $sort: { quantity: -1 } },
      { $limit: 5 },
    ]),
    Product.find({ status: 'published', stock: { $lte: LOW_STOCK_LIMIT } })
      .select('name slug stock')
      .sort({ stock: 1 })
      .limit(10),
    User.countDocuments({ ...range, role: 'customer' }),
    Order.countDocuments({ status: 'canceled', paymentStatus: 'paid' }),
  ]);

  res.json({
    from,
    to,
    sales: sales[0]?.total ?? 0,
    orders: sales[0]?.count ?? 0,
    averageOrder: sales[0]?.count ? Math.round((sales[0].total / sales[0].count) * 100) / 100 : 0,
    newCustomers,
    refundsNeeded,
    byStatus: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
    topProducts: topProducts.map((row) => ({ name: row._id, quantity: row.quantity, revenue: row.revenue })),
    lowStock,
  });
});

adminOpsRouter.get('/reviews', requirePermission('reviews'), async (req, res) => {
  const query = z.object({ ...pagination, status: z.enum(['published', 'hidden']).optional() }).parse(req.query);
  const filter = query.status ? { status: query.status } : {};
  const [items, total] = await Promise.all([
    Review.find(filter)
      .populate('product', 'name slug')
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Review.countDocuments(filter),
  ]);
  res.json(paged(items, total, query.page, query.limit));
});

adminOpsRouter.patch('/reviews/:id', requirePermission('reviews'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { status } = z.object({ status: z.enum(['published', 'hidden']) }).parse(req.body);
  const review = await Review.findByIdAndUpdate(id, { status }, { returnDocument: 'after' });
  if (!review) throw new ApiError(404, 'not_found', 'Review not found.');
  await refreshProductRating(review.product);
  res.json({ review });
});

adminOpsRouter.delete('/reviews/:id', requirePermission('reviews'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const review = await Review.findByIdAndDelete(id);
  if (review) await refreshProductRating(review.product);
  res.status(204).end();
});

adminOpsRouter.get('/settings/payments', requirePermission('settings'), async (_req, res) => {
  res.json({ settings: await getPaymentSettings(), esewaConfigured: isEsewaConfigured() });
});

adminOpsRouter.put('/settings/payments', requirePermission('settings'), async (req, res) => {
  const value = z.object({ cod: z.boolean(), esewa: z.boolean() }).parse(req.body);
  if (!value.cod && !(value.esewa && isEsewaConfigured())) {
    throw new ApiError(400, 'no_payment_method', 'At least one working payment method must stay on.');
  }
  await Setting.updateOne({ key: 'payments' }, { value }, { upsert: true });
  res.json({ settings: value });
});
