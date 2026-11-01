// Local development without Atlas: runs the API on a throwaway in-memory MongoDB.
// All data is lost when this process stops. Never used in production builds.
import { randomBytes } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); // Checkout needs transactions.
process.env.MONGODB_URI = mongo.getUri('aarushree');
process.env.LOG_LEVEL ??= 'warn'; // Keeps the test password below easy to find.
process.env.PORT = '4000'; // The frontend owns 3000, even if PORT is inherited from the shell.
// eSewa's published test merchant, used only by this local mode. Never your live key.
process.env.ESEWA_PRODUCT_CODE ??= 'EPAYTEST';
process.env.ESEWA_SECRET_KEY ??= '8gBm/:&EnhH.1/q';
process.env.JWT_ACCESS_SECRET ??= randomBytes(48).toString('hex');
process.env.CSRF_SECRET ??= randomBytes(48).toString('hex');

const { default: bcrypt } = await import('bcryptjs');
const { connectDatabase } = await import('./lib/db.js');
const { createApp } = await import('./app.js');
const { env } = await import('./config/env.js');
const { User } = await import('./models/User.js');

await connectDatabase(env.MONGODB_URI);

// Generated per run and printed locally, so no password lives in the repository.
const password = randomBytes(9).toString('base64url');
const passwordHash = await bcrypt.hash(password, 10);
await User.create([
  { name: 'Local Admin', email: 'admin@aarushree.test', passwordHash, role: 'super_admin', emailVerified: true },
  { name: 'Local Customer', email: 'customer@aarushree.test', passwordHash, emailVerified: true },
]);

// Sample catalog for trying the shop locally. Real products arrive with the migration.
const { Category } = await import('./models/Category.js');
const { Product } = await import('./models/Product.js');
const [skin, oral] = await Category.create([
  { name: 'Skin Care', slug: 'skin-care', section: 'skincare', displayOrder: 1, image: { url: '/assets/images/Product-table.jpeg' } },
  { name: 'Oral Care', slug: 'oral-care', section: 'oral-care', displayOrder: 2, image: { url: '/assets/images/Kleida-Coconut-Extra-Virgin-Oil.jpg' } },
]);
const sample = (name: string, category: typeof skin, price: number, compareAtPrice: number, stock: number, featured: boolean, image: string) => ({
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  shortDescription: `${name}: sample product for local testing.`,
  description: `<p>${name} is sample content for local testing.</p>`,
  price,
  compareAtPrice,
  stock,
  featured,
  status: 'published' as 'published' | 'draft',
  categories: [category._id],
  images: [{ url: `/assets/images/${image}`, alt: name }],
  specifications: [{ title: 'Size', description: '100 ml' }],
});
await Product.create([
  sample('Sample Coconut Oil', skin, 1200, 1500, 25, true, 'Kleida-Coconut-Extra-Virgin-Oil.jpg'),
  sample('Sample Face Serum', skin, 1800, 2200, 12, true, 'Product-table.jpeg'),
  sample('Sample Day Cream', skin, 950, 1100, 30, false, 'Product-table.jpeg'),
  sample('Sample Body Lotion', skin, 750, 900, 0, false, 'Product-table.jpeg'),
  sample('Sample Toothpaste', oral, 350, 420, 60, true, 'Kleida-Coconut-Extra-Virgin-Oil.jpg'),
  sample('Sample Mouthwash', oral, 480, 600, 18, false, 'Product-table.jpeg'),
  { ...sample('Sample Hidden Draft', skin, 100, 100, 5, false, 'Product-table.jpeg'), status: 'draft' },
]);

const { Blog, Page, Testimonial } = await import('./models/Content.js');
await Blog.create({
  title: 'Sample Article',
  slug: 'sample-article',
  excerpt: 'Sample article for local testing.',
  content: '<p>Sample article content for local testing.</p>',
  authorName: 'Sample Author',
  status: 'published',
  publishedAt: new Date(),
  image: { url: '/assets/images/Product-table.jpeg' },
});
await Testimonial.create({ authorName: 'Sample Customer', rating: 5, title: 'Sample', text: 'Sample testimonial for local testing.' });
await Page.create({ title: 'Sample Policy', slug: 'sample-policy', content: '<p>Sample policy for local testing.</p>', showInFooter: true });

const { Coupon, DeliveryCharge } = await import('./models/Commerce.js');
await DeliveryCharge.create([
  { province: 'bagmati', district: 'kathmandu', city: 'kathmandu', charge: 100 },
  { province: 'bagmati', district: 'lalitpur', city: 'lalitpur', charge: 120 },
  { province: 'gandaki', district: 'kaski', city: 'pokhara', charge: 200 },
]);
await Coupon.create({
  code: 'SAMPLE10',
  description: 'Sample coupon: 10% off, up to Rs. 500',
  discountPercent: 10,
  maxDiscount: 500,
  validFrom: new Date(Date.now() - 86_400_000),
  validTill: new Date(Date.now() + 90 * 86_400_000),
  usageLimit: 100,
});

createApp().listen(env.PORT, (err?: Error) => {
  if (err) throw err;
  console.log(`\nIn-memory API on port ${env.PORT}. Data is erased when it stops.`);
  console.log('Accounts: admin@aarushree.test, customer@aarushree.test');
  console.log(`Password for both this run: ${password}\n`);
});
