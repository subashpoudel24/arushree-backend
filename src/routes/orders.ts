import { Request, Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { paged, pagination } from '../lib/validation.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import { Order, OrderDocument } from '../models/Commerce.js';
import { normalizePhone, ownerKeyOf } from '../services/cart.js';
import { streamInvoice } from '../services/documents.js';
import { esewaGateway, isEsewaConfigured, parseEsewaCallback } from '../services/esewa.js';
import { cancelAndRelease, markPaid } from '../services/orders.js';
import { getPaymentSettings } from '../services/permissions.js';

const orderNumber = z.string().trim().toUpperCase().regex(/^AL-\d{4}-[A-F0-9]{8}$/, 'Please enter a valid order number.');
const numberParams = z.object({ number: orderNumber });

// What a customer may see. Internal keys and payment references stay on the server.
export const customerOrder = (order: OrderDocument) => ({
  orderNumber: order.orderNumber,
  createdAt: order.createdAt,
  status: order.status,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  items: order.items.map(({ name, slug, imageUrl, unitPrice, quantity, lineTotal }) => ({
    name,
    slug,
    imageUrl,
    unitPrice,
    quantity,
    lineTotal,
  })),
  address: order.address,
  subtotal: order.subtotal,
  discount: order.discount,
  couponCode: order.couponCode,
  deliveryCharge: order.deliveryCharge,
  total: order.total,
  statusHistory: order.statusHistory.map(({ status, at }) => ({ status, at })),
});

// The owner: signed-in customer, or the guest browser that placed it.
const findOwnedOrder = async (req: Request, number: string) => {
  const ownerKey = ownerKeyOf(req);
  const order = ownerKey ? await Order.findOne({ orderNumber: number, ownerKey }) : null;
  if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
  return order;
};

export const ordersRouter = Router();

ordersRouter.get('/', requireAuth, async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const filter = { user: req.user!._id };
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  res.json(paged(orders.map(customerOrder), total, page, limit));
});

// For guests, or anyone away from their account. Needs the number and the phone together.
ordersRouter.post('/track', limiters.track, async (req, res) => {
  const body = z.object({ orderNumber, phone: z.string().trim().min(7).max(25) }).parse(req.body);
  const order = await Order.findOne({ orderNumber: body.orderNumber });
  if (!order || normalizePhone(order.address.phone) !== normalizePhone(body.phone)) {
    throw new ApiError(404, 'not_found', 'We could not find an order with those details.');
  }
  res.json({
    order: {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      status: order.status,
      paymentStatus: order.paymentStatus,
      total: order.total,
      items: order.items.map(({ name, quantity }) => ({ name, quantity })),
      statusHistory: order.statusHistory.map(({ status, at }) => ({ status, at })),
    },
  });
});

ordersRouter.get('/:number', optionalAuth, async (req, res) => {
  const { number } = numberParams.parse(req.params);
  res.json({ order: customerOrder(await findOwnedOrder(req, number)) });
});

ordersRouter.get('/:number/invoice', optionalAuth, async (req, res) => {
  const { number } = numberParams.parse(req.params);
  streamInvoice(res, await findOwnedOrder(req, number));
});

export const paymentsRouter = Router();

paymentsRouter.get('/methods', async (_req, res) => {
  const settings = await getPaymentSettings();
  res.json({
    methods: [...(settings.cod ? ['cod'] : []), ...(settings.esewa && isEsewaConfigured() ? ['esewa'] : [])],
  });
});

// Called when eSewa sends the customer back. The redirect alone proves nothing:
// the signature, the amount and eSewa's own status API must all agree.
paymentsRouter.post('/esewa/verify', limiters.checkout, async (req, res) => {
  const { data } = z.object({ data: z.string().min(10).max(4000) }).parse(req.body);
  const callback = parseEsewaCallback(data);
  if (!callback) throw new ApiError(400, 'invalid_payment', 'This payment response could not be verified.');

  const order = await Order.findOne({ 'esewa.transactionUuid': callback.transactionUuid });
  if (!order) throw new ApiError(404, 'not_found', 'Order not found.');
  if (Math.abs(callback.totalAmount - order.total) > 0.001) {
    throw new ApiError(400, 'invalid_payment', 'The paid amount does not match this order.');
  }

  if (order.paymentStatus === 'paid') {
    res.json({ result: 'paid', order: { orderNumber: order.orderNumber, total: order.total, status: order.status } });
    return;
  }

  let status: { status: string; refId?: string };
  try {
    status = await esewaGateway.fetchStatus(callback.transactionUuid, order.total);
  } catch {
    // Nothing is decided yet. The expiry job checks again before releasing the order.
    throw new ApiError(502, 'payment_check_failed', 'We could not confirm your payment yet. Please check again shortly.');
  }
  if (status.status !== 'COMPLETE') {
    res.json({ result: 'pending', order: { orderNumber: order.orderNumber, total: order.total, status: order.status } });
    return;
  }

  const updated = (await markPaid(order, callback.transactionCode ?? status.refId))!;
  res.json({
    result: updated.status === 'canceled' ? 'paid_after_cancel' : 'paid',
    order: { orderNumber: updated.orderNumber, total: updated.total, status: updated.status },
  });
});

// The customer cancelled on eSewa or came back from a failed payment.
paymentsRouter.post('/esewa/cancel', limiters.checkout, async (req, res) => {
  const { ref } = z.object({ ref: z.uuid() }).parse(req.body);
  const order = await Order.findOne({ 'esewa.transactionUuid': ref });
  if (!order || order.status !== 'pending_payment') {
    res.json({ result: 'none' });
    return;
  }
  // The failure page can be opened by hand, so ask eSewa before releasing anything.
  try {
    const { status, refId } = await esewaGateway.fetchStatus(ref, order.total);
    if (status === 'COMPLETE') {
      await markPaid(order, refId);
      res.json({ result: 'paid' });
      return;
    }
  } catch {
    res.json({ result: 'unknown' }); // The expiry job finishes this later.
    return;
  }
  await cancelAndRelease(order._id, 'Payment not completed');
  res.json({ result: 'canceled' });
});
