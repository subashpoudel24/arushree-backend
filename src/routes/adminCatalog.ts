import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import {
  cleanRichText,
  escapeRegex,
  idParams,
  imageInput,
  objectId,
  paged,
  pagination,
  slugSchema,
  slugify,
} from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { imageUpload } from '../middleware/upload.js';
import { Category, SECTIONS } from '../models/Category.js';
import { Favorite } from '../models/Favorite.js';
import { Media } from '../models/Media.js';
import { IProduct, Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { deleteMedia, imageStorage, releaseImages } from '../services/images.js';

const canManageCatalog = requirePermission('products.write');
const notFound = (label: string) => new ApiError(404, 'not_found', `${label} not found.`);

// A slug is the product's address, so taken ones get a numeric suffix.
const uniqueSlug = async (
  model: { exists: (filter: Record<string, unknown>) => unknown },
  base: string,
  excludeId?: string
) => {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; ; n += 1) {
    const taken = await model.exists({ slug: candidate, ...(excludeId && { _id: { $ne: excludeId } }) });
    if (!taken) return candidate;
    candidate = `${root}-${n}`;
  }
};

const productFields = z.object({
  name: z.string().trim().min(2, 'Please enter a product name.').max(200),
  slug: slugSchema.optional(),
  shortDescription: z.string().trim().max(500).default(''),
  description: z.string().max(50_000).default(''),
  price: z.number().min(0, 'Price cannot be negative.'),
  compareAtPrice: z.number().min(0).nullable().optional(),
  stock: z.number().int().min(0, 'Stock cannot be negative.'),
  status: z.enum(['draft', 'published']).default('draft'),
  featured: z.boolean().default(false),
  images: z.array(imageInput).max(12).default([]),
  specifications: z
    .array(z.object({ title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(500) }))
    .max(50)
    .default([]),
  categories: z.array(objectId).max(20).default([]),
  seoTitle: z.string().trim().max(120).optional(),
  seoDescription: z.string().trim().max(300).optional(),
});

const assertCategoriesExist = async (ids: string[] | undefined) => {
  if (!ids?.length) return;
  const found = await Category.countDocuments({ _id: { $in: ids } });
  if (found !== new Set(ids).size) {
    throw new ApiError(400, 'invalid_category', 'One of the selected categories does not exist.');
  }
};

const assertPrices = (price: number, compareAtPrice?: number | null) => {
  if (compareAtPrice != null && compareAtPrice < price) {
    throw new ApiError(400, 'invalid_price', 'The crossed-out price cannot be lower than the selling price.');
  }
};

const productListQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  status: z.enum(['draft', 'published']).optional(),
});

export const adminCatalogRouter = Router();

adminCatalogRouter.get('/products', requirePermission('products.read'), async (req, res) => {
  const { page, limit, q, status } = productListQuery.parse(req.query);
  const filter = {
    ...(status && { status }),
    ...(q && { name: { $regex: escapeRegex(q), $options: 'i' } }),
  };
  const [items, total] = await Promise.all([
    Product.find(filter)
      .populate('categories', 'name slug section')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter),
  ]);
  res.json(paged(items, total, page, limit));
});

const csvColumns = ['name', 'slug', 'shortDescription', 'description', 'price', 'compareAtPrice', 'stock', 'status', 'featured', 'categories', 'seoTitle', 'seoDescription'] as const;

// Stops spreadsheet programs running product text as formulas; import undoes it.
const csvSafe = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};
const csvRestore = (value: string) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

adminCatalogRouter.get('/products/export', requirePermission('products.read'), async (_req, res) => {
  const products = await Product.find().populate<{ categories: { slug: string }[] }>('categories', 'slug').sort({ name: 1 });
  const rows = products.map((product) => [
    csvSafe(product.name),
    product.slug,
    csvSafe(product.shortDescription),
    csvSafe(product.description),
    product.price,
    product.compareAtPrice ?? '',
    product.stock,
    product.status,
    product.featured,
    product.categories.map((category) => category.slug).join(';'),
    csvSafe(product.seoTitle),
    csvSafe(product.seoDescription),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
  res.send(stringify(rows, { header: true, columns: [...csvColumns], bom: true }));
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file');

const csvRow = z.object({
  name: z.string().trim().min(2, 'name is required'),
  slug: slugSchema.optional(),
  shortDescription: z.string().trim().max(500).default(''),
  description: z.string().max(50_000).default(''),
  price: z.coerce.number({ error: 'price must be a number' }).min(0),
  compareAtPrice: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).optional()),
  stock: z.coerce.number({ error: 'stock must be a whole number' }).int().min(0),
  status: z.enum(['draft', 'published']).default('draft'),
  featured: z.preprocess((v) => String(v ?? '').toLowerCase() === 'true', z.boolean()),
  categories: z.string().default(''),
  seoTitle: z.string().trim().max(120).optional(),
  seoDescription: z.string().trim().max(300).optional(),
});

// Creates or updates by slug. One bad row rejects the file and changes nothing.
// Images are never touched here: they are added on the product's own page.
adminCatalogRouter.post('/products/import', canManageCatalog, csvUpload, async (req, res) => {
  if (!req.file) throw new ApiError(400, 'invalid_file', 'Please choose a CSV file.');
  let records: Record<string, string>[];
  try {
    records = parse(req.file.buffer, { columns: (h: string[]) => h.map((c) => c.trim()), skip_empty_lines: true, trim: true, bom: true });
  } catch {
    throw new ApiError(400, 'invalid_file', 'This file could not be read as a CSV.');
  }
  if (!records.length) throw new ApiError(400, 'invalid_file', 'This file has no rows.');

  const categories = await Category.find().select('slug');
  const categoryIds = new Map(categories.map((category) => [category.slug, category._id]));

  const rows = records.map((record, index) => {
    const line = `Row ${index + 2}`;
    const cleaned = Object.fromEntries(
      // Empty cells mean "not provided", so optional fields and defaults apply.
      Object.entries(record)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => [key, csvRestore(value)])
    );
    const parsed = csvRow.safeParse(cleaned);
    if (!parsed.success) throw new ApiError(400, 'invalid_file', `${line}: ${parsed.error.issues[0].message}`);
    const row = parsed.data;
    if (row.compareAtPrice != null && row.compareAtPrice < row.price) {
      throw new ApiError(400, 'invalid_file', `${line}: compareAtPrice cannot be lower than price`);
    }
    const slugs = row.categories.split(';').map((slug) => slug.trim()).filter(Boolean);
    const unknown = slugs.find((slug) => !categoryIds.has(slug));
    if (unknown) throw new ApiError(400, 'invalid_file', `${line}: unknown category "${unknown}"`);
    return {
      ...row,
      slug: row.slug ?? slugify(row.name),
      description: cleanRichText(row.description),
      categories: slugs.map((slug) => categoryIds.get(slug)!),
    };
  });
  if (new Set(rows.map((row) => row.slug)).size !== rows.length) {
    throw new ApiError(400, 'invalid_file', 'This file lists the same product twice.');
  }

  let created = 0;
  let updated = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      created = 0;
      updated = 0;
      for (const row of rows) {
        const result = await Product.updateOne({ slug: row.slug }, { $set: row }, { upsert: true, session, runValidators: true });
        if (result.upsertedCount) created += 1;
        else updated += 1;
      }
    });
  } finally {
    await session.endSession();
  }
  res.json({ created, updated });
});

adminCatalogRouter.get('/products/:id', requirePermission('products.read'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const product = await Product.findById(id).populate('categories', 'name slug section');
  if (!product) throw notFound('Product');
  res.json({ product });
});

adminCatalogRouter.post('/products', canManageCatalog, async (req, res) => {
  const body = productFields.parse(req.body);
  assertPrices(body.price, body.compareAtPrice);
  await assertCategoriesExist(body.categories);
  const product = await Product.create({
    ...body,
    compareAtPrice: body.compareAtPrice ?? undefined,
    description: cleanRichText(body.description),
    slug: await uniqueSlug(Product, body.slug ?? body.name),
  });
  res.status(201).json({ product });
});

adminCatalogRouter.patch('/products/:id', canManageCatalog, async (req, res) => {
  const { id } = idParams.parse(req.params);
  // Without this, .partial() would keep .default() and blank out omitted fields.
  const body = productFields
    .extend({
      shortDescription: z.string().trim().max(500),
      description: z.string().max(50_000),
      status: z.enum(['draft', 'published']),
      featured: z.boolean(),
      images: z.array(imageInput).max(12),
      specifications: productFields.shape.specifications.unwrap(),
      categories: z.array(objectId).max(20),
    })
    .partial()
    .parse(req.body);
  const product = await Product.findById(id);
  if (!product) throw notFound('Product');

  assertPrices(
    body.price ?? product.price,
    body.compareAtPrice === undefined ? product.compareAtPrice : body.compareAtPrice
  );
  await assertCategoriesExist(body.categories);

  const previousImages = product.images.map((image) => image.publicId);
  const { compareAtPrice, description, slug, ...rest } = body;
  product.set(rest);
  if (compareAtPrice !== undefined) product.compareAtPrice = compareAtPrice ?? undefined;
  if (description !== undefined) product.description = cleanRichText(description);
  if (slug && slug !== product.slug) product.slug = await uniqueSlug(Product, slug, id);
  await product.save();

  const kept = new Set(product.images.map((image) => image.publicId));
  await releaseImages(previousImages.filter((publicId) => !kept.has(publicId)));
  res.json({ product });
});

adminCatalogRouter.delete('/products/:id', canManageCatalog, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const product = await Product.findByIdAndDelete(id);
  if (!product) throw notFound('Product');
  await Promise.all([Review.deleteMany({ product: id }), Favorite.deleteMany({ product: id })]);
  await releaseImages(product.images.map((image: IProduct['images'][number]) => image.publicId));
  res.status(204).end();
});

const categoryFields = z.object({
  name: z.string().trim().min(2, 'Please enter a category name.').max(100),
  slug: slugSchema.optional(),
  section: z.enum(SECTIONS),
  image: imageInput.nullable().optional(),
  displayOrder: z.number().int().min(0).max(100_000).optional(),
  active: z.boolean().optional(),
});

adminCatalogRouter.get('/categories', requirePermission('products.read'), async (_req, res) => {
  const items = await Category.find().sort({ displayOrder: 1, name: 1 });
  res.json({ items });
});

adminCatalogRouter.post('/categories', canManageCatalog, async (req, res) => {
  const body = categoryFields.parse(req.body);
  const category = await Category.create({
    ...body,
    image: body.image ?? undefined,
    slug: await uniqueSlug(Category, body.slug ?? body.name),
  });
  res.status(201).json({ category });
});

adminCatalogRouter.patch('/categories/:id', canManageCatalog, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = categoryFields.partial().parse(req.body);
  const category = await Category.findById(id);
  if (!category) throw notFound('Category');
  const previousImage = category.image?.publicId;
  const { image, slug, ...rest } = body;
  category.set(rest);
  if (image !== undefined) category.image = image ?? undefined;
  if (slug && slug !== category.slug) category.slug = await uniqueSlug(Category, slug, id);
  await category.save();
  if (previousImage !== category.image?.publicId) await releaseImages([previousImage]);
  res.json({ category });
});

adminCatalogRouter.delete('/categories/:id', canManageCatalog, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const inUse = await Product.countDocuments({ categories: id });
  if (inUse) {
    throw new ApiError(409, 'category_in_use', `${inUse} product(s) use this category. Move them first.`);
  }
  const category = await Category.findByIdAndDelete(id);
  if (!category) throw notFound('Category');
  await releaseImages([category.image?.publicId]);
  res.status(204).end();
});

adminCatalogRouter.get('/media', requirePermission('media.write'), async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const [items, total] = await Promise.all([
    Media.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Media.countDocuments(),
  ]);
  res.json(paged(items, total, page, limit));
});

adminCatalogRouter.post('/media', requirePermission('media.write'), imageUpload, async (req, res) => {
  const file = req.file!;
  const stored = await imageStorage.upload(file.buffer, 'library');
  const media = await Media.create({ ...stored, filename: file.originalname, uploadedBy: req.user!._id });
  res.status(201).json({ media });
});

adminCatalogRouter.delete('/media/:id', requirePermission('media.delete'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const media = await Media.findById(id);
  if (!media) throw notFound('Image');
  await deleteMedia(media.publicId);
  res.status(204).end();
});
