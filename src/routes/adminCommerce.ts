import { parse } from 'csv-parse/sync';
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { idParams, objectId, paged, pagination } from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { Coupon, DeliveryCharge } from '../models/Commerce.js';

const manageCoupons = requirePermission('coupons');
const manageDelivery = requirePermission('delivery');

const couponFields = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,50}$/, 'Use 3 to 50 letters, numbers, hyphens or underscores.'),
  description: z.string().trim().max(300).default(''),
  discountPercent: z.number().gt(0, 'Discount must be above 0%.').max(100),
  maxDiscount: z.number().min(0),
  validFrom: z.coerce.date(),
  validTill: z.coerce.date(),
  active: z.boolean().default(true),
  usageLimit: z.number().int().min(0),
  perCustomerLimit: z.number().int().min(1).default(1),
  product: objectId.nullable().optional(),
});

const assertDates = (from?: Date, till?: Date) => {
  if (from && till && till <= from) {
    throw new ApiError(400, 'invalid_dates', 'The end date must be after the start date.');
  }
};

const chargeFields = z.object({
  province: z.string().trim().toLowerCase().min(1, 'Province is required.').max(100),
  district: z.string().trim().toLowerCase().min(1, 'District is required.').max(100),
  city: z.string().trim().toLowerCase().min(1, 'City is required.').max(100),
  charge: z.coerce.number().min(0, 'Charge cannot be negative.'),
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');

export const adminCommerceRouter = Router();

adminCommerceRouter.get('/coupons', manageCoupons, async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const [items, total] = await Promise.all([
    Coupon.find()
      .populate('product', 'name slug')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Coupon.countDocuments(),
  ]);
  res.json(paged(items, total, page, limit));
});

adminCommerceRouter.post('/coupons', manageCoupons, async (req, res) => {
  const body = couponFields.parse(req.body);
  assertDates(body.validFrom, body.validTill);
  res.status(201).json({ coupon: await Coupon.create({ ...body, product: body.product ?? undefined }) });
});

adminCommerceRouter.patch('/coupons/:id', manageCoupons, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = couponFields.partial().parse(req.body);
  const coupon = await Coupon.findById(id);
  if (!coupon) throw new ApiError(404, 'not_found', 'Coupon not found.');
  assertDates(body.validFrom ?? coupon.validFrom, body.validTill ?? coupon.validTill);
  const { product, ...rest } = body;
  coupon.set(rest);
  if (product !== undefined) coupon.set('product', product ?? undefined);
  await coupon.save();
  res.json({ coupon });
});

adminCommerceRouter.delete('/coupons/:id', manageCoupons, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await Coupon.deleteOne({ _id: id });
  res.status(204).end();
});

adminCommerceRouter.get('/delivery-charges', manageDelivery, async (_req, res) => {
  res.json({ items: await DeliveryCharge.find().sort({ province: 1, district: 1, city: 1 }) });
});

adminCommerceRouter.post('/delivery-charges', manageDelivery, async (req, res) => {
  res.status(201).json({ charge: await DeliveryCharge.create(chargeFields.parse(req.body)) });
});

adminCommerceRouter.patch('/delivery-charges/:id', manageDelivery, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const charge = await DeliveryCharge.findByIdAndUpdate(id, chargeFields.partial().parse(req.body), {
    returnDocument: 'after',
    runValidators: true,
  });
  if (!charge) throw new ApiError(404, 'not_found', 'Delivery charge not found.');
  res.json({ charge });
});

adminCommerceRouter.delete('/delivery-charges/:id', manageDelivery, async (req, res) => {
  const { id } = idParams.parse(req.params);
  await DeliveryCharge.deleteOne({ _id: id });
  res.status(204).end();
});

// Replaces the whole list. One bad row rejects the file and changes nothing.
adminCommerceRouter.post('/delivery-charges/import', manageDelivery, csvUpload, async (req, res) => {
  if (!req.file) throw new ApiError(400, 'invalid_file', 'Please choose a CSV file.');
  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch {
    throw new ApiError(400, 'invalid_file', 'This file could not be read as a CSV.');
  }
  if (!records.length) throw new ApiError(400, 'invalid_file', 'This file has no rows.');

  const rows = records.map((record, index) => {
    const parsed = chargeFields.safeParse(record);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_file', `Row ${index + 2}: ${parsed.error.issues[0].message}`);
    }
    return parsed.data;
  });
  const keys = new Set(rows.map((row) => `${row.province}|${row.district}|${row.city}`));
  if (keys.size !== rows.length) throw new ApiError(400, 'invalid_file', 'This file lists the same location twice.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await DeliveryCharge.deleteMany({}, { session });
      await DeliveryCharge.insertMany(rows, { session });
    });
  } finally {
    await session.endSession();
  }
  res.json({ imported: rows.length });
});
