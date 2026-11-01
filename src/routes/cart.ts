import { Request, Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { objectId } from '../lib/validation.js';
import { optionalAuth } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import {
  MAX_LINE_QUANTITY,
  findCart,
  findOrCreateCart,
  priceCart,
  requireProductForCart,
  validateCoupon,
} from '../services/cart.js';

const quantity = z.number().int().min(1, 'Quantity must be at least 1.').max(MAX_LINE_QUANTITY);
const addBody = z.object({ productId: objectId, quantity: quantity.default(1) });
const updateBody = z.object({ quantity });
const lineParams = z.object({ productId: objectId });
const couponBody = z.object({ code: z.string().trim().min(1, 'Please enter a coupon code.').max(50) });

const contextOf = (req: Request) => ({ userId: req.user?._id });

export const cartRouter = Router();
cartRouter.use(optionalAuth);

cartRouter.get('/', async (req, res) => {
  const cart = await findCart(req);
  res.json({ cart: await priceCart(cart, contextOf(req)) });
});

cartRouter.post('/items', async (req, res) => {
  const body = addBody.parse(req.body);
  const cart = await findOrCreateCart(req, res);
  const line = cart.items.find((item) => item.product.toString() === body.productId);
  const next = (line?.quantity ?? 0) + body.quantity;
  if (next > MAX_LINE_QUANTITY) {
    throw new ApiError(400, 'quantity_limit', `You can add up to ${MAX_LINE_QUANTITY} of one product.`);
  }
  await requireProductForCart(body.productId, next);
  if (line) line.quantity = next;
  else cart.items.push({ product: body.productId as never, quantity: body.quantity });
  await cart.save();
  res.status(201).json({ cart: await priceCart(cart, contextOf(req)) });
});

cartRouter.patch('/items/:productId', async (req, res) => {
  const { productId } = lineParams.parse(req.params);
  const body = updateBody.parse(req.body);
  const cart = await findCart(req);
  const line = cart?.items.find((item) => item.product.toString() === productId);
  if (!cart || !line) throw new ApiError(404, 'not_found', 'This item is not in your cart.');
  await requireProductForCart(productId, body.quantity);
  line.quantity = body.quantity;
  await cart.save();
  res.json({ cart: await priceCart(cart, contextOf(req)) });
});

cartRouter.delete('/items/:productId', async (req, res) => {
  const { productId } = lineParams.parse(req.params);
  const cart = await findCart(req);
  if (cart) {
    cart.items = cart.items.filter((item) => item.product.toString() !== productId);
    await cart.save();
  }
  res.json({ cart: await priceCart(cart, contextOf(req)) });
});

cartRouter.post('/coupon', limiters.checkout, async (req, res) => {
  const { code } = couponBody.parse(req.body);
  const cart = await findCart(req);
  if (!cart?.items.length) throw new ApiError(400, 'empty_cart', 'Your cart is empty.');
  const priced = await priceCart({ items: cart.items }, contextOf(req));
  const result = await validateCoupon(code, priced.lines, contextOf(req));
  if (result.error) throw new ApiError(400, 'invalid_coupon', result.error);
  cart.couponCode = code.toUpperCase();
  await cart.save();
  res.json({ cart: await priceCart(cart, contextOf(req)) });
});

cartRouter.delete('/coupon', async (req, res) => {
  const cart = await findCart(req);
  if (cart) {
    cart.couponCode = undefined;
    await cart.save();
  }
  res.json({ cart: await priceCart(cart, contextOf(req)) });
});
