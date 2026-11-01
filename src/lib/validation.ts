import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id.');
export const idParams = z.object({ id: objectId });
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use only letters, numbers and hyphens.')
  .max(120);

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
};

// Only images we host, or files shipped with the website, may be referenced.
export const imageInput = z.object({
  url: z
    .string()
    .max(500)
    .refine(
      (url) => url.startsWith('https://res.cloudinary.com/') || /^\/(?!\/)[\w./-]+$/.test(url),
      'Image must come from the media library.'
    ),
  publicId: z.string().max(300).optional(),
  alt: z.string().trim().max(200).optional(),
});

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'item';

export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const cleanRichText = (html: string) =>
  sanitizeHtml(html, {
    allowedTags: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'a'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });

export const paged = <T>(items: T[], total: number, page: number, limit: number) => ({
  items,
  total,
  page,
  pages: Math.max(1, Math.ceil(total / limit)),
});
