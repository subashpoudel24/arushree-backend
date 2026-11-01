import { randomBytes, randomUUID } from 'crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { idParams, objectId } from '../lib/validation.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import { Address, Cart, Coupon, CouponRedemption, DeliveryCharge, IAddress, Order, OrderDocument } from '../models/Commerce.js';
import { Product } from '../models/Product.js';
import { findCart, normalizePhone, ownerKeyOf, priceCart, roundMoney } from '../services/cart.js';
import { buildEsewaForm, isEsewaConfigured } from '../services/esewa.js';
import { PAYMENT_WINDOW_MS, sendOrderEmail } from '../services/orders.js';
import { getPaymentSettings } from '../services/permissions.js';

const place = z.string().trim().toLowerCase().min(1).max(100);
const location = z.object({ province: place, district: place, city: place });
const addressInput = location.extend({
  firstName: z.string().trim().min(1, 'Please enter your first name.').max(60),
  lastName: z.string().trim().min(1, 'Please enter your last name.').max(60),
  phone: z
    .string()
    .trim()
    .refine((value) => /^[+\d][\d\s-]{6,19}$/.test(value), 'Please enter a valid phone number.'),
  street: z.string().trim().max(200).optional(),
  landmark: z.string().trim().min(2, 'Please enter a nearby landmark.').max(200),
  additionalInfo: z.string().trim().max(500).optional(),
});

const checkoutBody = z
  .object({
    addressId: objectId.optional(),
    address: addressInput.optional(),
    saveAddress: z.boolean().default(false),
    email: z.email('Please enter a valid email address.').trim().toLowerCase().optional(),
    paymentMethod: z.enum(['cod', 'esewa']),
    hearAboutUs: z.string().trim().max(100).optional(),
    idempotencyKey: z.uuid(),
    expectedTotal: z.number().min(0),
  })
  .refine((body) => body.addressId || body.address, { message: 'Please enter a delivery address.' });

const findCharge = (where: z.infer<typeof location>) => DeliveryCharge.findOne(where);

const NO_DELIVERY = new ApiError(400, 'no_delivery', 'We do not deliver to this location yet.');

// An unpaid eSewa order also gets the form that sends the customer to eSewa,
// including when a retry finds the order already exists.
const placedResponse = (order: OrderDocument) => ({
  order: {
    orderNumber: order.orderNumber,
    total: order.total,
    paymentMethod: order.paymentMethod,
    status: order.status,
  },
  ...(order.status === 'pending_payment' && { payment: buildEsewaForm(order) }),
});

export const deliveryRouter = Router();

// The province, district and city choices shown at checkout.
deliveryRouter.get('/locations', async (_req, res) => {
  const rows = await DeliveryCharge.find().select('province district city -_id').sort({ province: 1, district: 1, city: 1 });
  res.json({ items: rows });
});

export const addressRouter = Router();
addressRouter.use(requireAuth);

addressRouter.get('/', async (req, res) => {
  res.json({ items: await Address.find({ user: req.user!._id }).sort({ updatedAt: -1 }) });
});

addressRouter.post('/', async (req, res) => {
  const body = addressInput.parse(req.body);
  if ((await Address.countDocuments({ user: req.user!._id })) >= 20) {
    throw new ApiError(400, 'address_limit', 'You can save up to 20 addresses.');
  }
  res.status(201).json({ address: await Address.create({ ...body, user: req.user!._id }) });
});

addressRouter.patch('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = addressInput.partial().parse(req.body);
  const address = await Address.findOneAndUpdate({ _id: id, user: req.user!._id }, body, {
    returnDocument: 'after',
    runValidators: true,
  });
  if (!address) throw new ApiError(404, 'not_found', 'Address not found.');
  res.json({ address });
});

addressRouter.delete('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  await Address.deleteOne({ _id: id, user: req.user!._id });
  res.status(204).end();
});

export const checkoutRouter = Router();
checkoutRouter.use(optionalAuth);

checkoutRouter.post('/quote', async (req, res) => {
  const where = location.parse(req.body);
  const cart = await findCart(req);
  const priced = await priceCart(cart, { userId: req.user?._id });
  const charge = await findCharge(where);
  if (!charge) throw NO_DELIVERY;
  res.json({
    subtotal: priced.subtotal,
    discount: priced.discount,
    deliveryCharge: charge.charge,
    total: roundMoney(priced.subtotal - priced.discount + charge.charge),
  });
});

checkoutRouter.post('/', limiters.checkout, async (req, res) => {
  const body = checkoutBody.parse(req.body);
  const ownerKey = ownerKeyOf(req);
  const cart = await findCart(req);
  if (!ownerKey) throw new ApiError(400, 'empty_cart', 'Your cart is empty.');

  // Same key again means a double click or a retry after a lost response.
  const previous = await Order.findOne({ ownerKey, idempotencyKey: body.idempotencyKey });
  if (previous) {
    res.json(placedResponse(previous));
    return;
  }

  const isEsewa = body.paymentMethod === 'esewa';
  const payments = await getPaymentSettings();
  if (!payments[body.paymentMethod] || (isEsewa && !isEsewaConfigured())) {
    throw new ApiError(400, 'payment_unavailable', 'This payment method is not available right now. Please choose another.');
  }

  if (!cart?.items.length) throw new ApiError(400, 'empty_cart', 'Your cart is empty.');

  let address: IAddress;
  if (body.addressId) {
    if (!req.user) throw new ApiError(400, 'invalid_address', 'Please enter a delivery address.');
    const saved = await Address.findOne({ _id: body.addressId, user: req.user._id }).lean();
    if (!saved) throw new ApiError(404, 'not_found', 'Address not found.');
    address = saved;
  } else {
    address = body.address!;
  }

  const email = req.user?.email ?? body.email;
  const phone = normalizePhone(address.phone);
  const priced = await priceCart(cart, { userId: req.user?._id, phone });
  if (priced.hasIssues) {
    throw new ApiError(409, 'cart_changed', 'Some items in your cart are no longer available. Please review your cart.');
  }
  if (cart.couponCode && priced.couponError) throw new ApiError(409, 'invalid_coupon', priced.couponError);

  const charge = await findCharge({ province: address.province, district: address.district, city: address.city });
  if (!charge) throw NO_DELIVERY;

  const total = roundMoney(priced.subtotal - priced.discount + charge.charge);
  if (total !== body.expectedTotal) {
    throw new ApiError(409, 'total_changed', 'The total has changed. Please check it and try again.', { total });
  }

  const session = await mongoose.startSession();
  try {
    let order: OrderDocument | undefined;
    await session.withTransaction(async () => {
      for (const line of priced.lines) {
        // The stock condition and the decrement are one atomic step, so two
        // customers cannot both buy the last item.
        const updated = await Product.updateOne(
          { _id: line.productId, status: 'published', stock: { $gte: line.quantity } },
          { $inc: { stock: -line.quantity } },
          { session }
        );
        if (!updated.modifiedCount) {
          throw new ApiError(409, 'insufficient_stock', `${line.name} no longer has enough stock.`);
        }
      }

      if (priced.couponCode) {
        const coupon = await Coupon.findOneAndUpdate(
          {
            code: priced.couponCode,
            active: true,
            $expr: { $lt: ['$usedCount', '$usageLimit'] },
          },
          { $inc: { usedCount: 1 } },
          { session }
        );
        if (!coupon) throw new ApiError(409, 'invalid_coupon', 'This coupon has run out.');
      }

      const now = new Date();
      [order] = await Order.create(
        [
          {
            orderNumber: `AL-${now.getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`,
            ownerKey,
            idempotencyKey: body.idempotencyKey,
            user: req.user?._id,
            email,
            items: priced.lines.map((line) => ({
              product: line.productId,
              name: line.name,
              slug: line.slug,
              imageUrl: line.imageUrl,
              imagePublicId: line.imagePublicId,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
            })),
            address: {
              firstName: address.firstName,
              lastName: address.lastName,
              phone: address.phone,
              province: address.province,
              district: address.district,
              city: address.city,
              street: address.street,
              landmark: address.landmark,
              additionalInfo: address.additionalInfo,
            },
            subtotal: priced.subtotal,
            discount: priced.discount,
            couponCode: priced.couponCode,
            deliveryCharge: charge.charge,
            total,
            paymentMethod: body.paymentMethod,
            paymentStatus: isEsewa ? 'payment_pending' : 'unpaid',
            status: isEsewa ? 'pending_payment' : 'confirmed',
            hearAboutUs: body.hearAboutUs,
            statusHistory: [{ status: isEsewa ? 'pending_payment' : 'confirmed', at: now }],
            ...(isEsewa && {
              esewa: { transactionUuid: randomUUID() },
              paymentExpiresAt: new Date(now.getTime() + PAYMENT_WINDOW_MS),
            }),
          },
        ],
        { session }
      );

      if (priced.couponCode) {
        const coupon = await Coupon.findOne({ code: priced.couponCode }).session(session);
        await CouponRedemption.create(
          [{ coupon: coupon!._id, user: req.user?._id, phone, order: order!._id, discount: priced.discount }],
          { session }
        );
      }

      // An eSewa cart stays until payment succeeds, so a failed payment loses nothing.
      if (!isEsewa) {
        await Cart.updateOne({ _id: cart._id }, { $set: { items: [] }, $unset: { couponCode: 1 } }, { session });
      }

      if (req.user && body.saveAddress && !body.addressId) {
        await Address.create([{ ...address, user: req.user._id }], { session });
      }
    });
    if (!isEsewa) sendOrderEmail(order!, 'Thank you for your order');
    res.status(201).json(placedResponse(order!));
  } catch (err) {
    // Two identical requests raced: the first won, so return its order.
    if ((err as { code?: number }).code === 11000) {
      const winner = await Order.findOne({ ownerKey, idempotencyKey: body.idempotencyKey });
      if (winner) {
        res.json(placedResponse(winner));
        return;
      }
    }
    throw err;
  } finally {
    await session.endSession();
  }
});
