import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { contactNotificationEmail, mailer } from '../lib/mailer.js';
import { paged, pagination, slugSchema } from '../lib/validation.js';
import { limiters } from '../middleware/security.js';
import { Blog, ContactMessage, Page, Testimonial } from '../models/Content.js';
import { DEFAULT_PAGES, getHomepage, getSiteSettings } from '../services/content.js';

const slugParams = z.object({ slug: slugSchema });

const contactBody = z.object({
  name: z.string().trim().min(2, 'Please enter your name.').max(100),
  email: z.email('Please enter a valid email address.').trim().toLowerCase(),
  subject: z.string().trim().max(200).default(''),
  message: z.string().trim().min(5, 'Please write a short message.').max(5000),
  website: z.string().max(200).optional(), // Hidden trap field that only bots fill in.
});

export const contentRouter = Router();

contentRouter.get('/content/site', async (_req, res) => {
  const [site, footerPages] = await Promise.all([
    getSiteSettings(),
    Page.find({ published: true, showInFooter: true }).select('title slug -_id').sort({ title: 1 }),
  ]);
  res.json({ site, footerPages });
});

contentRouter.get('/content/homepage', async (_req, res) => {
  const homepage = await getHomepage();
  res.json({ homepage: { ...homepage, banners: homepage.banners.filter((banner) => banner.enabled) } });
});

contentRouter.get('/content/pages', async (_req, res) => {
  res.json({ items: await Page.find({ published: true }).select('slug updatedAt -_id') });
});

contentRouter.get('/content/pages/:slug', async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  const page = await Page.findOne({ slug });
  if (page) {
    if (!page.published) throw new ApiError(404, 'not_found', 'This page does not exist.');
    res.json({ page });
    return;
  }
  const fallback = DEFAULT_PAGES[slug];
  if (!fallback) throw new ApiError(404, 'not_found', 'This page does not exist.');
  res.json({ page: { slug, ...fallback } });
});

contentRouter.get('/testimonials', async (_req, res) => {
  res.json({ items: await Testimonial.find({ active: true }).sort({ displayOrder: 1, createdAt: -1 }).limit(30) });
});

contentRouter.get('/blogs', async (req, res) => {
  const { page, limit } = z.object(pagination).parse(req.query);
  const filter = { status: 'published' as const };
  const [items, total] = await Promise.all([
    Blog.find(filter)
      .select('-content')
      .sort({ publishedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Blog.countDocuments(filter),
  ]);
  res.json(paged(items, total, page, limit));
});

contentRouter.get('/blogs/:slug', async (req, res) => {
  const { slug } = slugParams.parse(req.params);
  const blog = await Blog.findOne({ slug, status: 'published' });
  if (!blog) throw new ApiError(404, 'not_found', 'This article does not exist.');
  res.json({ blog });
});

contentRouter.post('/contact', limiters.contact, async (req, res) => {
  const { website, ...body } = contactBody.parse(req.body);
  const thanks = { message: 'Thank you. We will get back to you soon.' };
  // Look successful to bots, so they do not try again.
  if (website) {
    res.status(201).json(thanks);
    return;
  }
  await ContactMessage.create(body);
  const { email } = await getSiteSettings();
  if (email) {
    void mailer
      .send(contactNotificationEmail(email, body))
      .catch((err) => logger.error({ err }, 'Could not send contact notification'));
  }
  res.status(201).json(thanks);
});
