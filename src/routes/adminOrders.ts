import { Request, Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { escapeRegex, idParams, paged, pagination } from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { ORDER_STATUSES, Order, PAYMENT_STATUSES } from '../models/Commerce.js';
import { roundMoney } from '../services/cart.js';
import { streamInvoice, streamOrdersWorkbook } from '../services/documents.js';
import { cancelAndRelease, sendOrderEmail } from '../services/orders.js';

// pending_payment leaves only through verified payment or cancellation.
const NEXT_STATUS: Record<(typeof ORDER_STATUSES)[number], (typeof ORDER_STATUSES)[number][]> = {
  pending_payment: ['canceled'],
  confirmed: ['shipped', 'canceled'],
  shipped: ['out_for_delivery', 'delivered', 'canceled'],
  out_for_delivery: ['delivered', 'canceled'],
  delivered: [],
  canceled: [],
};

const STATUS_EMAILS: Partial<Record<(typeof ORDER_STATUSES)[number], string>> = {
  shipped: 'Your order has been shipped',
  out_for_delivery: 'Your order is out for delivery',
  delivered: 'Your order has been delivered',
  canceled: 'Your order has been canceled',
};

const filterQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const buildFilter = (query: z.infer<typeof filterQuery>) => {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from && { $gte: query.from }),
      // A date on its own means the whole of that day.
      ...(query.to && { $lte: new Date(query.to.getTime() + 86_399_999) }),
    };
  }
  if (query.q) {
    const pattern = { $regex: escapeRegex(query.q), $options: 'i' };
    filter.$or = [
      { orderNumber: pattern },
      { email: pattern },
      { 'address.phone': pattern },
      { 'address.firstName': pattern },
      { 'address.lastName': pattern },
    ];
  }
  return filter;
};

const findOrder = async (req: Request) => {
  const { id } = idParams.parse(req.params);
  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
  return order;
};

export const adminOrdersRouter = Router();
adminOrdersRouter.use('/orders', requirePermission('orders'));

adminOrdersRouter.get('/orders', async (req, res) => {
  const query = filterQuery.extend(pagination).parse(req.query);
  const filter = buildFilter(query);
  const [items, total] = await Promise.all([
    Order.find(filter)
      .select('-ownerKey -idempotencyKey')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Order.countDocuments(filter),
  ]);
  res.json(paged(items, total, query.page, query.limit));
});

adminOrdersRouter.get('/orders/export', async (req, res) => {
  const orders = await Order.find(buildFilter(filterQuery.parse(req.query)))
    .sort({ createdAt: -1 })
    .limit(10_000);
  await streamOrdersWorkbook(res, orders);
});

adminOrdersRouter.get('/orders/:id', async (req, res) => {
  const order = await findOrder(req);
  const { ownerKey: _ownerKey, idempotencyKey: _key, ...rest } = order.toObject();
  res.json({ order: rest });
});

adminOrdersRouter.get('/orders/:id/invoice', async (req, res) => {
  streamInvoice(res, await findOrder(req));
});

adminOrdersRouter.patch('/orders/:id/status', async (req, res) => {
  const { status, note } = z
    .object({ status: z.enum(ORDER_STATUSES), note: z.string().trim().max(300).optional() })
    .parse(req.body);
  const order = await findOrder(req);
  if (!NEXT_STATUS[order.status].includes(status)) {
    throw new ApiError(409, 'invalid_status', `An order that is ${order.status.replace(/_/g, ' ')} cannot become ${status.replace(/_/g, ' ')}.`);
  }

  let updated;
  if (status === 'canceled') {
    updated = await cancelAndRelease(order._id, note ?? `Canceled by ${req.user!.name}`);
  } else {
    // The status filter stops two staff members applying the same step at once.
    updated = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status },
      { $set: { status }, $push: { statusHistory: { status, at: new Date(), note } } },
      { returnDocument: 'after' }
    );
  }
  if (!updated) throw new ApiError(409, 'order_changed', 'This order was just changed by someone else. Please reload.');
  const heading = STATUS_EMAILS[status];
  if (heading) sendOrderEmail(updated, heading);
  res.json({ order: updated });
});

// A staff discount on one item. Only while cash is still to be collected: an eSewa
// or already-paid order has charged a fixed amount that must not silently change.
adminOrdersRouter.patch('/orders/:id/items/:index/discount', async (req, res) => {
  const { index } = z.object({ index: z.coerce.number().int().min(0) }).parse({ index: req.params.index });
  const { discountPercent } = z.object({ discountPercent: z.number().min(0).max(100) }).parse(req.body);
  const order = await findOrder(req);
  if (order.paymentMethod !== 'cod' || order.paymentStatus !== 'unpaid' || !['confirmed', 'shipped', 'out_for_delivery'].includes(order.status)) {
    throw new ApiError(409, 'discount_not_allowed', 'Discounts can only change on unpaid cash orders that are still in progress.');
  }
  const item = order.items[index];
  if (!item) throw new ApiError(404, 'not_found', 'This item is not on the order.');

  item.adminDiscountPercent = discountPercent;
  item.lineTotal = roundMoney(item.unitPrice * item.quantity * (1 - discountPercent / 100));
  order.subtotal = roundMoney(order.items.reduce((sum, line) => sum + line.lineTotal, 0));
  // A coupon can never take the goods below zero after a staff discount.
  order.total = roundMoney(Math.max(order.subtotal - order.discount, 0) + order.deliveryCharge);
  order.statusHistory.push({
    status: order.status,
    at: new Date(),
    note: `${discountPercent}% staff discount on ${item.name} by ${req.user!.name}`,
  });
  await order.save();
  res.json({ order });
});

adminOrdersRouter.patch('/orders/:id/payment-status', async (req, res) => {
  const { paymentStatus } = z.object({ paymentStatus: z.enum(['paid', 'refunded']) }).parse(req.body);
  const order = await findOrder(req);
  // eSewa orders only become paid through verification, never by hand.
  const allowed =
    (paymentStatus === 'paid' && order.paymentMethod === 'cod' && order.paymentStatus === 'unpaid') ||
    (paymentStatus === 'refunded' && order.paymentStatus === 'paid');
  if (!allowed) {
    throw new ApiError(409, 'invalid_payment_status', 'This payment status change is not allowed for this order.');
  }
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: order.paymentStatus },
    {
      $set: { paymentStatus },
      $push: { statusHistory: { status: order.status, at: new Date(), note: `Payment marked ${paymentStatus} by ${req.user!.name}` } },
    },
    { returnDocument: 'after' }
  );
  if (!updated) throw new ApiError(409, 'order_changed', 'This order was just changed by someone else. Please reload.');
  res.json({ order: updated });
});
