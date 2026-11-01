// Moves the old PostgreSQL store into MongoDB. Reads the old database only.
// Dry run unless `apply` is set. Re-runnable: a map of old ids to new ids means a
// second run only adds what is missing, and `refresh` re-copies existing records.
import { createHash } from 'crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Schema, Types, model } from 'mongoose';
import { logger } from '../lib/logger.js';
import { cleanRichText, slugify } from '../lib/validation.js';
import { Setting } from '../models/Admin.js';
import { Category, IImage, SECTIONS } from '../models/Category.js';
import { Address, Coupon, CouponRedemption, DeliveryCharge, Order, ORDER_STATUSES, PAYMENT_STATUSES } from '../models/Commerce.js';
import { Blog, ContactMessage, Testimonial } from '../models/Content.js';
import { Favorite } from '../models/Favorite.js';
import { Media } from '../models/Media.js';
import { Product } from '../models/Product.js';
import { Review } from '../models/Review.js';
import { User } from '../models/User.js';
import { roundMoney } from '../services/cart.js';
import { DEFAULT_HOMEPAGE } from '../services/content.js';
import { imageStorage, isAllowedImage } from '../services/images.js';
import { refreshProductRating } from '../services/ratings.js';

const migrationMapSchema = new Schema({
  table: { type: String, required: true },
  legacyId: { type: String, required: true },
  mongoId: { type: Schema.Types.ObjectId },
  image: { url: String, publicId: String },
});
migrationMapSchema.index({ table: 1, legacyId: 1 }, { unique: true });
export const MigrationMap = model('MigrationMap', migrationMapSchema);

export interface LegacySource {
  query: (sql: string) => Promise<{ rows: Row[] }>;
}

type Row = Record<string, any>;
// One helper writes to many collections, so it cannot use their individual types.
type AnyModel = any;

export interface MigrateOptions {
  source: LegacySource;
  apply: boolean;
  refresh?: boolean;
  uploadsDir: string;
  legacySiteUrl?: string;
}

export interface TableReport {
  source: number;
  excluded: number;
  created: number;
  updated: number;
  skipped: number;
  duplicates: number;
  failed: number;
  inTarget?: number;
}

const blankRow = (): TableReport => ({ source: 0, excluded: 0, created: 0, updated: 0, skipped: 0, duplicates: 0, failed: 0 });

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Not copied: shopping carts, login sessions and tokens are temporary, and review
// counts are recalculated from the real reviews.
export const NOT_MIGRATED = ['carts', 'cart_items', 'sessions', 'verificationtokens', 'ProductToReviewCount', 'country_info', 'contact_info'];

export const migrate = async ({ source, apply, refresh = false, uploadsDir, legacySiteUrl }: MigrateOptions) => {
  const tables: Record<string, TableReport> = {};
  const warnings: string[] = [];
  const images = { reused: 0, uploaded: 0, kept: 0, wouldUpload: 0, needDownload: 0, missing: 0, invalid: 0 };
  const warn = (text: string) => {
    warnings.push(text);
    logger.debug(text);
  };
  const stats = (table: string) => (tables[table] ??= blankRow());

  const maps = await MigrationMap.find().lean();
  const idMap = new Map(maps.filter((m) => m.mongoId).map((m) => [`${m.table}:${m.legacyId}`, m.mongoId as Types.ObjectId]));
  const imageMap = new Map(maps.filter((m) => m.table === 'image').map((m) => [m.legacyId, m.image as { url: string; publicId: string }]));
  const seen = new Map<string, Types.ObjectId>();
  const idOf = (table: string, legacyId: unknown) => (legacyId ? idMap.get(`${table}:${legacyId}`) : undefined);

  const remember = async (table: string, legacyId: string, mongoId: Types.ObjectId) => {
    idMap.set(`${table}:${legacyId}`, mongoId);
    if (apply) await MigrationMap.updateOne({ table, legacyId }, { $set: { mongoId } }, { upsert: true });
  };

  const put = async (
    table: string,
    legacyId: string,
    target: AnyModel,
    data: Row,
    opts: { natural?: Row; naturalKey?: string; neverRefresh?: boolean } = {}
  ) => {
    const report = stats(table);
    const known = idMap.get(`${table}:${legacyId}`);
    if (known) {
      if (!refresh || opts.neverRefresh) {
        report.skipped += 1;
        return known;
      }
      const doc = apply ? await target.findById(known) : null;
      if (apply && doc) {
        doc.set(data);
        await doc.save({ timestamps: false });
      }
      report.updated += 1;
      return known;
    }

    if (opts.natural) {
      const key = `${table}|${opts.naturalKey ?? JSON.stringify(opts.natural)}`;
      const duplicate = seen.get(key);
      if (duplicate) {
        report.duplicates += 1;
        await remember(table, legacyId, duplicate);
        return duplicate;
      }
      const existing = await target.findOne(opts.natural).select('_id');
      if (existing) {
        report.skipped += 1;
        seen.set(key, existing._id);
        await remember(table, legacyId, existing._id);
        return existing._id as Types.ObjectId;
      }
    }

    const id = new Types.ObjectId();
    const doc = new target({ _id: id, ...data });
    const invalid = doc.validateSync();
    if (invalid) {
      report.failed += 1;
      warn(`${table} ${legacyId}: ${Object.keys(invalid.errors).join(', ')} invalid`);
      return undefined;
    }
    if (apply) {
      try {
        await doc.save({ timestamps: false });
      } catch (err) {
        report.failed += 1;
        warn(`${table} ${legacyId}: could not save (${(err as Error).message.split('\n')[0]})`);
        return undefined;
      }
    }
    report.created += 1;
    if (opts.natural) seen.set(`${table}|${opts.naturalKey ?? JSON.stringify(opts.natural)}`, id);
    await remember(table, legacyId, id);
    return id;
  };

  const read = async (table: string) => {
    const exists = await source.query(`SELECT to_regclass('public."${table}"') AS name`);
    if (!exists.rows[0]?.name) {
      warn(`Old table ${table} does not exist`);
      return [];
    }
    return (await source.query(`SELECT * FROM "${table}"`)).rows;
  };

  let mediaOwner: Types.ObjectId | undefined;

  const uploadBuffer = async (original: string, buffer: Buffer, name: string) => {
    if (!isAllowedImage(buffer)) {
      images.invalid += 1;
      warn(`Image is not JPG, PNG or WebP: ${original}`);
      return undefined;
    }
    if (!apply) {
      images.wouldUpload += 1;
      return { url: original } as IImage;
    }
    const stored = await imageStorage.upload(buffer, 'migrated');
    await MigrationMap.updateOne(
      { table: 'image', legacyId: original },
      { $set: { image: { url: stored.url, publicId: stored.publicId } } },
      { upsert: true }
    );
    imageMap.set(original, { url: stored.url, publicId: stored.publicId });
    if (mediaOwner) await Media.create({ ...stored, filename: name.slice(-200), uploadedBy: mediaOwner });
    images.uploaded += 1;
    return { url: stored.url, publicId: stored.publicId } as IImage;
  };

  const download = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('larger than 15 MB');
    return buffer;
  };

  // Local copy first, then the old site. A failed image is reported and left out:
  // it must never stop the customer's order or product from moving across.
  const moveImage = async (original: unknown, alt?: string): Promise<IImage | undefined> => {
    if (typeof original !== 'string' || !original.trim()) return undefined;
    const url = original.trim().replace(/\\/g, '/'); // The old upload code could save backslashes.
    const withAlt = (image: IImage) => (alt ? { ...image, alt } : image);

    if (url.startsWith('/assets/') || url.startsWith('https://res.cloudinary.com/')) {
      images.kept += 1;
      return withAlt({ url });
    }
    const known = imageMap.get(url);
    if (known) {
      images.reused += 1;
      return withAlt(known);
    }

    try {
      if (url.startsWith('/')) {
        const relative = decodeURIComponent(url.split('?')[0]).replace(/^\/uploads\//, '');
        const root = resolve(uploadsDir);
        const file = resolve(join(root, relative));
        // Paths come from the database, so they must not reach outside the folder.
        if (file.startsWith(root + sep) && (await stat(file).catch(() => null))?.isFile()) {
          const stored = await uploadBuffer(url, await readFile(file), relative);
          return stored && withAlt(stored);
        }
        if (!legacySiteUrl) throw new Error('not in the local folder and no old site address set');
        if (!apply) {
          images.needDownload += 1;
          return withAlt({ url: '/assets/images/logo.png' });
        }
        const stored = await uploadBuffer(url, await download(new URL(url, legacySiteUrl).href), url);
        return stored && withAlt(stored);
      }
      if (/^https?:\/\//.test(url)) {
        if (!apply) {
          images.needDownload += 1;
          return withAlt({ url: '/assets/images/logo.png' });
        }
        const stored = await uploadBuffer(url, await download(url), url);
        return stored && withAlt(stored);
      }
      throw new Error('unrecognized address');
    } catch (err) {
      images.missing += 1;
      warn(`Image could not be moved: ${url} (${(err as Error).message})`);
      return undefined;
    }
  };

  // Dry-run placeholders must still pass validation for image fields.
  const dryImage = (image?: IImage) => (image && !apply && !image.url.startsWith('/') ? { ...image, url: '/assets/images/logo.png' } : image);

  const clamp = (value: unknown, low: number, high: number) => Math.min(high, Math.max(low, Number(value) || 0));
  const text = (value: unknown, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const date = (value: unknown) => (value ? new Date(value as string) : new Date());
  const stamps = (created: unknown, updated?: unknown) => ({ createdAt: date(created), updatedAt: date(updated ?? created) });

  // ---- Users ----
  const googleAccounts = new Map((await read('accounts')).filter((a) => a.provider === 'google').map((a) => [a.user_id, a.provider_account_id]));
  const legacyUsers = await read('users');
  stats('users').source = legacyUsers.length;
  // Staff first, so uploaded images have an owner in the media library.
  const sortedUsers = [...legacyUsers].sort((a, b) => (a.role === 'ADMIN' ? -1 : 0) - (b.role === 'ADMIN' ? -1 : 0));
  for (const row of sortedUsers) {
    const email = text(row.email).toLowerCase();
    // Temporary records the old guest checkout created. Their orders stay as guest orders.
    if (!email || (email.endsWith('@user.com') && !row.password)) {
      stats('users').excluded += 1;
      continue;
    }
    const avatar = await moveImage(row.image);
    const id = await put(
      'users',
      row.id,
      User,
      {
        name: text(row.name, email.split('@')[0]),
        email,
        passwordHash: row.password ?? undefined,
        googleId: googleAccounts.get(row.id),
        phone: text(row.phoneNumber) || undefined,
        avatarUrl: dryImage(avatar)?.url,
        avatarPublicId: avatar?.publicId,
        role: row.role === 'ADMIN' ? 'super_admin' : 'customer',
        status: 'active',
        emailVerified: !!row.email_verified,
        ...stamps(row.createdAt, row.updatedAt),
      },
      // A customer's password or role on the new site is never overwritten.
      { natural: { email }, neverRefresh: true }
    );
    if (row.role === 'ADMIN' && !mediaOwner) mediaOwner = id;
  }
  mediaOwner ??= (await User.findOne({ role: 'super_admin' }).select('_id'))?._id;

  // ---- Categories ----
  const legacyCategories = await read('categories');
  stats('categories').source = legacyCategories.length;
  for (const row of legacyCategories) {
    let section = row.section;
    if (!SECTIONS.includes(section)) {
      warn(`Category ${row.slug} has unknown section "${section}": set to skincare, please check it`);
      section = 'skincare';
    }
    const slug = text(row.slug, slugify(text(row.name, row.id)));
    await put(
      'categories',
      row.id,
      Category,
      { name: text(row.name, slug), slug, section, image: dryImage(await moveImage(row.image_url, row.name)), active: true, ...stamps(row.created_at, row.updated_at) },
      { natural: { slug } }
    );
  }

  // ---- Products ----
  const categoryLinks = await read('_CategoryToProduct');
  const legacyProducts = await read('products');
  stats('products').source = legacyProducts.length;
  const usedSlugs = new Set<string>();
  for (const row of legacyProducts) {
    let specs: unknown = row.product_specifications;
    if (typeof specs === 'string') {
      try {
        specs = JSON.parse(specs);
      } catch {
        specs = [];
      }
    }
    const specifications = (Array.isArray(specs) ? specs : [])
      .map((s: Row) => ({ title: text(s?.key ?? s?.title), description: text(s?.value ?? s?.description) }))
      .filter((s) => s.title && s.description);

    const moved: IImage[] = [];
    for (const url of row.image_urls ?? []) {
      const image = dryImage(await moveImage(url, row.display_name));
      if (image) moved.push(image);
    }
    if (!moved.length) warn(`Product ${row.slug ?? row.id} has no usable images`);

    const name = text(row.display_name, text(row.name, row.id));
    let slug = text(row.slug, slugify(name));
    if (usedSlugs.has(slug)) slug = `${slug}-${String(row.id).slice(-6)}`;
    usedSlugs.add(slug);

    const price = Math.max(Number(row.display_price) || 0, 0);
    const crossed = Number(row.crossed_price) || 0;
    await put(
      'products',
      row.id,
      Product,
      {
        name,
        slug,
        shortDescription: text(row.short_description),
        description: cleanRichText(text(row.full_description)),
        price,
        compareAtPrice: crossed > price ? crossed : undefined,
        stock: Math.max(Math.trunc(Number(row.quantity) || 0), 0),
        status: 'published', // The old site had no drafts.
        featured: !!row.featured,
        images: moved,
        specifications,
        categories: categoryLinks.filter((link) => link.B === row.id).map((link) => idOf('categories', link.A)).filter(Boolean),
        ...stamps(row.created_at, row.updated_at),
      },
      { natural: { slug } }
    );
  }

  // ---- Reviews and favorites ----
  const legacyReviews = await read('product_reviews');
  stats('reviews').source = legacyReviews.length;
  const reviewedProducts = new Set<Types.ObjectId>();
  for (const row of legacyReviews) {
    const product = idOf('products', row.product_id);
    const user = idOf('users', row.user_id);
    const rating = Math.round(Number(row.rating) || 0);
    if (!product || !user || rating < 1) {
      stats('reviews').excluded += 1;
      continue;
    }
    reviewedProducts.add(product);
    await put(
      'reviews',
      row.id,
      Review,
      { product, user, rating: clamp(rating, 1, 5), text: text(row.review_text, 'No comment.'), status: 'published' },
      { natural: { product, user }, naturalKey: `${product}|${user}` }
    );
  }

  const legacyFavorites = await read('user_to_fav_products');
  stats('favorites').source = legacyFavorites.length;
  for (const row of legacyFavorites) {
    const product = idOf('products', row.product_id);
    const user = idOf('users', row.user_id);
    if (!product || !user) {
      stats('favorites').excluded += 1;
      continue;
    }
    await put('favorites', `${row.user_id}|${row.product_id}`, Favorite, { product, user }, { natural: { product, user }, naturalKey: `${product}|${user}`, neverRefresh: true });
  }

  // ---- Coupons ----
  const legacyCoupons = await read('Coupon');
  const legacyRedemptions = await read('user_coupons');
  stats('coupons').source = legacyCoupons.length;
  for (const row of legacyCoupons) {
    const used = legacyRedemptions.filter((r) => r.coupon_id === row.id).length;
    const code = text(row.code, row.id).toUpperCase();
    await put(
      'coupons',
      row.id,
      Coupon,
      {
        code,
        description: text(row.description),
        discountPercent: clamp(row.discountPercentage, 0, 100),
        maxDiscount: Math.max(Number(row.max_discount) || 0, 0),
        validFrom: date(row.valid_from),
        validTill: date(row.valid_till),
        active: !!row.active,
        // The old "quantity" counted what was left. The new site counts total and used.
        usageLimit: Math.max(Number(row.quantity) || 0, 0) + used,
        usedCount: used,
        perCustomerLimit: 1,
        product: idOf('products', row.product_id),
        ...stamps(row.createdAt, row.updatedAt),
      },
      { natural: { code } }
    );
  }
  stats('coupon_redemptions').source = legacyRedemptions.length;
  for (const row of legacyRedemptions) {
    const coupon = idOf('coupons', row.coupon_id);
    const user = idOf('users', row.user_id);
    if (!coupon || !user) {
      stats('coupon_redemptions').excluded += 1;
      continue;
    }
    await put('coupon_redemptions', row.id, CouponRedemption, { coupon, user, discount: Math.max(Number(row.discount_amount) || 0, 0) }, { neverRefresh: true });
  }

  // ---- Delivery ----
  const legacyCharges = await read('delivery_charges');
  stats('delivery_charges').source = legacyCharges.length;
  for (const row of legacyCharges) {
    const city = text(row.city).toLowerCase();
    const province = text(row.province).toLowerCase();
    const district = text(row.district).toLowerCase() || city;
    if (!city || !province) {
      stats('delivery_charges').excluded += 1;
      warn(`Delivery charge ${row.id} has no city or province`);
      continue;
    }
    await put(
      'delivery_charges',
      row.id,
      DeliveryCharge,
      { province, district, city, charge: Math.max(Number(row.charge) || 0, 0) },
      { natural: { province, district, city } }
    );
  }

  // ---- Addresses and orders ----
  const legacyAddresses = await read('delivery_addresses');
  const addressById = new Map(legacyAddresses.map((a) => [a.id, a]));
  const addressFields = (row: Row) => {
    const city = text(row.city, 'unknown').toLowerCase();
    return {
      firstName: text(row.first_name, 'Customer'),
      lastName: text(row.last_name, '-'),
      phone: text(row.phone_number, 'Not provided'),
      province: text(row.province, 'unknown').toLowerCase(),
      district: text(row.district).toLowerCase() || city,
      city,
      street: [text(row.house_number), text(row.street_number)].filter(Boolean).join(', ') || undefined,
      landmark: text(row.neareast_landmark, 'Not provided'),
      additionalInfo: text(row.additional_info) || undefined,
    };
  };
  stats('addresses').source = legacyAddresses.length;
  for (const row of legacyAddresses) {
    const user = idOf('users', row.user_id);
    if (!user) {
      stats('addresses').excluded += 1; // Guest addresses live on inside their orders.
      continue;
    }
    await put('addresses', row.id, Address, { ...addressFields(row), user, ...stamps(row.created_at, row.updated_at) }, { neverRefresh: true });
  }

  const legacyItems = await read('order_items');
  const legacyPayments = await read('payments');
  const legacyOrders = await read('orders');
  stats('orders').source = legacyOrders.length;
  let totalMismatches = 0;
  for (const row of legacyOrders) {
    const address = addressById.get(row.delivery_address_id);
    if (!address) {
      stats('orders').failed += 1;
      warn(`Order ${row.id} has no delivery address`);
      continue;
    }
    const items = [];
    for (const item of legacyItems.filter((i) => i.order_id === row.id)) {
      const unitPrice = Number(item.display_price) || 0;
      const quantity = Math.max(Math.trunc(Number(item.quantity) || 1), 1);
      const image = await moveImage(item.image_urls?.[0]);
      items.push({
        // A product removed long ago still needs a reference; the copied details are what matter.
        product: idOf('products', item.product_id) ?? new Types.ObjectId(),
        name: text(item.display_name, text(item.productName, 'Product')),
        slug: slugify(text(item.productName, text(item.display_name, 'product'))),
        imageUrl: dryImage(image)?.url,
        imagePublicId: image?.publicId,
        unitPrice,
        quantity,
        lineTotal: roundMoney(unitPrice * quantity),
      });
    }
    if (!items.length) warn(`Order ${row.id} has no items`);

    const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
    const deliveryCharge = Number(row.delivery_charge) || 0;
    const discount = Math.max(Number(row.discount_amount) || 0, 0);
    const storedTotal = Number(row.total_price);
    const expected = roundMoney(subtotal - discount + deliveryCharge);
    // What the customer was actually charged is never recalculated.
    const total = Number.isFinite(storedTotal) ? storedTotal : expected;
    if (Math.abs(total - expected) > 0.01) {
      totalMismatches += 1;
      warn(`Order ${row.id}: stored total ${total} differs from calculated ${expected}; kept the stored total`);
    }

    let status = String(row.order_status).toLowerCase();
    if (!(ORDER_STATUSES as readonly string[]).includes(status)) {
      warn(`Order ${row.id} has unknown status ${row.order_status}: set to confirmed`);
      status = 'confirmed';
    }
    let paymentStatus = String(row.payment_status).toLowerCase();
    if (!(PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
      warn(`Order ${row.id} has unknown payment status ${row.payment_status}: set to unpaid`);
      paymentStatus = 'unpaid';
    }

    const user = idOf('users', row.user_id);
    const created = date(row.created_at);
    const legacyUser = legacyUsers.find((u) => u.id === row.user_id);
    const email = text(legacyUser?.email).toLowerCase();
    const uuid = legacyPayments.find((p) => p.order_id === row.id && p.transaction_uuid)?.transaction_uuid;
    // The same old id always gives the same number, so re-runs stay stable.
    const code = createHash('sha256').update(String(row.id)).digest('hex').slice(0, 8).toUpperCase();

    await put('orders', row.id, Order, {
      orderNumber: `AL-${created.getUTCFullYear()}-${code}`,
      ownerKey: user ? `u:${user}` : `legacy:${row.id}`,
      idempotencyKey: `legacy:${row.id}`,
      user,
      email: user && email ? email : undefined,
      items,
      address: addressFields(address),
      subtotal,
      discount,
      deliveryCharge,
      total,
      paymentMethod: row.payment_mode === 'ESEWA' ? 'esewa' : 'cod',
      paymentStatus,
      status,
      hearAboutUs: text(row.hear_about_us) || undefined,
      // Stock for old cancellations was settled on the old site. Never restore it again.
      stockReleased: status === 'canceled',
      ...(row.payment_mode === 'ESEWA' && uuid && { esewa: { transactionUuid: uuid } }),
      statusHistory: [{ status, at: date(row.updated_at ?? row.created_at), note: `Imported from the old site (${row.id})` }],
      ...stamps(row.created_at, row.updated_at),
    });
  }
  if (totalMismatches) warn(`${totalMismatches} order(s) have totals that differ from their items: the stored totals were kept`);

  // ---- Content ----
  const legacyBlogs = await read('blogs');
  stats('blogs').source = legacyBlogs.length;
  for (const row of legacyBlogs) {
    const slug = text(row.slug, slugify(text(row.title, row.id)));
    await put(
      'blogs',
      row.id,
      Blog,
      {
        title: text(row.title, slug),
        slug,
        excerpt: '',
        content: cleanRichText(text(row.content)),
        image: dryImage(await moveImage(row.image_url, row.title)),
        authorName: text(row.author_name),
        authorImage: dryImage(await moveImage(row.author_image)),
        status: row.published ? 'published' : 'draft',
        publishedAt: row.published ? date(row.created_at) : undefined,
        ...stamps(row.created_at, row.updated_at),
      },
      { natural: { slug } }
    );
  }

  const legacyTestimonials = await read('testimonials');
  stats('testimonials').source = legacyTestimonials.length;
  for (const row of legacyTestimonials) {
    await put('testimonials', row.id, Testimonial, {
      authorName: text(row.author_name, 'Customer'),
      authorImage: dryImage(await moveImage(row.author_image)),
      rating: clamp(row.rating, 1, 5),
      title: text(row.title),
      text: text(row.description, 'No comment.'),
      active: true,
      ...stamps(row.created_date, row.updated_date),
    });
  }

  const legacyMessages = await read('user_message');
  stats('messages').source = legacyMessages.length;
  for (const row of legacyMessages) {
    // Marked read so old messages do not bury new ones. The old table had no dates.
    await put(
      'messages',
      row.id,
      ContactMessage,
      { name: text(row.name, 'Unknown'), email: text(row.email, 'unknown@example.com'), subject: text(row.subject), message: text(row.message, '(empty)'), status: 'read', ...stamps(null) },
      { neverRefresh: true }
    );
  }

  const legacyHomepage = (await read('HomepageMetadata'))[0];
  if (legacyHomepage) {
    stats('homepage').source = 1;
    const already = await Setting.exists({ key: 'homepage' });
    if (already && !refresh) {
      stats('homepage').skipped = 1;
    } else {
      const banner = await moveImage(legacyHomepage.banner_image);
      const mobile = await moveImage(legacyHomepage.mobile_banner_image);
      const link = text(legacyHomepage.banner_url);
      const value = {
        noticeBar: { enabled: !!legacyHomepage.notice_banner_published, text: text(legacyHomepage.notice_banner_text) },
        banners: banner
          ? [
              {
                heading: text(legacyHomepage.banner_text),
                subheading: text(legacyHomepage.banner_sub_text),
                buttonText: text(legacyHomepage.banner_action_button_text),
                buttonLink: /^\/(?!\/)|^https:\/\//.test(link) ? link : '/shop',
                desktopImage: banner,
                ...(mobile && { mobileImage: mobile }),
                enabled: true,
              },
            ]
          : DEFAULT_HOMEPAGE.banners,
        sections: DEFAULT_HOMEPAGE.sections,
      };
      if (apply) await Setting.updateOne({ key: 'homepage' }, { value }, { upsert: true });
      stats('homepage')[already ? 'updated' : 'created'] = 1;
    }
  }

  if (apply) {
    // The old site stored a made-up default of 4.5 stars; these come from real reviews.
    const products = await Product.find().select('_id');
    for (const product of products) await refreshProductRating(product._id);

    const targets: Record<string, AnyModel> = {
      users: User,
      categories: Category,
      products: Product,
      reviews: Review,
      favorites: Favorite,
      coupons: Coupon,
      coupon_redemptions: CouponRedemption,
      delivery_charges: DeliveryCharge,
      addresses: Address,
      orders: Order,
      blogs: Blog,
      testimonials: Testimonial,
      messages: ContactMessage,
    };
    for (const [table, target] of Object.entries(targets)) stats(table).inTarget = await target.countDocuments();
  }

  const unaccounted = Object.entries(tables)
    .filter(([, t]) => t.source !== t.excluded + t.created + t.updated + t.skipped + t.duplicates + t.failed)
    .map(([table]) => table);

  return {
    mode: apply ? (refresh ? 'apply+refresh' : 'apply') : 'dry-run',
    tables,
    images,
    warnings,
    ok: !unaccounted.length && Object.values(tables).every((t) => !t.failed) && !images.missing && !images.invalid,
    unaccounted,
    notMigrated: NOT_MIGRATED,
  };
};
