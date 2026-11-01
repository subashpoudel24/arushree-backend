import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.string().default('info'),
    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    FRONTEND_URL: z.url().default('http://localhost:3000'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    ESEWA_SECRET_KEY: optional,
    ESEWA_PRODUCT_CODE: optional,
    ESEWA_FORM_URL: z.url().default('https://rc-epay.esewa.com.np/api/epay/main/v2/form'),
    ESEWA_STATUS_URL: z.url().default('https://rc.esewa.com.np/api/epay/transaction/status/'),
    GOOGLE_CLIENT_ID: optional,
    CLOUDINARY_CLOUD_NAME: optional,
    CLOUDINARY_API_KEY: optional,
    CLOUDINARY_API_SECRET: optional,
    SMTP_HOST: optional,
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: optional,
    SMTP_PASS: optional,
    MAIL_FROM: z.string().default('Aarushree Life Sciences <no-reply@aarushreelifesciences.com>'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    if (!value.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'is required in production so password reset emails can be sent',
      });
    }
    // Secure cookies and eSewa's return address both depend on this.
    if (!/^https:\/\/|^http:\/\/localhost(:|$)/.test(value.FRONTEND_URL)) {
      ctx.addIssue({ code: 'custom', path: ['FRONTEND_URL'], message: 'must start with https:// in production' });
    }
    // A live shop on eSewa's test system would confirm orders for money never received.
    if (value.ESEWA_SECRET_KEY) {
      const testSystem = /rc-epay\.esewa|rc\.esewa/;
      if (testSystem.test(value.ESEWA_FORM_URL) || testSystem.test(value.ESEWA_STATUS_URL) || value.ESEWA_PRODUCT_CODE === 'EPAYTEST') {
        ctx.addIssue({
          code: 'custom',
          path: ['ESEWA_FORM_URL'],
          message: 'eSewa is still set to its test system. Use the live addresses and merchant code, or remove ESEWA_SECRET_KEY',
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
