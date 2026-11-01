import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { isProduction } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { Cart, CartDocument, Coupon, CouponDocument, CouponRedemption, ICart } from '../models/Commerce.js';
import { IProduct, Product } from '../models/Product.js';
import { hashToken } from './tokens.js';

export const GUEST_COOKIE = 'guest_cart';
const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_LINE_QUANTITY = 99;

export const roundMoney = (value: number) => Math.round(value * 100) / 100;
export const normalizePhone = (phone: string) => phone.replace(/\D/g, '').replace(/^977(?=\d{10}$)/, '');

const clearGuestCookie = (res: Response) => res.clearCookie(GUEST_COOKIE, { path: '/' });

const guestHashFrom = (req: Request) => {
  const id = req.cookies?.[GUEST_COOKIE];
  return typeof id === 'string' && id ? hashToken(id) : undefined;
};

export const ownerKeyOf = (req: Request) => {
  if (req.user) return `u:${req.user.id}`;
  const hash = guestHashFrom(req);
  return hash ? `g:${hash}` : undefined;
};

export const findCart = async (req: Request) => {
  if (req.user) return Cart.findOne({ user: req.user._id });
  const guestHash = guestHashFrom(req);
  return guestHash ? Cart.findOne({ guestHash }) : null;
};

export const findOrCreateCart = async (req: Request, res: Response): Promise<CartDocument> => {
  const existing = await findCart(req);
  if (existing) {
    if (!req.user) existing.expiresAt = new Date(Date.now() + GUEST_TTL_MS);
    return existing;
  }
  if (req.user) return Cart.create({ user: req.user._id, items: [] });

  const id = randomBytes(32).toString('base64url');
  res.cookie(GUEST_COOKIE, id, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: GUEST_TTL_MS,
  });
  // Later code in this request must see the same owner.
  req.cookies[GUEST_COOKIE] = id;
  return Cart.create({ guestHash: hashToken(id), items: [], expiresAt: new Date(Date.now() + GUEST_TTL_MS) });
};

// Runs at sign-in. A failure must never stop someone logging in.
export const mergeGuestCart = async (req: Request, res: Response, userId: string) => {
  const guestHash = guestHashFrom(req);
  if (!guestHash) return;
  try {
    const guest = await Cart.findOne({ guestHash });
    if (guest?.items.length) {
      const cart = (await Cart.findOne({ user: userId })) ?? new Cart({ user: userId, items: [] });
      for (const item of guest.items) {
        const line = cart.items.find((existing) => existing.product.equals(item.product));
        if (line) line.quantity = Math.min(line.quantity + item.quantity, MAX_LINE_QUANTITY);
        else cart.items.push({ product: item.product, quantity: item.quantity });
      }
      cart.couponCode ??= guest.couponCode;
      await cart.save();
    }
    if (guest) await guest.deleteOne();
    clearGuestCookie(res);
  } catch (err) {
    logger.error({ err }, 'Could not merge guest cart');
  }
};

export interface PricedLine {
  productId: string;
  name: string;
  slug: string;
  imageUrl?: string;
  imagePublicId?: string;
  unitPrice: number;
  compareAtPrice?: number;
  quantity: number;
  stock: number;
  lineTotal: number;
  issue?: 'unavailable' | 'insufficient_stock';
}

interface CouponContext {
  userId?: Types.ObjectId;
  phone?: string;
}

const checkCoupon = async (coupon: CouponDocument | null, lines: PricedLine[], ctx: CouponContext) => {
  const now = new Date();
  if (!coupon || !coupon.active || coupon.validFrom > now || coupon.validTill < now) {
    return { error: 'This coupon is not valid.' };
  }
  if (coupon.usedCount >= coupon.usageLimit) return { error: 'This coupon has run out.' };

  const eligible = lines.filter(
    (line) => !line.issue && (!coupon.product || coupon.product.toString() === line.productId)
  );
  if (!eligible.length) return { error: 'This coupon does not apply to the items in your cart.' };

  const who = [
    ...(ctx.userId ? [{ user: ctx.userId }] : []),
    ...(ctx.phone ? [{ phone: normalizePhone(ctx.phone) }] : []),
  ];
  if (who.length) {
    const used = await CouponRedemption.countDocuments({ coupon: coupon._id, $or: who });
    if (used >= coupon.perCustomerLimit) return { error: 'You have already used this coupon.' };
  }

  const base = eligible.reduce((sum, line) => sum + line.lineTotal, 0);
  return { discount: roundMoney(Math.min((base * coupon.discountPercent) / 100, coupon.maxDiscount)) };
};

export const validateCoupon = async (code: string, lines: PricedLine[], ctx: CouponContext) =>
  checkCoupon(await Coupon.findOne({ code: code.trim().toUpperCase() }), lines, ctx);

// The one place totals are worked out. Prices always come from the database.
export const priceCart = async (cart: Pick<ICart, 'items' | 'couponCode'> | null, ctx: CouponContext) => {
  const items = cart?.items ?? [];
  const products = await Product.find({ _id: { $in: items.map((item) => item.product) } });
  const byId = new Map(products.map((product) => [product.id as string, product]));

  const lines: PricedLine[] = items.map((item) => {
    const product = byId.get(item.product.toString());
    const data: Partial<IProduct> = product ?? {};
    const unitPrice = data.price ?? 0;
    const stock = data.stock ?? 0;
    let issue: PricedLine['issue'];
    if (!product || product.status !== 'published') issue = 'unavailable';
    else if (stock < item.quantity) issue = 'insufficient_stock';
    return {
      productId: item.product.toString(),
      name: data.name ?? 'Product no longer available',
      slug: data.slug ?? '',
      imageUrl: data.images?.[0]?.url,
      imagePublicId: data.images?.[0]?.publicId,
      unitPrice,
      compareAtPrice: data.compareAtPrice,
      quantity: item.quantity,
      stock,
      lineTotal: roundMoney(unitPrice * item.quantity),
      issue,
    };
  });

  const subtotal = roundMoney(lines.filter((line) => !line.issue).reduce((sum, line) => sum + line.lineTotal, 0));

  let discount = 0;
  let couponError: string | undefined;
  if (cart?.couponCode) {
    const result = await validateCoupon(cart.couponCode, lines, ctx);
    discount = result.discount ?? 0;
    couponError = result.error;
  }

  return {
    lines,
    subtotal,
    discount,
    couponCode: cart?.couponCode && !couponError ? cart.couponCode : undefined,
    couponError,
    hasIssues: lines.some((line) => line.issue),
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
};

export const requireProductForCart = async (productId: string, quantity: number) => {
  const product = await Product.findOne({ _id: productId, status: 'published' });
  if (!product) throw new ApiError(404, 'not_found', 'This product is no longer available.');
  if (product.stock < quantity) {
    throw new ApiError(
      409,
      'insufficient_stock',
      product.stock ? `Only ${product.stock} left in stock.` : 'This product is sold out.'
    );
  }
};
