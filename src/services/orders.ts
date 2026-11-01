import mongoose, { Types } from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { mailer, orderEmail } from '../lib/mailer.js';
import { Cart, Coupon, CouponRedemption, Order, OrderDocument } from '../models/Commerce.js';
import { Product } from '../models/Product.js';
import { esewaGateway } from './esewa.js';

export const PAYMENT_WINDOW_MS = 30 * 60 * 1000;

export const sendOrderEmail = (order: OrderDocument, heading: string) => {
  if (!order.email) return;
  // Never awaited: a mail problem must not fail an order or a payment.
  void mailer
    .send(orderEmail(order.email, order, heading, `${env.FRONTEND_URL}/track-order`))
    .catch((err) => logger.error({ err, order: order.orderNumber }, 'Could not send order email'));
};

// Returns stock and coupon use. The atomic flag makes this safe to call twice:
// a double click, a retry or the expiry job can never restore stock more than once.
export const cancelAndRelease = async (orderId: Types.ObjectId | string, note: string) => {
  const session = await mongoose.startSession();
  try {
    let released: OrderDocument | null = null;
    await session.withTransaction(async () => {
      released = await Order.findOneAndUpdate(
        { _id: orderId, stockReleased: false },
        {
          $set: { stockReleased: true, status: 'canceled' },
          $push: { statusHistory: { status: 'canceled', at: new Date(), note } },
        },
        { session, returnDocument: 'after' }
      );
      if (!released) return;
      for (const item of (released as OrderDocument).items) {
        await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } }, { session });
      }
      const { couponCode, _id } = released as OrderDocument;
      if (couponCode) {
        await Coupon.updateOne({ code: couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
        await CouponRedemption.deleteMany({ order: _id }, { session });
      }
    });
    return released as OrderDocument | null;
  } finally {
    await session.endSession();
  }
};

const clearOwnerCart = (ownerKey: string) => {
  const [kind, id] = [ownerKey.slice(0, 1), ownerKey.slice(2)];
  return Cart.updateOne(kind === 'u' ? { user: id } : { guestHash: id }, { $set: { items: [] }, $unset: { couponCode: 1 } });
};

export const markPaid = async (order: OrderDocument, transactionCode?: string) => {
  const now = new Date();
  const esewaFields = {
    paymentStatus: 'paid',
    'esewa.verifiedAt': now,
    ...(transactionCode && { 'esewa.transactionCode': transactionCode }),
  };

  // The usual case. The filter means only one caller ever performs this change.
  const paid = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'paid' }, stockReleased: false },
    {
      $set: { ...esewaFields, status: 'confirmed' },
      $unset: { paymentExpiresAt: 1 },
      $push: { statusHistory: { status: 'confirmed', at: now, note: 'eSewa payment verified' } },
    },
    { returnDocument: 'after' }
  );
  if (paid) {
    await clearOwnerCart(paid.ownerKey);
    sendOrderEmail(paid, 'Your order is confirmed');
    return paid;
  }

  // The money arrived after the order had expired and its stock was released.
  // Record it so staff can refund or re-ship, but do not revive the order.
  const late = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: { $ne: 'paid' } },
    {
      $set: esewaFields,
      $unset: { paymentExpiresAt: 1 },
      $push: { statusHistory: { status: 'canceled', at: now, note: 'Payment received after cancellation: refund needed' } },
    },
    { returnDocument: 'after' }
  );
  if (late) logger.error({ order: late.orderNumber }, 'eSewa payment received for a canceled order');
  return late ?? (await Order.findById(order._id));
};

// Unpaid eSewa orders hold stock, so they cannot be left waiting forever.
export const expirePendingOrders = async () => {
  const due = await Order.find({
    status: 'pending_payment',
    paymentExpiresAt: { $lt: new Date() },
  }).limit(100);

  for (const order of due) {
    try {
      const { status, refId } = await esewaGateway.fetchStatus(order.esewa!.transactionUuid, order.total);
      if (status === 'COMPLETE') await markPaid(order, refId);
      else await cancelAndRelease(order._id, 'Payment window expired');
    } catch (err) {
      // eSewa unreachable: we don't know the outcome, so try again on the next run.
      logger.warn({ err, order: order.orderNumber }, 'Could not check eSewa payment');
    }
  }
  return due.length;
};

export const startOrderJobs = () => {
  const timer = setInterval(
    () => void expirePendingOrders().catch((err) => logger.error({ err }, 'Order expiry job failed')),
    5 * 60 * 1000
  );
  timer.unref();
};
