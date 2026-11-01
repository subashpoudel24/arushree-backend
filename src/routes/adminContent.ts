import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { cleanRichText, idParams, imageInput, paged, pagination, slugSchema, slugify } from '../lib/validation.js';
import { requirePermission } from '../middleware/auth.js';
import { Setting } from '../models/Admin.js';
import { Blog, ContactMessage, Page, Testimonial } from '../models/Content.js';
import { DEFAULT_PAGES, HOMEPAGE_SECTIONS, SYSTEM_PAGES, getHomepage, getSiteSettings, imagesOfHomepage } from '../services/content.js';
import { releaseImages } from '../services/images.js';

const notFound = (label: string) => new ApiError(404, 'not_found', `${label} not found.`);

// Same-site paths, or full https addresses. Never javascript: or similar.
const link = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^\/(?!\/)/.test(value) || /^https:\/\/[^\s]+$/.test(value), 'Links must start with / or https://');
const optionalLink = z.union([link, z.literal('')]).optional();
const socialLink = z
  .string()
  .trim()
  .max(300)
  .refine((value) => value === '' || /^https:\/\/[^\s]+$/.test(value), 'Social links must start with https://')
  .optional();

const homepageBody = z.object({
  noticeBar: z.object({ enabled: z.boolean(), text: z.string().trim().max(200), link: optionalLink }),
  showHighlights: z.boolean().optional(),
  highlights: z
    .array(z.object({ text: z.string().trim().min(1, 'Every highlight needs some text.').max(60), image: imageInput.nullable().optional() }))
    .max(6, 'You can show up to 6 highlights.')
    .optional(),
  banners: z
    .array(
      z.object({
        heading: z.string().trim().max(120),
        subheading: z.string().trim().max(250),
        buttonText: z.string().trim().max(40),
        buttonLink: optionalLink,
        desktopImage: imageInput,
        mobileImage: imageInput.nullable().optional(),
        enabled: z.boolean(),
      })
    )
    .max(8),
  sections: z
    .array(z.object({ key: z.enum(HOMEPAGE_SECTIONS), enabled: z.boolean() }))
    .refine((list) => new Set(list.map((item) => item.key)).size === HOMEPAGE_SECTIONS.length && list.length === HOMEPAGE_SECTIONS.length, 'Every section must appear once.'),
});

const siteBody = z.object({
  siteName: z.string().trim().min(2, 'Please enter the site name.').max(100),
  logo: imageInput,
  phone: z.string().trim().max(50),
  email: z.union([z.email('Please enter a valid email address.').trim().toLowerCase(), z.literal('')]),
  address: z.string().trim().max(300),
  footerText: z.string().trim().max(300),
  social: z.object({ facebook: socialLink, instagram: socialLink, tiktok: socialLink, youtube: socialLink }),
  googleAnalyticsId: z
    .string()
    .trim()
    .refine((value) => value === '' || /^G-[A-Z0-9]{4,20}$/.test(value), 'This does not look like a Google Analytics ID (G-XXXXXXX).')
    .optional(),
});

const blogFields = z.object({
  title: z.string().trim().min(2, 'Please enter a title.').max(200),
  slug: slugSchema.optional(),
  excerpt: z.string().trim().max(500),
  content: z.string().max(200_000),
  image: imageInput.nullable().optional(),
  authorName: z.string().trim().max(100),
  authorImage: imageInput.nullable().optional(),
  status: z.enum(['draft', 'published']),
  seoTitle: z.string().trim().max(120).optional(),
  seoDescription: z.string().trim().max(300).optional(),
});

const pageFields = z.object({
  title: z.string().trim().min(2, 'Please enter a title.').max(150),
  slug: slugSchema.optional(),
  content: z.string().max(200_000),
  published: z.boolean(),
  showInFooter: z.boolean(),
  seoTitle: z.string().trim().max(120).optional(),
  seoDescription: z.string().trim().max(300).optional(),
});

const testimonialFields = z.object({
  authorName: z.string().trim().min(2, 'Please enter a name.').max(100),
  authorImage: imageInput.nullable().optional(),
  rating: z.number().min(1).max(5),
  title: z.string().trim().max(150).default(''),
  text: z.string().trim().min(3, 'Please enter the testimonial.').max(1000),
  active: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(100_000).default(0),
});

const freeSlug = async (model: { exists: (filter: Record<string, unknown>) => unknown }, base: string, excludeId?: string) => {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; ; n += 1) {
    if (!(await model.exists({ slug: candidate, ...(excludeId && { _id: { $ne: excludeId } }) }))) return candidate;
    candidate = `${root}-${n}`;
  }
};

export const adminContentRouter = Router();
adminContentRouter.use(['/homepage', '/site', '/blogs', '/pages', '/testimonials', '/messages'], requirePermission('content'));

adminContentRouter.get('/homepage', async (_req, res) => {
  res.json({ homepage: await getHomepage() });
});

adminContentRouter.put('/homepage', async (req, res) => {
  const value = homepageBody.parse(req.body);
  const previous = await getHomepage();
  await Setting.updateOne({ key: 'homepage' }, { value }, { upsert: true });
  await releaseImages(imagesOfHomepage(previous));
  res.json({ homepage: value });
});

adminContentRouter.get('/site', async (_req, res) => {
  res.json({ site: await getSiteSettings() });
});

adminContentRouter.put('/site', async (req, res) => {
  const value = siteBody.parse(req.body);
  const previous = await getSiteSettings();
  await Setting.updateOne({ key: 'site' }, { value }, { upsert: true });
  await releaseImages([previous.logo?.publicId]);
  res.json({ site: value });
});

adminContentRouter.get('/blogs', async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const [items, total] = await Promise.all([
    Blog.find()
      .select('-content')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Blog.countDocuments(),
  ]);
  res.json(paged(items, total, page, limit));
});

adminContentRouter.get('/blogs/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const blog = await Blog.findById(id);
  if (!blog) throw notFound('Article');
  res.json({ blog });
});

adminContentRouter.post('/blogs', async (req, res) => {
  const body = blogFields.parse(req.body);
  const blog = await Blog.create({
    ...body,
    image: body.image ?? undefined,
    authorImage: body.authorImage ?? undefined,
    content: cleanRichText(body.content),
    slug: await freeSlug(Blog, body.slug ?? body.title),
    publishedAt: body.status === 'published' ? new Date() : undefined,
  });
  res.status(201).json({ blog });
});

adminContentRouter.patch('/blogs/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = blogFields.partial().parse(req.body);
  const blog = await Blog.findById(id);
  if (!blog) throw notFound('Article');
  const previous = [blog.image?.publicId, blog.authorImage?.publicId];
  const { image, authorImage, slug, content, ...rest } = body;
  blog.set(rest);
  if (image !== undefined) blog.image = image ?? undefined;
  if (authorImage !== undefined) blog.authorImage = authorImage ?? undefined;
  if (content !== undefined) blog.content = cleanRichText(content);
  if (slug && slug !== blog.slug) blog.slug = await freeSlug(Blog, slug, id);
  // Keeps the original date when an article is unpublished and republished.
  if (blog.status === 'published' && !blog.publishedAt) blog.publishedAt = new Date();
  await blog.save();
  await releaseImages(previous);
  res.json({ blog });
});

adminContentRouter.delete('/blogs/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const blog = await Blog.findByIdAndDelete(id);
  if (!blog) throw notFound('Article');
  await releaseImages([blog.image?.publicId, blog.authorImage?.publicId]);
  res.status(204).end();
});

adminContentRouter.get('/pages', async (_req, res) => {
  const saved = await Page.find().sort({ title: 1 });
  // About and Contact are listed even before they are first saved.
  const missing = SYSTEM_PAGES.filter((slug) => !saved.some((page) => page.slug === slug)).map((slug) => ({
    slug,
    ...DEFAULT_PAGES[slug],
    published: true,
    showInFooter: false,
    unsaved: true,
  }));
  res.json({ items: [...missing, ...saved.map((page) => page.toObject())], systemPages: SYSTEM_PAGES });
});

adminContentRouter.post('/pages', async (req, res) => {
  const body = pageFields.parse(req.body);
  const slug = SYSTEM_PAGES.includes(body.slug ?? '') ? body.slug! : await freeSlug(Page, body.slug ?? body.title);
  const page = await Page.findOneAndUpdate(
    { slug },
    { ...body, slug, content: cleanRichText(body.content) },
    { upsert: true, returnDocument: 'after', runValidators: true }
  );
  res.status(201).json({ page });
});

adminContentRouter.patch('/pages/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = pageFields.partial().parse(req.body);
  const page = await Page.findById(id);
  if (!page) throw notFound('Page');
  const isSystem = SYSTEM_PAGES.includes(page.slug);
  if (isSystem && body.slug && body.slug !== page.slug) {
    throw new ApiError(409, 'system_page', 'This page has a fixed web address.');
  }
  if (isSystem && body.published === false) {
    throw new ApiError(409, 'system_page', 'This page is linked from the menu and must stay published.');
  }
  const { slug, content, ...rest } = body;
  page.set(rest);
  if (content !== undefined) page.content = cleanRichText(content);
  if (slug && slug !== page.slug) page.slug = await freeSlug(Page, slug, id);
  await page.save();
  res.json({ page });
});

adminContentRouter.delete('/pages/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const page = await Page.findById(id);
  if (!page) throw notFound('Page');
  if (SYSTEM_PAGES.includes(page.slug)) throw new ApiError(409, 'system_page', 'This page is linked from the menu and cannot be deleted.');
  await page.deleteOne();
  res.status(204).end();
});

adminContentRouter.get('/testimonials', async (_req, res) => {
  res.json({ items: await Testimonial.find().sort({ displayOrder: 1, createdAt: -1 }) });
});

adminContentRouter.post('/testimonials', async (req, res) => {
  const body = testimonialFields.parse(req.body);
  res.status(201).json({ testimonial: await Testimonial.create({ ...body, authorImage: body.authorImage ?? undefined }) });
});

adminContentRouter.patch('/testimonials/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = testimonialFields.partial().parse(req.body);
  const testimonial = await Testimonial.findById(id);
  if (!testimonial) throw notFound('Testimonial');
  const previous = testimonial.authorImage?.publicId;
  const { authorImage, ...rest } = body;
  testimonial.set(rest);
  if (authorImage !== undefined) testimonial.authorImage = authorImage ?? undefined;
  await testimonial.save();
  await releaseImages([previous]);
  res.json({ testimonial });
});

adminContentRouter.delete('/testimonials/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const testimonial = await Testimonial.findByIdAndDelete(id);
  if (!testimonial) throw notFound('Testimonial');
  await releaseImages([testimonial.authorImage?.publicId]);
  res.status(204).end();
});

adminContentRouter.get('/messages', async (req, res) => {
  const query = z.object({ ...pagination, status: z.enum(['new', 'read']).optional() }).parse(req.query);
  const filter = query.status ? { status: query.status } : {};
  const [items, total, unread] = await Promise.all([
    ContactMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    ContactMessage.countDocuments(filter),
    ContactMessage.countDocuments({ status: 'new' }),
  ]);
  res.json({ ...paged(items, total, query.page, query.limit), unread });
});

adminContentRouter.patch('/messages/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { status } = z.object({ status: z.enum(['new', 'read']) }).parse(req.body);
  const message = await ContactMessage.findByIdAndUpdate(id, { status }, { returnDocument: 'after' });
  if (!message) throw notFound('Message');
  res.json({ message });
});

adminContentRouter.delete('/messages/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  await ContactMessage.deleteOne({ _id: id });
  res.status(204).end();
});
